import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import type { Env } from "../core/types"
import type { MealCell, MealPlanCandidate } from "../meal-planning/types"
import type { MealPlanningWorkflowParams } from "../meal-planning/workflow"

vitest.mock("../providers", () => ({ createToolProvider: () => ({ generate: mockGenerate }) }))

const mockGenerate = vitest.hoisted(() => vitest.fn())

const LLM_QUEUE: Array<{ label: string; response: unknown }> = []

function queueResponse(label: string, response: unknown): void {
  LLM_QUEUE.push({ label, response })
}

function queueInitialPlan(base: MealPlanCandidate): void {
  queueResponse("evaluate", { toolCalls: [{ id: "evaluate", name: "evaluate_meal_plan", input: base }], usage: {} })
  queueResponse("propose", {
    toolCalls: [{ id: "propose", name: "propose_plan", input: proposeInput(base) }],
    usage: {},
  })
}

function queueRevision(
  revised: MealPlanCandidate,
  feedback: { id: string; text: string; scope?: { day: string; slot: string } },
): void {
  queueResponse("evaluate-rev", {
    toolCalls: [{ id: "evaluate-rev", name: "evaluate_meal_plan", input: revised }],
    usage: {},
  })
  queueResponse("propose-rev", {
    toolCalls: [{ id: "propose-rev", name: "propose_plan", input: proposeInput(revised, [feedback]) }],
    usage: {},
  })
}

import { createD1TestDb, d1Count } from "../__tests__/d1-test-db"
import { type MealPlanningLiveEvent, runAgentCenteredMealPlanningWorkflow } from "../meal-planning/agent-workflow"
import { createMealPlanningStore } from "../meal-planning/store"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { createFakeInteractionRouter, createFakeNetwork } from "./setup"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SLOT_COOK: Record<string, number> = {
  breakfast: 15,
  snack1: 0,
  snack2: 0,
  "school-lunch": 20,
  "home-lunch": 20,
}
const POLICY_IDS = [
  "snack-policy",
  "equipment-gap",
  "packing-capacity",
  "nutrition-target-fruit",
  "nutrition-target-nuts",
]

function cell(dish: string, items: string[], slot: string): MealCell {
  return { dish, vegetarian: true, items, cookMinutes: SLOT_COOK[slot], priorNightPrep: false }
}

function seedCandidate(override?: { day: string; slot: string; cell: MealCell }): MealPlanCandidate {
  const grid: Record<string, Record<string, MealCell>> = {}
  for (const day of DAYS) {
    grid[day] = {}
    for (const slot of Object.keys(SLOT_COOK)) {
      grid[day][slot] = cell(
        "paratha",
        slot === "school-lunch" || slot === "home-lunch" ? ["rice"] : ["wheat flour"],
        slot,
      )
    }
  }
  if (override) grid[override.day][override.slot] = override.cell
  return {
    grid,
    easyBuys: [],
    policyOutcomes: Object.fromEntries(POLICY_IDS.map((id) => [id, { outcome: "satisfied", rationale: "ok" }])),
  }
}

function proposeInput(
  candidate: MealPlanCandidate,
  feedbackItems?: Array<{ id: string; text: string; scope?: { day: string; slot: string } }>,
) {
  return {
    candidate,
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [] },
    ...(feedbackItems ? { feedbackItems } : {}),
  }
}

function queueClarification(message = "How many people should the week serve?"): void {
  queueResponse("clarify", {
    toolCalls: [
      {
        id: "clarify",
        name: "needs_clarification",
        input: { message, reasonCodes: ["slot_unsuitable"], interaction: { kind: "reply" } },
      },
    ],
    usage: {},
  })
}

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function message(text: string, messageId = 1, replyTo?: number, entities?: unknown[]): Request {
  return request({
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 42, is_bot: false },
      chat: { id: 100, type: "private" },
      text,
      ...(entities ? { entities } : {}),
      ...(replyTo ? { reply_to_message: { message_id: replyTo, from: { id: 7, is_bot: true } } } : {}),
    },
  })
}

function callback(token: string, updateId = 10): Request {
  return request({
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: 42 },
      message: { message_id: 101, chat: { id: 100 } },
      data: token,
    },
  })
}

