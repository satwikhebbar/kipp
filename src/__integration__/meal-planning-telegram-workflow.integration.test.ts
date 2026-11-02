import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import { workflowTimeoutError } from "../__tests__/fixtures/workflow-timeout"
import { mealPlanSelectionCandidateToWire, mealPlanSelectionPatchToWire } from "../agent/meal-planning"
import type { Env } from "../core/types"
import { startFeedbackBatch } from "../meal-planning/mini-app-routes"
import type { MealCell, MealPlanCandidate, MealPlanSelectionCandidate } from "../meal-planning/types"
import type { MealPlanningWorkflowParams } from "../meal-planning/workflow"

vitest.mock("../providers", () => ({ createToolProvider: () => ({ generate: mockGenerate }) }))

const mockGenerate = vitest.hoisted(() => vitest.fn())

const LLM_QUEUE: Array<{ label: string; response: unknown }> = []
const LLM_USAGE = { inputTokens: 1000, outputTokens: 500 }

function queueResponse(label: string, response: unknown): void {
  LLM_QUEUE.push({ label, response })
}

function queueInitialPlan(base: MealPlanCandidate): void {
  queueWeekContextExtraction()
  queueResponse("evaluate", {
    toolCalls: [
      { id: "evaluate", name: "evaluate_meal_plan", input: mealPlanSelectionCandidateToWire(selectionCandidate(base)) },
    ],
    usage: LLM_USAGE,
  })
  queueResponse("propose", {
    toolCalls: [{ id: "propose", name: "propose_plan", input: proposeInput(base) }],
    usage: LLM_USAGE,
  })
}

function queueWeekContextExtraction(): void {
  queueResponse("extract-week-context", {
    toolCalls: [
      { id: "extract-week-context", name: "extract_week_context", input: { inventoryChanges: [], exceptionAdds: [] } },
    ],
    usage: LLM_USAGE,
  })
}

function queueRevision(
  revised: MealPlanCandidate,
  feedback: { id: string; text: string; scope?: { day: string; slot: string } },
  echoFeedback = true,
): void {
  const candidate = revisionCandidate(revised, feedback)
  queueResponse("evaluate-rev", {
    toolCalls: [
      {
        id: "evaluate-rev",
        name: "evaluate_meal_plan",
        input: mealPlanSelectionPatchToWire(candidate),
      },
    ],
    usage: LLM_USAGE,
  })
  queueResponse("propose-rev", {
    toolCalls: [
      {
        id: "propose-rev",
        name: "propose_plan",
        input: {
          candidate: mealPlanSelectionPatchToWire(candidate),
          ...(echoFeedback ? { feedbackItems: [{ id: feedback.id, text: feedback.text }] } : {}),
        },
      },
    ],
    usage: LLM_USAGE,
  })
}

import { createD1TestDb, d1Count } from "../__tests__/d1-test-db"
import {
  type MealPlanningLiveEvent,
  runAgentCenteredMealPlanningWorkflow,
  runMealPlanningEditWorkflow,
} from "../meal-planning/agent-workflow"
import { createMealPlanningStore, SEED_MEAL_IDS, SEED_PROFILE } from "../meal-planning/store"
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
  "ingredient-naming",
  "relevant-variety",
  "nutrition-target-fruit",
  "nutrition-target-nuts",
  "school-rule",
  "cheat-day",
]

// These workflow fixtures deliberately keep one compact hydrated-cell grid.
// Every catalog definition is made slot-compatible and pantry-backed so the
// workflow tests exercise routing and persistence rather than meal suitability.
SEED_PROFILE.mealDefinitions = (SEED_PROFILE.mealDefinitions ?? []).map((definition) => ({
  ...definition,
  suitableSlots: ["breakfast", "snack1", "snack2", "school-lunch", "home-lunch"],
  packedFood: { suitable: true, dry: true },
  typicalCookMinutes: 0,
  priorNightPrep: "none",
  requiredIngredients: ["rice"],
}))

const FIXTURE_DISHES = Object.keys(SEED_MEAL_IDS).slice(0, DAYS.length * Object.keys(SLOT_COOK).length)
SEED_PROFILE.foodPreferences = { ...SEED_PROFILE.foodPreferences, favourites: FIXTURE_DISHES }

