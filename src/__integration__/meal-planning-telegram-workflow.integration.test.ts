import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import { mealPlanSelectionCandidateToWire } from "../agent/meal-planning"
import type { Env } from "../core/types"
import type { MealCell, MealPlanCandidate, MealPlanSelectionCandidate } from "../meal-planning/types"
import type { MealPlanningWorkflowParams } from "../meal-planning/workflow"

vitest.mock("../providers", () => ({ createToolProvider: () => ({ generate: mockGenerate }) }))

const mockGenerate = vitest.hoisted(() => vitest.fn())

const LLM_QUEUE: Array<{ label: string; response: unknown }> = []

function queueResponse(label: string, response: unknown): void {
  LLM_QUEUE.push({ label, response })
}

function queueInitialPlan(base: MealPlanCandidate): void {
  queueWeekContextExtraction()
  queueResponse("evaluate", {
    toolCalls: [
      { id: "evaluate", name: "evaluate_meal_plan", input: mealPlanSelectionCandidateToWire(selectionCandidate(base)) },
    ],
    usage: {},
  })
  queueResponse("propose", {
    toolCalls: [{ id: "propose", name: "propose_plan", input: proposeInput(base) }],
    usage: {},
  })
}

function queueWeekContextExtraction(): void {
  queueResponse("extract-week-context", {
    toolCalls: [
      { id: "extract-week-context", name: "extract_week_context", input: { inventoryChanges: [], exceptionAdds: [] } },
    ],
    usage: {},
  })
}

function queueRevision(
  revised: MealPlanCandidate,
  feedback: { id: string; text: string; scope?: { day: string; slot: string } },
): void {
  queueResponse("evaluate-rev", {
    toolCalls: [
      {
        id: "evaluate-rev",
        name: "evaluate_meal_plan",
        input: mealPlanSelectionCandidateToWire(selectionCandidate(revised)),
      },
    ],
    usage: {},
  })
  queueResponse("propose-rev", {
    toolCalls: [{ id: "propose-rev", name: "propose_plan", input: proposeInput(revised, [feedback]) }],
    usage: {},
  })
}

import { createD1TestDb, d1Count } from "../__tests__/d1-test-db"
import { type MealPlanningLiveEvent, runAgentCenteredMealPlanningWorkflow } from "../meal-planning/agent-workflow"
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
      if (ended) return { type: "timeout" }
      ended = true
      vitest.setSystemTime(Date.now() + 8 * 86_400_000)
      return { type: "timeout" }
    }),
    sleep: vitest.fn(),
    sleepUntil: vitest.fn(),
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

    // The planning model must see the household context: profile, schedule,
    // policies, and week state are injected into its first turn's messages.
    const firstGenerateMessages = mockGenerate.mock.calls[1][0].messages.map(
      (message: { role: string; text: string }) => message.text,
    )
    expect(firstGenerateMessages.join("\n")).toContain("Morning cook budget: 40")
    expect(firstGenerateMessages.join("\n")).toContain("Dietary exclusions (hard)")
    expect(firstGenerateMessages.join("\n")).toContain("[cheat-day] Friday cheat day")

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
    const secondPlanIndex = await waitForMessageText(network, "School week of")

    // Answering the FIRST prompt later: the clarification registered before any plan
    // existed carries no generation, so it still resolves and the first session
    // persists. Its persistence batch commits after the second plan, so
    // last-commit-wins: the first plan supersedes the second as the active plan.
    queueInitialPlan(base)
    await handleTelegramWebhook(message("7 people", 60, clarifyPromptId), env)
    await waitForMessageText(network, "School week of", secondPlanIndex)

    const store = createMealPlanningStore(env.MEAL_PLANNING_DB as D1Database)
    const active = await store.activePlan("100")
    expect(active?.plan.instanceId).toBe("meal-wf-1")

    first.step.timeout()
    await first.run
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