function liveStep() {
  const queue: Array<MealPlanningLiveEvent | { type: "timeout" }> = []
  let waiter: ((value: { type: string; payload?: MealPlanningLiveEvent }) => void) | undefined
  return {
    do: vitest.fn(async (_name: string, fn: () => unknown) => fn()),
    waitForEvent: vitest.fn(async () => {
      const next = queue.shift()
      if (next && "payload" in next) return { type: "event", payload: next.payload }
      if (next) return { type: "timeout" }
      return new Promise((resolve) => {
        waiter = resolve
      })
    }),
    sleep: vitest.fn(),
    sleepUntil: vitest.fn(),
    deliver: (payload: MealPlanningLiveEvent) => {
      if (waiter) {
        const resolve = waiter
        waiter = undefined
        resolve({ type: "event", payload })
      } else queue.push(payload)
    },
    timeout: () => {
      // Advance past any plan's week end so the live loop's `week_end` check ends on its next cycle.
      vitest.setSystemTime(Date.now() + 8 * 86_400_000)
      if (waiter) {
        const resolve = waiter
        waiter = undefined
        resolve({ type: "timeout" })
      } else queue.push({ type: "timeout" })
    },
    isWaiting: () => Boolean(waiter),
  }
}

function mealWorkflowBinding() {
  const created: Array<{ id: string; params: unknown }> = []
  const steps = new Map<string, ReturnType<typeof liveStep>>()
  let counter = 0
  return {
    create: vitest.fn(async (params: unknown) => {
      const id = `meal-wf-${++counter}`
      created.push({ id, params })
      return { id }
    }),
    get: vitest.fn((instanceId: string) => ({
      sendEvent: vitest.fn(async (event: unknown) => {
        const step = steps.get(instanceId)
        const payload = (event as { payload: MealPlanningLiveEvent }).payload
        if (!step) throw new Error(`no live step for ${instanceId}`)
        step.deliver(payload)
      }),
    })),
    attach: (id: string, step: ReturnType<typeof liveStep>) => steps.set(id, step),
    created,
  }
}