function cell(dish: string, items: string[], slot: string): MealCell {
  return { dish, vegetarian: true, items, cookMinutes: SLOT_COOK[slot], priorNightPrep: false }
}

function seedCandidate(override?: { day: string; slot: string; cell: MealCell }): MealPlanCandidate {
  const grid: Record<string, Record<string, MealCell>> = {}
  let dishIndex = 0
  for (const day of DAYS) {
    grid[day] = {}
    for (const slot of Object.keys(SLOT_COOK)) {
      if (day === "Sat" && (slot === "snack2" || slot === "school-lunch")) continue
      grid[day][slot] = cell(FIXTURE_DISHES[dishIndex++], ["rice"], slot)
    }
  }
  if (override) grid[override.day][override.slot] = override.cell
  return {
    grid,
    easyBuys: [],
    policyOutcomes: Object.fromEntries(POLICY_IDS.map((id) => [id, { outcome: "satisfied", rationale: "ok" }])),
  }
}

function selectionCandidate(candidate: MealPlanCandidate): MealPlanSelectionCandidate {
  return {
    ...candidate,
    grid: Object.fromEntries(
      Object.entries(candidate.grid).map(([day, slots]) => [
        day,
        Object.fromEntries(
          Object.entries(slots).map(([slot, cell]) => {
            const mealDefinitionId = SEED_MEAL_IDS[cell.dish]
            if (!mealDefinitionId) throw new Error(`missing integration fixture definition for ${cell.dish}`)
            return [slot, { mealDefinitionId }]
          }),
        ),
      ]),
    ),
  }
}

function revisionCandidate(
  candidate: MealPlanCandidate,
  feedback: { scope?: { day: string; slot: string } },
): Pick<MealPlanSelectionCandidate, "grid"> {
  if (!feedback.scope) throw new Error("revision fixture requires cell-scoped feedback")
  const { day, slot } = feedback.scope
  return { grid: { [day]: { [slot]: selectionCandidate(candidate).grid[day][slot] } } }
}

function proposeInput(
  candidate: MealPlanCandidate,
  feedbackItems?: Array<{ id: string; text: string; scope?: { day: string; slot: string } }>,
) {
  return {
    candidate: mealPlanSelectionCandidateToWire(selectionCandidate(candidate)),
    ...(feedbackItems ? { feedbackItems } : {}),
  }
}

function queueClarification(message = "How many people should the week serve?"): void {
  queueWeekContextExtraction()
  queueResponse("clarify", {
    toolCalls: [
      {
        id: "clarify",
        name: "needs_clarification",
        input: { message, reasonCodes: ["slot_unsuitable"], interaction: { kind: "reply" } },
      },
    ],
    usage: LLM_USAGE,
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
  let rejectWait: ((reason: Error) => void) | undefined
  let waiter: ((value: { type: string; payload?: MealPlanningLiveEvent }) => void) | undefined
  return {
    do: vitest.fn(async (_name: string, fn: () => unknown) => fn()),
    waitForEvent: vitest.fn(async () => {
      const next = queue.shift()
      if (next && "payload" in next) return { type: "event", payload: next.payload }
      if (next) throw workflowTimeoutError()
      return new Promise((resolve, reject) => {
        rejectWait = reject
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
        waiter = undefined
        rejectWait?.(workflowTimeoutError())
      } else queue.push({ type: "timeout" })
    },
    isWaiting: () => Boolean(waiter),
  }
}

/** A step that memoizes `do` by name like the Workflows runtime, so a replayed instance resumes completed steps. */
function memoStep() {
  const cache = new Map<string, unknown>()
  let ended = false
  return {
    do: vitest.fn(async (name: string, fn: () => unknown) => {
      if (cache.has(name)) return cache.get(name)
      const result = await fn()
      cache.set(name, result)
      return result
    }),
    waitForEvent: vitest.fn(async () => {
      if (ended) throw workflowTimeoutError()
      ended = true
      vitest.setSystemTime(Date.now() + 8 * 86_400_000)
      throw workflowTimeoutError()
    }),
    sleep: vitest.fn(),
    sleepUntil: vitest.fn(),
  }
}

function mealWorkflowBinding() {
  const created: Array<{ id: string; params: unknown }> = []
  const steps = new Map<string, ReturnType<typeof liveStep>>()
  const runs = new Map<string, Promise<void>>()
  let connected: Env | undefined
  let counter = 0
  return {
    connect: (env: Env) => {
      connected = env
    },
    create: vitest.fn(async (input: { id?: string; params: MealPlanningWorkflowParams }) => {
      const id = input.id ?? `meal-wf-${++counter}`
      if (created.some((run) => run.id === id)) throw new Error("Workflow already exists")
      created.push({ id, params: input })
      if (input.params.edit && connected) {
        const step = liveStep()
        steps.set(id, step)
        runs.set(
          id,
          runMealPlanningEditWorkflow(connected, { instanceId: id, payload: input.params } as never, step as never),
        )
      }
      return { id }
    }),
    get: vitest.fn((instanceId: string) => ({
      status: async () => ({ status: created.some((run) => run.id === instanceId) ? "running" : "unknown" }),
      sendEvent: vitest.fn(async (event: unknown) => {
        const step = steps.get(instanceId)
        if (!step) throw new Error(`no live step for ${instanceId}`)
        step.deliver((event as { payload: MealPlanningLiveEvent }).payload)
      }),
    })),
    attach: (id: string, step: ReturnType<typeof liveStep>) => steps.set(id, step),
    settled: async () => Promise.all([...runs.values()]),
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
    LLM_MODEL: "deepseek-flash",
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
  wf.connect(env)
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

    // The planning model must see the household context: profile, schedule,
    // policies, and week state are injected into its first turn's messages.
    const firstGenerateMessages = mockGenerate.mock.calls[1][0].messages.map(
      (message: { role: string; text: string }) => message.text,
    )
    expect(firstGenerateMessages.join("\n")).toContain("Morning cook budget: 40")
    expect(firstGenerateMessages.join("\n")).toContain("Dietary exclusions (hard)")
    expect(firstGenerateMessages.join("\n")).toContain("[cheat-day] Friday cheat day")

    await run
    expect(step.isWaiting()).toBe(false)
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
    // Each queued LLM call reports 1000 in / 500 out: v1 usage = extract + session
    // (3000/1500), v2 = its own revision session (2000/1000).
    expect(active?.version.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 1000,
      model: "~openai/gpt-luna-latest",
      decisionsCostUsd: 0,
    })
    const plans = network.getState().telegramMessages.filter((candidate) => candidate.text.includes("School week of"))
    expect(plans).toHaveLength(2)
    expect(plans[0]?.text).toContain("Est. cost:")
    expect(plans[0]?.text).toContain("3000 in / 1500 out")
    expect(plans[1]?.text).toContain("Est. cost:")
    expect(plans[1]?.text).toContain("5000 in / 2500 out")

    step.timeout()
    await run
  })

  it("starts a separate edit run for unaddressed plain text after generation completes", async () => {
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

  it("starts a new revision for an accepted Mini App batch after generation completes", async () => {
    const base = seedCandidate()
    const revised = seedCandidate({ day: "Mon", slot: "snack1", cell: cell("idli", ["rice"], "snack1") })
    const { env, db, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueInitialPlan(base)
    await handleTelegramWebhook(message("/mealplan this week"), env)
    const initial = startedWorkflowRun(wf, env)
    await initial.run
    expect(initial.step.isWaiting()).toBe(false)
    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    const active = await store.activePlan("100")
    if (!active) throw new Error("missing saved plan")
    const accepted = await store.acceptFeedbackBatch({
      batchId: "mini-edit-1",
      planId: active.plan.planId,
      chatId: "100",
      baseVersion: 1,
      workflowInstanceId: active.plan.instanceId,
      idempotencyKey: "mini-edit-1",
      items: [{ text: "Mon snack: prefer idli", target: { kind: "cell", day: "Mon", slot: "snack1" } }],
    })
    if (!accepted.ok) throw new Error("batch rejected")
    const batch = await store.feedbackBatch("mini-edit-1")
    if (!batch) throw new Error("missing accepted batch")
    queueRevision(
      revised,
      { id: batch.items[0].id, text: batch.items[0].text, scope: { day: "Mon", slot: "snack1" } },
      false,
    )
    expect(await startFeedbackBatch(batch, env)).toBe(true)
    await wf.settled()
    expect((await store.activePlan("100"))?.plan.currentVersion).toBe(2)
    expect((await store.feedbackBatch(batch.batchId))?.status).toBe("consumed")
    expect(wf.created).toHaveLength(2)
    expect(wf.get).not.toHaveBeenCalled()
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(
      network.getState().telegramMessages.filter((message) => message.text.includes("School week of")),
    ).toHaveLength(2)
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

  it("lets a later-persisted initial plan supersede an earlier one when its clarification is answered after the other persisted", async () => {
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

    // Answering the FIRST prompt later still resolves the clarification, but the
    // first workflow has lost its generation lease and cannot overwrite the plan
    // already persisted by the second workflow.
    queueInitialPlan(base)
    await handleTelegramWebhook(message("7 people", 60, clarifyPromptId), env)
    await first.run

    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    const active = await store.activePlan("100")
    expect(active?.plan.instanceId).toBe("meal-wf-2")

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

  it("sends meal-agent-unavailable and persists nothing when the provider rejects", async () => {
    const { env, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    mockGenerate.mockRejectedValue(new Error("upstream down"))

    await handleTelegramWebhook(message("/mealplan this week"), env)
    const { step, run } = startedWorkflowRun(wf, env)
    await waitForMessageText(network, "couldn't reach")

    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    expect(await store.activePlan("100")).toBeNull()
    step.timeout()
    await run
  })

  it("replays a completed instance (restart) without re-sending the plan or duplicating rows", async () => {
    const base = seedCandidate()
    const { env, network } = runtimeEnv({})
    const wf = mealWorkflowBinding()
    env.MEAL_PLANNING_WORKFLOW = wf as never
    queueInitialPlan(base)

    await handleTelegramWebhook(message("/mealplan this week"), env)
    const created = wf.created[wf.created.length - 1]
    if (!created) throw new Error("meal workflow was not created")
    const event = {
      instanceId: created.id,
      payload: (created.params as { params: MealPlanningWorkflowParams }).params,
      timestamp: new Date().toISOString(),
      workflowName: "meal-planning",
    } as never
    const step = memoStep()
    await runAgentCenteredMealPlanningWorkflow(env, event, step as never)
    await waitForMessageText(network, "School week of")

    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    expect((await store.activePlan("100"))?.plan.currentVersion).toBe(1)

    // "Restart" the same instance: memoized durable steps replay, so the plan
    // message is not re-sent and no rows are duplicated.
    await runAgentCenteredMealPlanningWorkflow(env, event, step as never)
    expect(
      network.getState().telegramMessages.filter((candidate) => candidate.text.includes("School week of")).length,
    ).toBe(1)
    expect((await store.activePlan("100"))?.plan.currentVersion).toBe(1)
  })
})

describe("meal edit recovery in the actual Workflow runtime", () => {
  it.each([
    "meal-planning-promote-revision-0",
    "meal-planning-send-plan-revision-0",
    "meal-planning-register-feedback-revision-0",
    "uncheckpointed-promotion",
  ])("restores persisted D1, batch and feedback state across reboot at %s", async (scenario) => {
    const require = createRequire(import.meta.url)
    const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
    const { Miniflare } = runtimeRequire("miniflare") as {
      Miniflare: new (
        options: unknown,
      ) => {
        dispatchFetch(url: string, init?: RequestInit): Promise<Response>
        getD1Database(binding: string): Promise<{ exec(sql: string): Promise<unknown> }>
        dispose(): Promise<void>
      }
    }
    const { build } = runtimeRequire("esbuild") as {
      build(options: unknown): Promise<{ outputFiles: Array<{ text: string }> }>
    }
    const checkpointLost = scenario === "uncheckpointed-promotion"
    const boundary = checkpointLost ? "meal-planning-promote-revision-0" : scenario
    const base = selectionCandidate(seedCandidate())
    const patch = { grid: { Mon: { snack1: { mealDefinitionId: SEED_MEAL_IDS["vegetable cutlet"] } } } }
    const feedback = { id: "mini-1", text: "Use vegetable cutlet.", scope: { day: "Mon", slot: "snack1" } }
    const providerResponses = [
      {
        toolCalls: [{ id: "evaluate", name: "evaluate_meal_plan", input: mealPlanSelectionCandidateToWire(base) }],
        usage: LLM_USAGE,
      },
      {
        toolCalls: [
          { id: "propose", name: "propose_plan", input: { candidate: mealPlanSelectionCandidateToWire(base) } },
        ],
        usage: LLM_USAGE,
      },
      {
        toolCalls: [{ id: "evaluate-edit", name: "evaluate_meal_plan", input: mealPlanSelectionPatchToWire(patch) }],
        usage: LLM_USAGE,
      },
      {
        toolCalls: [
          {
            id: "propose-edit",
            name: "propose_plan",
            input: { candidate: mealPlanSelectionPatchToWire(patch), feedbackItems: [feedback] },
          },
        ],
        usage: LLM_USAGE,
      },
    ]
    let providerCalls = 0
    const notifications: Array<{
      text: string
      options?: { replyMarkup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
    }> = []
    const checkpoints: string[] = []
    const entries: string[] = []
    const source = `
      import { MealPlanningWorkflow } from "./src/meal-planning/workflow";
      import { InteractionRouterDO } from "./src/core/interaction-router";
      import { createMealPlanningStore, SEED_PROFILE, SEED_MEAL_IDS } from "./src/meal-planning/store";
      export {InteractionRouterDO};
      const OriginalDate = Date;
      const probeNow = ${Date.parse("2026-09-07T03:30:00.000Z")};
      globalThis.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [probeNow])); }
        static now() { return probeNow; }
      };
      SEED_PROFILE.mealDefinitions = SEED_PROFILE.mealDefinitions.map(def => ({...def,
        suitableSlots:["breakfast","snack1","snack2","school-lunch","home-lunch"],
        packedFood:{suitable:true,dry:true},typicalCookMinutes:0,priorNightPrep:"none",requiredIngredients:["rice"]}));
      SEED_PROFILE.foodPreferences = {...SEED_PROFILE.foodPreferences,favourites:Object.keys(SEED_MEAL_IDS).slice(0,30)};
      export class MealProbe extends MealPlanningWorkflow {
        async run(event, step) {
          await fetch("https://probe/entry",{method:"POST",body:event.instanceId});
          const wrapped = {
            do: async (name, ...args) => {
              if (event.payload.edit && name === ${JSON.stringify(boundary)}) {
                if (${checkpointLost}) {
                  const fn = args.pop();
                  return step.do(name,{retries:{limit:2,delay:"1 second",backoff:"constant"}},async (...fnArgs) => {
                    const result = await fn(...fnArgs);
                    if (!this.env.PROBE_RECOVERING) {
                      await fetch("https://probe/checkpoint",{method:"POST",body:name});
                      throw new Error("Injected lost checkpoint after D1 commit");
                    }
                    return result;
                  });
                }
                await fetch("https://probe/checkpoint",{method:"POST",body:name});
                await step.waitForEvent("interruption",{type:"continue",timeout:"1 hour"});
              }
              return step.do(name,...args);
            },
            waitForEvent:(...args)=>step.waitForEvent(...args)
          };
          return super.run(event,wrapped);
        }
      }
      export default {async fetch(request,env) {
        const url = new URL(request.url);
        const id = url.searchParams.get("id") || "generation";
        const store = createMealPlanningStore(env.MEAL_PLANNING_DB);
        const router = env.INTERACTION_ROUTER.get(env.INTERACTION_ROUTER.idFromName("telegram-chat:100"));
        if (url.pathname.startsWith("/router/")) return router.fetch(new Request("http://router/"+url.pathname.slice(8),request));
        if (url.pathname === "/state") return Response.json({
          active:await store.activePlan("100"),batch:await store.feedbackBatch("recovery-batch"),profile:await store.loadOrCreateProfile("100"),
          versions:await env.MEAL_PLANNING_DB.prepare("SELECT version FROM meal_plan_version ORDER BY version").all(),
        });
        if (url.pathname === "/generate") {
          await env.MEAL_PLANNING_WORKFLOW.create({id,params:{chatId:"100",telegramMessageId:1,requestText:"",invokedAtMs:Date.now()}});
          return Response.json({ok:true});
        }
        if (url.pathname === "/edit") {
          const active = await store.activePlan("100");
          const accepted = await store.acceptFeedbackBatch({batchId:"recovery-batch",planId:active.plan.planId,chatId:"100",baseVersion:1,
            workflowInstanceId:"generation",idempotencyKey:"recovery",items:[{text:"Use vegetable cutlet.",target:{kind:"cell",day:"Mon",slot:"snack1"}}]});
          if (!accepted.ok) throw new Error("batch not accepted");
          await store.markFeedbackBatchDelivered("recovery-batch");
          await env.MEAL_PLANNING_WORKFLOW.create({id,params:{chatId:"100",telegramMessageId:2,requestText:"",invokedAtMs:Date.now(),
            edit:{planInstanceId:"generation",userId:"42",feedback:{interactionKind:"meal-feedback-submission",source:"mini-app",feedbackBatchId:"recovery-batch",baseVersion:1}}}});
          return Response.json({ok:true});
        }
        const instance = await env.MEAL_PLANNING_WORKFLOW.get(id);
        if (url.pathname === "/pause") await instance.pause();
        if (url.pathname === "/resume") await instance.resume();
        if (url.pathname === "/continue") await instance.sendEvent({type:"continue",payload:{}});
        return Response.json(await instance.status());
      }};
    `
    const { outputFiles } = await build({
      stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      external: ["cloudflare:workers"],
      plugins: [
        {
          name: "external-services",
          setup(plugin: {
            onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void
            onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void
          }) {
            plugin.onResolve({ filter: /\/(providers|integrations\/telegram)$/ }, ({ path }) => ({
              path: path.endsWith("providers") ? "providers" : "telegram",
              namespace: "boundary",
            }))
            plugin.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({
              loader: "js",
              contents:
                path === "providers"
                  ? 'export function createToolProvider() {return {generate:async (request)=>(await fetch("https://probe/provider",{method:"POST",body:JSON.stringify(request)})).json()};}'
                  : 'export function createTelegramClient() {return {sendMessage:async(chatId,text,options)=>(await fetch("https://probe/telegram",{method:"POST",body:JSON.stringify({chatId,text,options})})).json()};}',
            }))
          },
        },
      ],
    })
    const persistence = await mkdtemp(join(tmpdir(), "kipp-meal-recovery-"))
    const options = {
      modules: true,
      script: outputFiles[0].text,
      compatibilityDate: "2026-07-08",
      bindings: {
        TELEGRAM_BOT_TOKEN: "test",
        TELEGRAM_ALLOWED_USER_ID: "42",
        TIMEZONE: "Asia/Kolkata",
        LOG_LEVEL: "error",
        LLM_MAX_RETRIES: "0",
        PROBE_RECOVERING: "",
      },
      workflows: { MEAL_PLANNING_WORKFLOW: { name: "meal-recovery", className: "MealProbe" } },
      durableObjects: { INTERACTION_ROUTER: { className: "InteractionRouterDO", useSQLite: true } },
      d1Databases: { MEAL_PLANNING_DB: "meal-db" },
      d1Persist: join(persistence, "d1"),
      workflowsPersist: join(persistence, "workflows"),
      durableObjectsPersist: join(persistence, "router"),
      outboundService: async (request: Request) => {
        if (new URL(request.url).hostname !== "probe") throw new Error(`unexpected external request ${request.url}`)
        const path = new URL(request.url).pathname
        if (path === "/entry") {
          entries.push(await request.text())
          return new Response("ok")
        }
        if (path === "/checkpoint") {
          checkpoints.push(await request.text())
          return new Response("ok")
        }
        if (path === "/telegram") {
          notifications.push((await request.json()) as { text: string })
          return Response.json({ messageId: notifications.length })
        }
        if (path === "/provider") {
          const response = providerResponses[providerCalls++]
          if (!response) throw new Error("unexpected repeated provider call")
          return Response.json(response)
        }
        throw new Error(`unexpected external request ${request.url}`)
      },
    }
    let runtime = new Miniflare(options)
    /** Reads the real workflow status. */
    async function status(id: string): Promise<string> {
      return ((await (await runtime.dispatchFetch(`http://probe/status?id=${id}`)).json()) as { status: string }).status
    }
    /** Reads the saved plan, batch and message generation from D1. */
    async function state() {
      return (await (await runtime.dispatchFetch("http://probe/state")).json()) as {
        active: { plan: { currentVersion: number }; version: { candidate: MealPlanCandidate } }
        batch: { status: string }
        profile: { interactionGeneration: number }
        versions: { results: Array<{ version: number }> }
      }
    }
    /** Waits for an observable boundary rather than inferring an event wait from status. */
    async function waitFor(check: () => Promise<boolean>): Promise<void> {
      const deadline = Date.now() + 10_000
      while (!(await check())) {
        if (Date.now() > deadline)
          throw new Error(`meal runtime boundary not reached: ${scenario}; ${JSON.stringify(await state())}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    try {
      const d1 = await runtime.getD1Database("MEAL_PLANNING_DB")
      for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
        await d1.exec((await readFile(join("migrations", file), "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " "))
      }
      expect((await runtime.dispatchFetch("http://probe/generate")).ok).toBe(true)
      await waitFor(async () => (await status("generation")) === "complete")
      expect((await state()).active.plan.currentVersion).toBe(1)
      expect((await runtime.dispatchFetch("http://probe/edit?id=edit-recovery")).ok).toBe(true)
      await waitFor(async () => checkpoints.length > 0)
      const promoted = checkpointLost || !scenario.includes("promote")
      expect((await state()).batch.status).toBe(promoted ? "consumed" : "processing")
      expect((await state()).active.plan.currentVersion).toBe(promoted ? 2 : 1)
      await runtime.dispatchFetch("http://probe/pause?id=edit-recovery")
      await waitFor(async () => (await status("edit-recovery")) === "paused")
      await runtime.dispose()
      options.bindings.PROBE_RECOVERING = "true"
      runtime = new Miniflare(options)
      expect(await status("edit-recovery")).toBe("paused")
      const claim = await runtime.dispatchFetch("http://probe/router/edit/claim", {
        method: "POST",
        body: JSON.stringify({ resourceId: "meal:generation", workflowId: "competitor", domain: "meal" }),
      })
      expect(await claim.json()).toEqual({ ok: false })
      await runtime.dispatchFetch("http://probe/resume?id=edit-recovery")
      await waitFor(async () => entries.filter((id) => id === "edit-recovery").length === 2)
      if (!checkpointLost) await runtime.dispatchFetch("http://probe/continue?id=edit-recovery")
      await waitFor(async () => (await status("edit-recovery")) === "complete")
      const recovered = await state()
      expect(providerCalls).toBe(4)
      expect(recovered.active.plan.currentVersion).toBe(2)
      expect(recovered.active.version.candidate.grid.Mon.snack1.dish).toBe("vegetable cutlet")
      expect(recovered.batch.status).toBe("consumed")
      expect(recovered.profile.interactionGeneration).toBe(2)
      expect(recovered.versions.results).toEqual([{ version: 1 }, { version: 2 }])
      expect(notifications.filter((m) => m.text.includes("School week of"))).toHaveLength(2)
      expect(notifications.map((m) => m.text).join(" ")).not.toMatch(/couldn't|not applied|out of date/i)
      const token = notifications.at(-1)?.options?.replyMarkup?.inline_keyboard[0][0].callback_data
      expect(token).toBeTruthy()
      const feedbackReply = await runtime.dispatchFetch("http://probe/router/resolve", {
        method: "POST",
        body: JSON.stringify({ callbackToken: token, telegramUpdateId: 99 }),
      })
      expect(await feedbackReply.json()).toMatchObject({
        interaction: { kind: "meal-feedback", edit: {}, workflowId: "generation", version: 2 },
      })
      const released = await runtime.dispatchFetch("http://probe/router/edit/claim", {
        method: "POST",
        body: JSON.stringify({ resourceId: "meal:generation", workflowId: "competitor", domain: "meal" }),
      })
      expect(await released.json()).toEqual({ ok: true })
    } finally {
      await runtime.dispose()
      await rm(persistence, { recursive: true, force: true })
    }
  }, 30_000)
})