function runtimeEnv(overrides: Partial<Env>): {
  env: Env
  db: ReturnType<typeof createD1TestDb>["db"]
  network: ReturnType<typeof createFakeNetwork>
} {
  const network = createFakeNetwork()
  vitest.stubGlobal("fetch", network.fetch)
  const { db, d1 } = createD1TestDb()
  const router = createFakeInteractionRouter()
  const env = {
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "my-secret",
    TELEGRAM_ALLOWED_USER_ID: "42",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    LLM_MODEL: "deepseek-chat",
    LLM_MAX_RETRIES: "0",
    TIMEZONE: "Asia/Kolkata",
    INTERACTION_ROUTER: router.namespace,
    MEAL_PLANNING_DB: d1,
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as Env
  return { env, db, network }
}

function startedWorkflowRun(
  wf: ReturnType<typeof mealWorkflowBinding>,
  env: Env,
): { params: MealPlanningWorkflowParams; step: ReturnType<typeof liveStep>; run: Promise<void> } {
  const created = wf.created[wf.created.length - 1]
  if (!created) throw new Error("meal workflow was not created")
  const params = (created.params as { params: MealPlanningWorkflowParams }).params
  const step = liveStep()
  wf.attach(created.id, step)
  const run = runAgentCenteredMealPlanningWorkflow(
    env,
    {
      instanceId: created.id,
      payload: params,
      timestamp: new Date().toISOString(),
      workflowName: "meal-planning",
    } as never,
    step as never,
  )
  return { params, step, run }
}

async function waitForMessageText(
  network: ReturnType<typeof createFakeNetwork>,
  text: string,
  afterIndex = -1,
): Promise<number> {
  try {
    await vitest.waitFor(() => {
      const messages = network.getState().telegramMessages
      const matched = messages.some((candidate, index) => index > afterIndex && candidate.text?.includes(text))
      return expect(matched).toBe(true)
    })
  } catch {
    throw new Error(
      `Expected a Telegram message containing "${text}". Observed: ${network
        .getState()
        .telegramMessages.map((candidate) => candidate.text)
        .join(" | ")}`,
    )
  }
  return network
    .getState()
    .telegramMessages.findIndex((candidate, index) => index > afterIndex && candidate.text?.includes(text))
}

function callbackToken(network: ReturnType<typeof createFakeNetwork>, messageIndex: number): string {
  const markup = network.getState().telegramMessages[messageIndex]?.replyMarkup
  const keyboard = markup?.inline_keyboard as Array<Array<{ callback_data: string }>>
  return keyboard[0]?.[0]?.callback_data as string
}

describe("agent-centered meal-planning Telegram integration", () => {
  beforeEach(() => {
    vitest.useFakeTimers()
    vitest.setSystemTime(new Date("2026-09-09T03:30:00.000Z")) // Wednesday → current week
    LLM_QUEUE.length = 0
    mockGenerate.mockReset()
    mockGenerate.mockImplementation(async () => LLM_QUEUE.shift()?.response)
  })
  afterEach(() => {
    vitest.useRealTimers()
    vitest.unstubAllGlobals()
  })

  it("takes /mealplan through plan v1, the feedback button, a force-reply prompt, and a v2 revision", async () => {
    const base = seedCandidate()
    const revised = seedCandidate({ day: "Mon", slot: "snack1", cell: cell("idli", ["rice"], "snack1") })
    const { env, db, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueInitialPlan(base)

    await handleTelegramWebhook(message("/mealplan this week"), env)
    expect(network.getState().telegramMessages.some((candidate) => candidate.text === "Planning that now.")).toBe(true)
    const { step, run } = startedWorkflowRun(wf, env)
    const planIndex = await waitForMessageText(network, "School week of")

    const token = callbackToken(network, planIndex)
    await handleTelegramWebhook(callback(token, 20), env)
    const promptIndex = await waitForMessageText(network, "Reply with your feedback", planIndex)
    const promptId = network.getState().telegramMessages[promptIndex].messageId

    queueRevision(revised, {
      id: "tg-30",
      text: "Mon snack: prefer idli",
      scope: { day: "Mon", slot: "snack1" },
    })
    await handleTelegramWebhook(message("Mon snack: prefer idli", 30, promptId), env)
    await waitForMessageText(network, "School week of", planIndex)

    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    const active = await store.activePlan("100")
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.requestKind).toBe("revision")
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
    expect(
      network.getState().telegramMessages.filter((candidate) => candidate.text.includes("School week of")).length,
    ).toBe(2)

    step.timeout()
    await run
  })

  it("routes unaddressed plain text to the live plan instance as a feedback submission", async () => {
    const base = seedCandidate()
    const revised = seedCandidate({ day: "Tue", slot: "snack1", cell: cell("poha", ["rice"], "snack1") })
    const { env, db, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueInitialPlan(base)

    await handleTelegramWebhook(message("/mealplan this week"), env)
    const { step, run } = startedWorkflowRun(wf, env)
    const planIndex = await waitForMessageText(network, "School week of")

    queueRevision(revised, {
      id: "tg-40",
      text: "Tue snack: prefer poha",
      scope: { day: "Tue", slot: "snack1" },
    })
    await handleTelegramWebhook(message("Tue snack: prefer poha", 40), env)
    await waitForMessageText(network, "School week of", planIndex)

    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    const active = await store.activePlan("100")
    expect(active?.plan.currentVersion).toBe(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)

    step.timeout()
    await run
  })

  it("resolves a retried callback exactly once (router single-claim)", async () => {
    const base = seedCandidate()
    const { env, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueInitialPlan(base)

    await handleTelegramWebhook(message("/mealplan this week"), env)
    const { step, run } = startedWorkflowRun(wf, env)
    const planIndex = await waitForMessageText(network, "School week of")
    const token = callbackToken(network, planIndex)

    await handleTelegramWebhook(callback(token, 20), env)
    const promptIndex = await waitForMessageText(network, "Reply with your feedback", planIndex)
    // The same Telegram callback update is retried: the router consumed it, so no second prompt.
    await handleTelegramWebhook(callback(token, 20), env)
    expect(
      network.getState().telegramMessages.filter((candidate) => candidate.text.includes("Reply with your feedback"))
        .length,
    ).toBe(1)
    expect(network.getState().answeredCallbacks).toContain("cq-20")

    step.timeout()
    await run
    void promptIndex
  })

  it("mid-week /mealplan supersedes the plan and generation-invalidates the old buttons", async () => {
    const base = seedCandidate()
    const { env, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueInitialPlan(base)

    await handleTelegramWebhook(message("/mealplan this week", 1), env)
    const first = startedWorkflowRun(wf, env)
    const firstPlanIndex = await waitForMessageText(network, "School week of")
    const oldToken = callbackToken(network, firstPlanIndex)

    queueInitialPlan(base)
    await handleTelegramWebhook(message("/mealplan this week", 2), env)
    const second = startedWorkflowRun(wf, env)
    const secondPlanIndex = await waitForMessageText(network, "School week of", firstPlanIndex)
    const newToken = callbackToken(network, secondPlanIndex)

    // The superseded plan's button resolves nothing (generation invalidation): no event, no prompt.
    await handleTelegramWebhook(callback(oldToken, 30), env)
    expect(
      network.getState().telegramMessages.some((candidate) => candidate.text.includes("Reply with your feedback")),
    ).toBe(false)

    // The new plan's button works.
    await handleTelegramWebhook(callback(newToken, 31), env)
    await waitForMessageText(network, "Reply with your feedback", secondPlanIndex)

    first.step.timeout()
    await first.run
    second.step.timeout()
    await second.run
  })

  it("does not let a superseded initial-planning clarification create and replace the newer plan", async () => {
    const base = seedCandidate()
    const { env, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never

    // First /mealplan needs clarification; leave it unanswered.
    queueClarification()
    await handleTelegramWebhook(message("/mealplan this week", 1), env)
    const first = startedWorkflowRun(wf, env)
    const clarifyIndex = await waitForMessageText(network, "How many people should the week serve?")
    const clarifyPromptId = network.getState().telegramMessages[clarifyIndex].messageId
    await vitest.waitFor(() => expect(first.step.isWaiting()).toBe(true))

    // A second /mealplan persists while the first still waits on its clarification.
    queueInitialPlan(base)
    await handleTelegramWebhook(message("/mealplan this week", 2), env)
    const second = startedWorkflowRun(wf, env)
    await waitForMessageText(network, "School week of")

    // The user answers the FIRST prompt. Persisting the second plan tagged the clarification
    // with a generation the second plan superseded, so the reply resolves nothing: the stale
    // planning session never revives, so it can never persist over the newer plan.
    await handleTelegramWebhook(message("7 people", 60, clarifyPromptId), env)

    // The stale instance's clarification prompt times out and it cancels without persisting.
    first.step.timeout()
    await first.run
    expect(
      network.getState().telegramMessages.some((candidate) => candidate.text.includes("run /mealplan to try again")),
    ).toBe(true)

    // The second instance's plan is still the active one, and no third plan was created.
    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    const active = await store.activePlan("100")
    expect(active?.plan.instanceId).toBe("meal-wf-2")
    expect(active?.plan.currentVersion).toBe(1)
    expect(
      network.getState().telegramMessages.filter((candidate) => candidate.text.includes("School week of")).length,
    ).toBe(1)

    second.step.timeout()
    await second.run
  })

  it("ends the initial planning with a canceled notice when a clarification is never answered", async () => {
    const { env, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueClarification()

    await handleTelegramWebhook(message("/mealplan this week"), env)
    const { step, run } = startedWorkflowRun(wf, env)
    await waitForMessageText(network, "How many people should the week serve?")
    await vitest.waitFor(() => expect(step.isWaiting()).toBe(true))
    step.timeout()
    await run

    expect(
      network.getState().telegramMessages.some((candidate) => candidate.text.includes("run /mealplan to try again")),
    ).toBe(true)
    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    expect(await store.activePlan("100")).toBeNull()
  })

  it("tells the parent the plan has ended when plain text falls through after week end", async () => {
    const base = seedCandidate()
    const { env, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueInitialPlan(base)

    await handleTelegramWebhook(message("/mealplan this week"), env)
    const { step, run } = startedWorkflowRun(wf, env)
    const planIndex = await waitForMessageText(network, "School week of")
    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    const active = await store.activePlan("100")
    const weekEnd = active?.plan.weekEnd
    if (!weekEnd) throw new Error("expected an active plan with a week_end")
    vitest.setSystemTime(new Date(Date.parse(weekEnd) + 60_000))

    await handleTelegramWebhook(message("Wed lunch: too oily", 50), env)
    expect(network.getState().telegramMessages.some((candidate) => candidate.text.includes("has ended"))).toBe(true)
    expect(
      network.getState().telegramMessages.filter((candidate) => candidate.text.includes("School week of")).length,
    ).toBe(1)

    step.timeout()
    await run
    void planIndex
  })
})
