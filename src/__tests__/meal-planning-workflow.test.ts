import type { WorkflowEvent } from "cloudflare:workers"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mealPlanSelectionCandidateToWire, mealPlanSelectionPatchToWire } from "../agent/meal-planning"
import { MEAL_PLANNING_AGENT_PROMPT } from "../agent/meal-planning-session"
import { createInteractionRouter } from "../core/interaction-router-client"
import type { Env } from "../core/types"
import {
  type MealPlanningLiveEvent,
  miniAppLaunchUrl,
  renderHouseholdContext,
  renderPlanningTimeContext,
  renderRevisionFeedback,
  renderWeekContextExtractionPrompt,
  runAgentCenteredMealPlanningWorkflow,
  runMealPlanningEditWorkflow,
} from "../meal-planning/agent-workflow"
import { createMealPlanningStore, SEED_MEAL_IDS, SEED_PROFILE, SEED_SCHEDULE } from "../meal-planning/store"
import type { MealCell, MealPlanContext, MealPlanSelectionCandidate } from "../meal-planning/types"
import { resolvePlanningWeek } from "../meal-planning/week"
import type { MealPlanningWorkflowParams } from "../meal-planning/workflow"
import { createD1TestDb, d1Count, d1Scalar } from "./d1-test-db"
import { sqliteInteractionRouter } from "./fixtures/interaction-router"
import { workflowTimeoutError } from "./fixtures/workflow-timeout"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SLOT_COOK: Record<string, number> = { breakfast: 15, snack1: 0, snack2: 0, "school-lunch": 20, "home-lunch": 20 }
const POLICY_IDS = [
  "snack-policy",
  "ingredient-naming",
  "relevant-variety",
  "nutrition-target-fruit",
  "nutrition-target-nuts",
  "school-rule",
  "cheat-day",
]
const CHAT = "chat-1"
const TZ = "Asia/Kolkata"

it("renders complete structured catalog facts for the planning agent", () => {
  const context: MealPlanContext = {
    schedule: SEED_SCHEDULE,
    profile: SEED_PROFILE,
    customPolicies: [],
    weeklyInventory: {
      items: [
        { name: "Rajma", status: "available" },
        { name: "carrot", status: "available", quantityNote: "two carrots" },
        { name: "paneer", status: "unavailable" },
      ],
      notes: [],
    },
    weeklyExceptions: { items: [] },
    request: { kind: "initial_plan", text: "Plan this week." },
  }
  const rendered = renderHouseholdContext(context)
  expect(rendered).toContain("Recurring half days: Sat")
  expect(renderWeekContextExtractionPrompt(context)).toContain("emit full_day")
  expect(rendered).toContain("one JSON record per available catalog meal")
  expect(rendered).toContain('"typicalCookMinutes"')
  expect(rendered).toContain('"priorNightPrep"')
  expect(rendered).toContain('"requiredIngredients"')
  expect(rendered).not.toContain(" | ")
  expect(rendered).toContain("Rajma, carrot (two carrots), paneer (unavailable)")
  expect(rendered).not.toContain("Rajma (available)")
})

it("requires the planner to self-check singular ingredient names", () => {
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain(
    "confirm that every ingredient name you returned uses its singular canonical form",
  )
})

it("keeps easy buys out of the revision agent contract", () => {
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain("The server recalculates easyBuys")
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain("the server adds other newly required ingredients to easyBuys")
  const revisionSchema = mealPlanSelectionPatchToWire({ grid: {}, policyOutcomes: {} })
  expect(revisionSchema).not.toHaveProperty("easyBuys")
})

it("guides home-lunch composition and one-meal fresh-produce usage", () => {
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain(
    "select the vegetable curry/subzi as the meal represented in the home-lunch slot",
  )
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain("The parent can choose the accompanying staple")
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain(
    "A flavored-rice meal such as pulao or tomato rice is an explicit exception",
  )
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain(
    "Treat fresh produce in the weekly inventory as enough for one meal only",
  )
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain("except onion, tomato, and potato, which may be reused across meals")
})

it("tells the planner that half-day snack candidates are conditional", () => {
  const context: MealPlanContext = {
    schedule: SEED_SCHEDULE,
    profile: SEED_PROFILE,
    customPolicies: [],
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [{ kind: "half_day" as const, appliesTo: { day: "Wed" }, instruction: "Short day" }] },
    request: { kind: "initial_plan", text: "Plan this week." },
  }
  const rendered = renderHouseholdContext(context)
  expect(rendered).toContain("Quick half-day slot snack1 candidates")
  expect(rendered).toContain("max 20 cook minutes")
  expect(MEAL_PLANNING_AGENT_PROMPT).toContain("include each slot marked keep, omit each slot marked omit")
  expect(MEAL_PLANNING_AGENT_PROMPT).not.toContain("plan exactly breakfast, snack1, and home lunch")
})

it("renders scoped and plan-wide revision feedback without storage ids", () => {
  expect(
    renderRevisionFeedback([
      { id: "fb-cell", text: "Use a simpler dish.", scope: { day: "Tue", slot: "school-lunch" } },
      { id: "fb-day", text: "Make the day lighter.", scope: { day: "Thu" } },
      { id: "fb-unbound", text: "Use less oil." },
    ]),
  ).toBe(
    "- Feedback for Tue school-lunch: Use a simpler dish.\n- Feedback for every meal on Thu: Make the day lighter.\n- Plan-wide feedback: Use less oil.",
  )
})

it("renders neutral current-time and planning-week facts for relative-date requests", () => {
  expect(
    renderPlanningTimeContext(
      new Date("2026-09-01T03:30:00.000Z"),
      "Asia/Kolkata",
      "2026-08-30T18:30:00.000Z",
      "2026-09-05T18:29:59.999Z",
    ),
  ).toBe(
    "Current instant: 2026-09-01T03:30:00.000Z\n" +
      "Time zone: Asia/Kolkata\n" +
      "Planning-week start: 2026-08-30T18:30:00.000Z\n" +
      "Planning-week end: 2026-09-05T18:29:59.999Z",
  )
})

it("builds Mini App launch URLs only from configured HTTPS origins without credentials", () => {
  expect(miniAppLaunchUrl("https://mini-app.example.test/config-path?ignored=query")).toBe(
    "https://mini-app.example.test/mini-app",
  )
  expect(miniAppLaunchUrl("http://mini-app.example.test")).toBeNull()
  expect(miniAppLaunchUrl("not a URL")).toBeNull()
  expect(miniAppLaunchUrl(undefined)).toBeNull()
  expect(miniAppLaunchUrl("https://localhost")).toBe("https://localhost/mini-app")
  expect(miniAppLaunchUrl("https://127.0.0.1")).toBe("https://127.0.0.1/mini-app")
  expect(miniAppLaunchUrl("https://user:pass@mini-app.example.test")).toBeNull()
  expect(miniAppLaunchUrl("https://[2606:4700:4700::1111]")).toBe("https://[2606:4700:4700::1111]/mini-app")
})

// Workflow fixtures use distinct seeded definitions, with only the favourite
// paratha repeated twice, so they remain valid under the relevant-variety policy.
SEED_PROFILE.mealDefinitions = (SEED_PROFILE.mealDefinitions ?? []).map((definition) => ({
  ...definition,
  suitableSlots: Object.keys(SLOT_COOK),
  packedFood: { suitable: true, dry: true },
  typicalCookMinutes: 0,
  priorNightPrep: "none",
  principalIngredients: [],
  requiredIngredients: [],
  optionalIngredients: [],
}))

function seedCandidate(override?: { day: string; slot: string; cell: MealCell }): MealPlanSelectionCandidate {
  const fixtureMealIds = (SEED_PROFILE.mealDefinitions ?? []).map((definition) => definition.id)
  const grid: MealPlanSelectionCandidate["grid"] = {}
  for (const [dayIndex, day] of DAYS.entries()) {
    grid[day] = Object.fromEntries(
      Object.keys(SLOT_COOK)
        .filter((slot) => day !== "Sat" || !["snack2", "school-lunch"].includes(slot))
        .map((slot, slotIndex) => [
          slot,
          { mealDefinitionId: fixtureMealIds[dayIndex * Object.keys(SLOT_COOK).length + slotIndex] },
        ]),
    )
  }
  // Keep one favourite repeat in the baseline so revision tests can verify
  // that unchanged favourite dishes remain valid under the two-use cap.
  grid.Wed.breakfast = { mealDefinitionId: SEED_MEAL_IDS.paratha }
  if (override) {
    const mealDefinitionId = SEED_MEAL_IDS[override.cell.dish]
    if (!mealDefinitionId) throw new Error(`missing fixture meal definition for ${override.cell.dish}`)
    grid[override.day][override.slot] = { mealDefinitionId }
  }
  return {
    grid,
    easyBuys: ["pomegranate", "apple"],
    policyOutcomes: Object.fromEntries(POLICY_IDS.map((id) => [id, { outcome: "satisfied", rationale: "ok" }])),
  }
}

function revisionPatch(
  day: string,
  slot: string,
  mealDefinitionId: string,
): { grid: MealPlanSelectionCandidate["grid"] } {
  return { grid: { [day]: { [slot]: { mealDefinitionId } } } }
}

function proposeInput(candidate: unknown, feedbackItems?: unknown) {
  return {
    candidate,
    ...(feedbackItems ? { feedbackItems } : {}),
  }
}

function deepseekToolCall(name: string, input: unknown) {
  return { id: name, type: "function", function: { name, arguments: JSON.stringify(input) } }
}

function deepseekResponse(toolCalls: Array<{ name: string; input: unknown }>) {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: toolCalls.map((call) => deepseekToolCall(call.name, plannerWireInput(call.name, call.input))),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

function plannerWireInput(name: string, input: unknown): unknown {
  if (!input || typeof input !== "object") return input
  if (name === "evaluate_meal_plan") return mealPlanWireCandidateOrPatch(input as MealPlanSelectionCandidate)
  if (name === "propose_plan") {
    const submission = input as { candidate?: MealPlanSelectionCandidate }
    return submission.candidate
      ? { ...submission, candidate: mealPlanWireCandidateOrPatch(submission.candidate) }
      : input
  }
  return input
}

function mealPlanWireCandidateOrPatch(candidate: MealPlanSelectionCandidate): unknown {
  return "easyBuys" in candidate ? mealPlanSelectionCandidateToWire(candidate) : mealPlanSelectionPatchToWire(candidate)
}

function clarifyResponse(message: string) {
  return deepseekResponse([
    {
      name: "needs_clarification",
      input: { message, reasonCodes: ["slot_unsuitable"], interaction: { kind: "reply" } },
    },
  ])
}

function proseResponse() {
  return {
    choices: [{ message: { content: "I will plan the week." } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function stubNetwork(deepseekResponses: unknown[], decisionsCost: number | null = 0.002) {
  const telegramMessages: Array<{ chatId: string; text: string; replyMarkup?: unknown }> = []
  const deepseekBodies: Array<{
    messages: Array<{
      role: string
      content?: string
      tool_call_id?: string
      tool_calls?: Array<{ id?: string; function?: { name?: string } }>
    }>
  }> = []
  let messageId = 1000
  let llmIndex = 0
  const fallback = proseResponse()
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url)
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>
      telegramMessages.push({
        chatId: String(body.chat_id),
        text: String(body.text),
        replyMarkup: body.reply_markup,
      })
      return jsonResponse({ ok: true, result: { message_id: messageId++ } })
    }
    if (urlStr.includes("openrouter.ai/api/alpha/decisions")) {
      const body = JSON.parse(init?.body as string)
      return jsonResponse({
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 1 }])),
        usage: { input_tokens: 10, output_tokens: 2, ...(decisionsCost === null ? {} : { cost: decisionsCost }) },
      })
    }
    if (urlStr.includes("api.deepseek.com") || urlStr.includes("openrouter.ai/api/v1")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        messages: Array<{
          role: string
          content?: string
          tool_call_id?: string
          tool_calls?: Array<{ id?: string; function?: { name?: string } }>
        }>
      }
      deepseekBodies.push(body)
      const next = deepseekResponses[llmIndex] ?? fallback
      llmIndex += 1
      return jsonResponse(next)
    }
    throw new Error(`unexpected fetch ${urlStr}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return { telegramMessages, deepseekBodies }
}

/** Deterministic `crypto.randomUUID` sequence so prompts can reference the generated interaction ids. */
function stubUuidSequence() {
  let nextId = 0
  vi.stubGlobal("crypto", { randomUUID: () => `uuid-${++nextId}` })
}

function fakeRouter() {
  return sqliteInteractionRouter()
}

function createFakeStep(events: MealPlanningLiveEvent[], endTime: number) {
  const queue = [...events]
  return {
    do: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(async () => {
      const next = queue.shift()
      if (next) return { type: "event" as const, payload: next }
      // Advance the mocked clock to week end so the live loop's `week_end`
      // check terminates on the next iteration.
      vi.setSystemTime(endTime)
      throw workflowTimeoutError()
    }),
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
  }
}

/** A fake step that memoizes `do` by step name like the Workflows runtime, so a repeated name returns the cached result without re-running. */
function createMemoizingStep(events: MealPlanningLiveEvent[], endTime: number) {
  const queue = [...events]
  const cache = new Map<string, unknown>()
  return {
    do: vi.fn(async (name: string, fn: () => unknown) => {
      if (cache.has(name)) return cache.get(name)
      const result = await fn()
      cache.set(name, result)
      return result
    }),
    waitForEvent: vi.fn(async () => {
      const next = queue.shift()
      if (next) return { type: "event" as const, payload: next }
      vi.setSystemTime(endTime)
      throw workflowTimeoutError()
    }),
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
  }
}

function mealEvent(invokedAtMs: number, requestText = ""): WorkflowEvent<MealPlanningWorkflowParams> {
  return {
    instanceId: "wf-meal-1",
    payload: { chatId: CHAT, telegramMessageId: 10, requestText, invokedAtMs },
  } as unknown as WorkflowEvent<MealPlanningWorkflowParams>
}

function makeEnv(namespace: DurableObjectNamespace, d1: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_ALLOWED_USER_ID: "42",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    LLM_MODEL: "deepseek-flash",
    OPENROUTER_API_KEY: "openrouter-key",
    LLM_MAX_RETRIES: "3",
    INTERACTION_ROUTER: namespace,
    MEAL_PLANNING_DB: d1,
    TIMEZONE: TZ,
    LOG_LEVEL: "info",
    ...overrides,
  } as unknown as Env
}

/** Drains scripted feedback into separate memoized edit runs after generation completes. */
async function generateThenEdit(
  env: Env,
  event: WorkflowEvent<MealPlanningWorkflowParams>,
  source: ReturnType<typeof createFakeStep>,
) {
  await runAgentCenteredMealPlanningWorkflow(env, event, source as never)
  for (let index = 0; index < 10; index++) {
    let delivered: { payload?: MealPlanningLiveEvent }
    try {
      delivered = await source.waitForEvent()
    } catch {
      break
    }
    if (!delivered.payload) break
    const step = createMemoizingStep([], Date.now())
    await runMealPlanningEditWorkflow(
      env,
      {
        ...event,
        instanceId: `edit-${index}`,
        payload: {
          ...event.payload,
          edit: { planInstanceId: event.instanceId, userId: "42", feedback: delivered.payload },
        },
      },
      step as never,
    )
  }
}

describe("runAgentCenteredMealPlanningWorkflow", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("generates and persists a custom Sunday half-day against configured slot rules", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const store = createMealPlanningStore(d1)
    const stored = await store.loadOrCreateProfile(CHAT)
    const schedule = {
      days: ["Sun"],
      halfDays: ["Sun"],
      slots: [
        {
          id: "morning-tea",
          name: "Morning tea",
          packed: true,
          dry: true,
          maxCookMinutes: null,
          halfDayBehavior: { action: "quick" as const, maxCookMinutes: 15 },
        },
        {
          id: "supper",
          name: "Supper",
          packed: false,
          dry: false,
          maxCookMinutes: null,
          halfDayBehavior: { action: "keep" as const },
        },
      ],
    }
    stored.profile.allowNewFoods = false
    stored.profile.mealDefinitions = (stored.profile.mealDefinitions ?? []).map((definition) => ({
      ...definition,
      suitableSlots: ["morning-tea", "supper"],
    }))
    db.prepare("UPDATE meal_profile SET profile_json = ?, schedule_json = ? WHERE chat_id = ?").run(
      JSON.stringify(stored.profile),
      JSON.stringify(schedule),
      CHAT,
    )
    const policyOutcomes = Object.fromEntries(
      stored.customPolicies
        .filter((policy) => policy.scope === "persistent")
        .map((policy) => [policy.id, { outcome: "satisfied" as const, rationale: "ok" }]),
    )
    const candidate: MealPlanSelectionCandidate = {
      grid: {
        Sun: {
          "morning-tea": { mealDefinitionId: SEED_MEAL_IDS.banana },
          supper: { mealDefinitionId: SEED_MEAL_IDS.paratha },
        },
      },
      easyBuys: [],
      policyOutcomes,
    }
    const network = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: candidate }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(candidate) }]),
      deepseekResponse([
        {
          name: "evaluate_meal_plan",
          input: { grid: { Sun: { "morning-tea": { mealDefinitionId: SEED_MEAL_IDS["roasted chana"] } } } },
        },
      ]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(
            { grid: { Sun: { "morning-tea": { mealDefinitionId: SEED_MEAL_IDS["roasted chana"] } } } },
            [{ id: "tg-412", text: "Replace banana with roasted chana on Sunday." }],
          ),
        },
      ]),
    ])
    const week = resolvePlanningWeek(invokedAtMs, TZ, "", schedule)
    await runAgentCenteredMealPlanningWorkflow(
      makeEnv(namespace, d1),
      mealEvent(invokedAtMs),
      createFakeStep([], Date.parse(week.weekEnd)) as never,
    )
    const active = await store.activePlan(CHAT)
    expect(active?.plan.schedule).toEqual(schedule)
    expect(active?.plan.weekEnd).toBe(week.weekEnd)
    expect(active?.version.candidate.grid).toEqual(
      expect.objectContaining({
        Sun: expect.objectContaining({ "morning-tea": expect.any(Object), supper: expect.any(Object) }),
      }),
    )
    const plannerContext = network.deepseekBodies[0]?.messages.at(-1)?.content ?? ""
    expect(plannerContext).toContain("Effective coverage: Sun morning-tea, Sun supper")
    expect(plannerContext).toContain("Half-day rules for Sun: morning-tea: keep, max 15 cook minutes; supper: keep")

    const liveSchedule = { ...schedule, slots: [schedule.slots[1]] }
    stored.profile.mealDefinitions = (stored.profile.mealDefinitions ?? []).map((definition) => ({
      ...definition,
      suitableSlots: ["supper"],
    }))
    db.prepare("UPDATE meal_profile SET profile_json = ?, schedule_json = ? WHERE chat_id = ?").run(
      JSON.stringify(stored.profile),
      JSON.stringify(liveSchedule),
      CHAT,
    )
    const feedbackText = "Replace banana with roasted chana on Sunday."
    await runMealPlanningEditWorkflow(
      makeEnv(namespace, d1),
      {
        ...mealEvent(invokedAtMs),
        instanceId: "edit-removed-custom-slot",
        payload: {
          ...mealEvent(invokedAtMs).payload,
          edit: {
            planInstanceId: mealEvent(invokedAtMs).instanceId,
            userId: "42",
            feedback: {
              interactionKind: "meal-feedback-reply",
              source: "telegram-reply",
              text: feedbackText,
              messageId: 412,
            },
          },
        },
      } as WorkflowEvent<MealPlanningWorkflowParams>,
      createMemoizingStep([], invokedAtMs) as never,
    )
    const revised = await store.activePlan(CHAT)
    expect(revised?.plan.currentVersion).toBe(2)
    expect(revised?.plan.schedule).toEqual(schedule)
    expect(revised?.version.candidate.grid.Sun["morning-tea"].dish).toBe("roasted chana")
    expect((await store.loadOrCreateProfile(CHAT)).schedule).toEqual(liveSchedule)
    expect(network.deepseekBodies[2]?.messages.at(-1)?.content).toContain("Schedule days: Sun")
    expect(network.deepseekBodies[2]?.messages.at(-1)?.content).toContain("morning-tea")
  })

  it.each([
    "other-user",
    "other-chat",
    "other-plan",
    "foreign-batch",
  ])("rejects a Mini App edit from %s without changing or claiming its saved batch", async (attempt) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const env = makeEnv(namespace, d1)
    const original = mealEvent(invokedAtMs)
    const base = seedCandidate()
    const network = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])
    await runAgentCenteredMealPlanningWorkflow(env, original, createMemoizingStep([], invokedAtMs) as never)
    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    if (!active) throw new Error("missing saved plan")
    let batchPlan = active.plan
    if (attempt === "foreign-batch") {
      await store.loadOrCreateProfile("other-chat")
      await store.startPlanGeneration({
        chatId: "other-chat",
        generationId: "other-generation",
        expiresAt: new Date(invokedAtMs + 60_000).toISOString(),
      })
      batchPlan = (
        await store.createActivePlan({
          planId: "other-plan",
          chatId: "other-chat",
          instanceId: "other-instance",
          generationId: "other-generation",
          weekStart: active.plan.weekStart,
          weekEnd: active.plan.weekEnd,
          timezone: TZ,
          candidate: active.version.candidate,
          evaluation: active.version.evaluation,
          weeklyInventory: active.plan.weeklyInventory,
          weeklyExceptions: active.plan.weeklyExceptions,
        })
      ).plan
    }
    expect(
      (
        await store.acceptFeedbackBatch({
          batchId: "isolated-batch",
          planId: batchPlan.planId,
          chatId: batchPlan.chatId,
          baseVersion: 1,
          workflowInstanceId: batchPlan.instanceId,
          idempotencyKey: "isolated",
          items: [{ text: "Change a meal.", target: { kind: "plan" } }],
        })
      ).ok,
    ).toBe(true)
    await store.markFeedbackBatchDelivered("isolated-batch")
    const before = await store.feedbackBatch("isolated-batch")
    const event = {
      ...original,
      instanceId: "denied-edit",
      payload: {
        ...original.payload,
        chatId: attempt === "other-chat" ? "other-chat" : CHAT,
        edit: {
          planInstanceId: attempt === "other-plan" ? "wrong-plan" : original.instanceId,
          userId: attempt === "other-user" ? "99" : "42",
          feedback: {
            interactionKind: "meal-feedback-submission",
            source: "mini-app",
            feedbackBatchId: "isolated-batch",
            baseVersion: 1,
          },
        },
      },
    } as WorkflowEvent<MealPlanningWorkflowParams>
    await runMealPlanningEditWorkflow(env, event, createMemoizingStep([], invokedAtMs) as never)
    expect(network.deepseekBodies).toHaveLength(2)
    expect(await store.feedbackBatch("isolated-batch")).toEqual(before)
    expect((await store.activePlan(CHAT))?.plan.currentVersion).toBe(1)
    expect(network.telegramMessages.filter((m) => m.chatId !== CHAT)).toHaveLength(0)
  })

  it.each([
    ["mini-app", "own-write"],
    ["telegram-reply", "own-write"],
    ["telegram-reply", "other-operation"],
    ["telegram-reply", "different-candidate"],
  ] as const)("handles lost D1 commit responses for %s feedback (%s)", async (source, savedWrite) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    let loseCommitResponse = false
    const uncertainD1 = {
      ...d1,
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await d1.batch(statements)
        if (loseCommitResponse) {
          loseCommitResponse = false
          // A different committed operation or payload must not be claimed as this edit.
          if (savedWrite === "other-operation")
            db.prepare("UPDATE meal_plan_version SET feedback_batch_id = 'other-operation' WHERE version = 2").run()
          if (savedWrite === "different-candidate") {
            const row = db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 2").get() as {
              candidate_json: string
            }
            const saved = JSON.parse(row.candidate_json)
            saved.grid.Mon.snack1.dish = "a different meal"
            db.prepare("UPDATE meal_plan_version SET candidate_json = ? WHERE version = 2").run(JSON.stringify(saved))
          }
          throw new Error("D1 commit response lost")
        }
        return results
      },
    } as D1Database
    const { namespace, registrations } = fakeRouter()
    const env = makeEnv(namespace, uncertainD1)
    const original = mealEvent(invokedAtMs)
    const base = seedCandidate()
    const revised = revisionPatch("Mon", "snack1", SEED_MEAL_IDS["vegetable cutlet"])
    const feedback = {
      id: source === "mini-app" ? "mini-1" : "telegram-reply-300-1",
      text: "Use vegetable cutlet.",
      scope: { day: "Mon", slot: "snack1" },
    }
    const network = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(revised, [feedback]) }]),
    ])
    await runAgentCenteredMealPlanningWorkflow(env, original, createMemoizingStep([], invokedAtMs) as never)
    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    if (!active) throw new Error("missing saved plan")
    if (source === "mini-app") {
      expect(
        (
          await store.acceptFeedbackBatch({
            batchId: "uncertain-batch",
            planId: active.plan.planId,
            chatId: CHAT,
            baseVersion: 1,
            workflowInstanceId: original.instanceId,
            idempotencyKey: "uncertain",
            items: [{ text: feedback.text, target: { kind: "cell", day: "Mon", slot: "snack1" } }],
          })
        ).ok,
      ).toBe(true)
      await store.markFeedbackBatchDelivered("uncertain-batch")
    }
    const event = {
      ...original,
      instanceId: "uncertain-edit",
      payload: {
        ...original.payload,
        edit: {
          planInstanceId: original.instanceId,
          userId: "42",
          feedback: {
            interactionKind: source === "mini-app" ? "meal-feedback-submission" : "meal-feedback-reply",
            source,
            ...(source === "mini-app"
              ? { feedbackBatchId: "uncertain-batch", baseVersion: 1 }
              : { items: [feedback], messageId: 300 }),
          },
        },
      },
    } as WorkflowEvent<MealPlanningWorkflowParams>
    const step = createMemoizingStep([], invokedAtMs)
    const execute = step.do.getMockImplementation()
    if (!execute) throw new Error("missing step implementation")
    step.do.mockImplementation(async (name, fn) => {
      if (name === "meal-planning-promote-revision-0") loseCommitResponse = true
      return execute(name, fn)
    })
    await runMealPlanningEditWorkflow(env, event, step as never)
    expect((await store.activePlan(CHAT))?.plan.currentVersion).toBe(2)
    expect((await store.activePlan(CHAT))?.version.candidate.grid.Mon.snack1.dish).toBe(
      savedWrite === "different-candidate" ? "a different meal" : "vegetable cutlet",
    )
    expect((await store.loadOrCreateProfile(CHAT)).interactionGeneration).toBe(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
    const confirmed = savedWrite === "own-write"
    expect(registrations.filter((r) => r.kind === "meal-feedback")).toHaveLength(confirmed ? 2 : 1)
    expect(network.telegramMessages.filter((m) => m.text.includes("School week of"))).toHaveLength(confirmed ? 2 : 1)
    if (confirmed)
      expect(network.telegramMessages.map((m) => m.text).join(" ")).not.toMatch(/couldn't|not applied|out of date/i)
    expect(network.deepseekBodies).toHaveLength(4)
  })

  it.each([
    "busy",
    "provider-failure",
    "promotion-failure",
  ])("terminalizes a Mini App batch on %s and prevents duplicate revision on retry", async (failure) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const env = makeEnv(namespace, d1, { LLM_MAX_RETRIES: "0" })
    const original = mealEvent(invokedAtMs)
    const base = seedCandidate()
    stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])
    await runAgentCenteredMealPlanningWorkflow(env, original, createFakeStep([], invokedAtMs) as never)
    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    if (!active) throw new Error("missing saved plan")
    expect(
      (
        await store.acceptFeedbackBatch({
          batchId: "failed-batch",
          planId: active.plan.planId,
          chatId: CHAT,
          baseVersion: 1,
          workflowInstanceId: original.instanceId,
          idempotencyKey: "failed-batch",
          items: [{ text: "Use idli instead.", target: { kind: "cell", day: "Mon", slot: "snack1" } }],
        })
      ).ok,
    ).toBe(true)
    await store.markFeedbackBatchDelivered("failed-batch")
    const router = createInteractionRouter(namespace, CHAT)
    if (failure === "busy") await router.claimEdit(`meal:${original.instanceId}`, "other-edit", "meal")
    const revised = revisionPatch("Mon", "snack1", SEED_MEAL_IDS["vegetable cutlet"])
    const network = stubNetwork(
      failure === "promotion-failure"
        ? [
            deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
            deepseekResponse([
              {
                name: "propose_plan",
                input: proposeInput(revised, [
                  { id: "mini-1", text: "Use idli instead.", scope: { day: "Mon", slot: "snack1" } },
                ]),
              },
            ]),
          ]
        : [],
    )
    const event = {
      ...original,
      instanceId: "failed-edit",
      payload: {
        ...original.payload,
        edit: {
          planInstanceId: original.instanceId,
          userId: "42",
          feedback: {
            interactionKind: "meal-feedback-submission",
            source: "mini-app",
            feedbackBatchId: "failed-batch",
            baseVersion: 1,
          },
        },
      },
    } as WorkflowEvent<MealPlanningWorkflowParams>
    const step = createMemoizingStep([], invokedAtMs)
    const execute = step.do.getMockImplementation()
    if (!execute) throw new Error("missing step implementation")
    step.do.mockImplementation(async (name, fn) => {
      if (failure === "promotion-failure" && name.startsWith("meal-planning-promote-"))
        throw new Error("D1 unavailable")
      return execute(name, fn)
    })
    await runMealPlanningEditWorkflow(env, event, step as never)
    expect((await store.feedbackBatch("failed-batch"))?.status).toBe("failed")
    expect((await store.activePlan(CHAT))?.plan.currentVersion).toBe(1)
    const requests = network.deepseekBodies.length
    if (failure === "busy") await router.releaseEdit(`meal:${original.instanceId}`, "other-edit")
    expect(await router.claimEdit(`meal:${original.instanceId}`, "probe", "meal")).toEqual({ ok: true })
    await router.releaseEdit(`meal:${original.instanceId}`, "probe")
    await runMealPlanningEditWorkflow(
      env,
      { ...event, instanceId: "batch-redelivery" },
      createMemoizingStep([], invokedAtMs) as never,
    )
    expect(network.deepseekBodies).toHaveLength(requests)
    expect((await store.feedbackBatch("failed-batch"))?.status).toBe("failed")
    expect((await store.activePlan(CHAT))?.plan.currentVersion).toBe(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
  })

  it.each([
    "meal-planning-promote-revision-0",
    "meal-planning-send-plan-revision-0",
    "meal-planning-register-feedback-revision-0",
  ])("resumes a suspended meal edit at %s without failing its batch or repeating promotion", async (boundary) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace, registrations } = fakeRouter()
    const env = makeEnv(namespace, d1)
    const original = mealEvent(invokedAtMs)
    const base = seedCandidate()
    const revised = revisionPatch("Mon", "snack1", SEED_MEAL_IDS["vegetable cutlet"])
    const network = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(revised, [
            { id: "mini-1", text: "Use idli instead.", scope: { day: "Mon", slot: "snack1" } },
          ]),
        },
      ]),
    ])
    await runAgentCenteredMealPlanningWorkflow(env, original, createFakeStep([], invokedAtMs) as never)
    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    if (!active) throw new Error("missing saved plan")
    expect(
      (
        await store.acceptFeedbackBatch({
          batchId: "recovery-batch",
          planId: active.plan.planId,
          chatId: CHAT,
          baseVersion: 1,
          workflowInstanceId: original.instanceId,
          idempotencyKey: "recovery-batch",
          items: [{ text: "Use idli instead.", target: { kind: "cell", day: "Mon", slot: "snack1" } }],
        })
      ).ok,
    ).toBe(true)
    await store.markFeedbackBatchDelivered("recovery-batch")
    const event = {
      ...original,
      instanceId: "suspended-edit",
      payload: {
        ...original.payload,
        edit: {
          planInstanceId: original.instanceId,
          userId: "42",
          feedback: {
            interactionKind: "meal-feedback-submission",
            source: "mini-app",
            feedbackBatchId: "recovery-batch",
            baseVersion: 1,
          },
        },
      },
    } as WorkflowEvent<MealPlanningWorkflowParams>
    const step = createMemoizingStep([], invokedAtMs)
    const execute = step.do.getMockImplementation()
    if (!execute) throw new Error("missing step implementation")
    let suspend = true
    const signal = new Error("Aborting engine: User called pause")
    step.do.mockImplementation(async (name, fn) => {
      if (suspend && name === boundary) throw signal
      return execute(name, fn)
    })
    await expect(runMealPlanningEditWorkflow(env, event, step as never)).rejects.toBe(signal)
    const promoted = !boundary.includes("promote")
    expect((await store.feedbackBatch("recovery-batch"))?.status).toBe(promoted ? "consumed" : "processing")
    expect((await store.activePlan(CHAT))?.plan.currentVersion).toBe(promoted ? 2 : 1)
    const router = createInteractionRouter(namespace, CHAT)
    expect(await router.claimEdit(`meal:${original.instanceId}`, "competitor", "meal")).toEqual({ ok: false })
    const requestCount = network.deepseekBodies.length
    const competingEvent = {
      ...event,
      instanceId: "competing-edit",
      payload: {
        ...event.payload,
        edit: {
          planInstanceId: original.instanceId,
          userId: "42",
          feedback: {
            interactionKind: "meal-feedback-reply",
            source: "telegram-reply",
            text: "Change another meal",
            messageId: 300,
          },
        },
      },
    } as WorkflowEvent<MealPlanningWorkflowParams>
    await runMealPlanningEditWorkflow(env, competingEvent, createMemoizingStep([], invokedAtMs) as never)
    expect(network.deepseekBodies).toHaveLength(requestCount)
    suspend = false
    await runMealPlanningEditWorkflow(env, event, step as never)
    expect((await store.activePlan(CHAT))?.plan.currentVersion).toBe(2)
    expect((await store.feedbackBatch("recovery-batch"))?.status).toBe("consumed")
    expect(network.deepseekBodies).toHaveLength(4)
    expect(registrations.filter((r) => r.kind === "meal-feedback")).toHaveLength(2)
    expect(network.telegramMessages.filter((m) => m.text.includes("School week of"))).toHaveLength(2)
    expect(network.telegramMessages.some((m) => /couldn't|not applied/i.test(m.text))).toBe(false)
    expect(await router.claimEdit(`meal:${original.instanceId}`, "after-recovery", "meal")).toEqual({ ok: true })
    await router.releaseEdit(`meal:${original.instanceId}`, "after-recovery")
    vi.setSystemTime(Date.parse(active.plan.weekEnd) + 1)
    await runMealPlanningEditWorkflow(env, event, step as never)
    expect(network.deepseekBodies).toHaveLength(4)
    expect(network.telegramMessages.filter((m) => m.text.includes("School week of"))).toHaveLength(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
    expect((await store.activePlan(CHAT))?.plan.currentVersion).toBe(2)
  })

  it("completes generation without a timer and replays after week end without regenerating", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const base = seedCandidate()
    const { telegramMessages, deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])
    const cache = new Map<string, unknown>()
    const timedOut = new Set<string>()
    const durations: number[] = []
    const step = {
      do: vi.fn(async (name: string, fn: () => unknown) => {
        if (!cache.has(name)) cache.set(name, structuredClone(await fn()))
        return structuredClone(cache.get(name))
      }),
      waitForEvent: vi.fn(async (name: string, options: { timeout: string }) => {
        if (!timedOut.has(name)) {
          const seconds = Number.parseInt(options.timeout, 10)
          durations.push(seconds)
          vi.setSystemTime(Date.now() + seconds * 1000)
          timedOut.add(name)
        }
        throw workflowTimeoutError()
      }),
    }
    const env = makeEnv(namespace, d1)
    const event = mealEvent(invokedAtMs)
    await runAgentCenteredMealPlanningWorkflow(env, event, step as never)
    const store = createMealPlanningStore(d1)
    const saved = await store.activePlan(CHAT)
    expect(durations).toEqual([])
    expect(step.waitForEvent).not.toHaveBeenCalled()
    expect(Date.now()).toBe(invokedAtMs)
    vi.setSystemTime(Date.now() + 8 * 86_400_000)
    await runAgentCenteredMealPlanningWorkflow(env, event, step as never)
    expect(await store.activePlan(CHAT)).toEqual(saved)
    expect(deepseekBodies).toHaveLength(2)
    expect(telegramMessages.filter((message) => message.text.includes("School week of"))).toHaveLength(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)
  })

  it("persists plan v1, registers feedback, and completes without waiting", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z") // Wed 09-09
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace, registrations } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    expect(active?.plan.weekStart).toBe(week.weekStart)
    expect(active?.plan.weekEnd).toBe(week.weekEnd)
    expect(active?.plan.instanceId).toBe("wf-meal-1")
    expect(active?.version.version).toBe(1)
    expect(active?.version.requestKind).toBe("initial_plan")
    // Two provider turns (evaluate + propose), one token each, under the meal model.
    expect(active?.version.usage).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      model: "~openai/gpt-luna-latest",
      costUsd: null,
    })
    const planId = active?.plan.planId
    if (!planId) throw new Error("expected a persisted plan id")
    expect(await store.sumPlanUsage(planId)).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      byModel: [{ inputTokens: 2, outputTokens: 2, model: "~openai/gpt-luna-latest", costUsd: null }],
    })
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)

    const planMessage = telegramMessages.find((message) => message.text.includes("School week of"))
    expect(planMessage).toBeTruthy()
    expect(planMessage?.text).toContain("Cost unavailable: OpenRouter did not report the complete usage cost")
    expect(planMessage?.text).toContain("2 in / 2 out")
    expect(planMessage?.replyMarkup).toBeTruthy()
    expect(registrations).toContainEqual(
      expect.objectContaining({
        kind: "meal-feedback",
        version: 1,
        generation: 1,
        workflowId: "wf-meal-1",
        interactionGroup: "meal-planning",
      }),
    )
  })

  it.each([
    0.002,
    0,
    null,
  ])("persists complete version cost only when classifier cost is available (%s)", async (decisionsCost) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const store = createMealPlanningStore(d1)
    const profile = await store.loadOrCreateProfile(CHAT)
    const firstDefinition = profile.profile.mealDefinitions?.[0]
    if (!firstDefinition) throw new Error("expected fixture definitions")
    firstDefinition.requiredIngredients = ["carrot"]
    firstDefinition.principalIngredients = ["carrot"]
    db.prepare("UPDATE meal_profile SET profile_json = ? WHERE chat_id = ?").run(JSON.stringify(profile.profile), CHAT)
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    base.easyBuys.push("carrot")
    const evaluate = deepseekResponse([{ name: "evaluate_meal_plan", input: base }])
    const propose = deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }])
    const { telegramMessages } = stubNetwork(
      [
        { ...evaluate, usage: { ...evaluate.usage, cost: 0.01 } },
        { ...propose, usage: { ...propose.usage, cost: 0.02 } },
      ],
      decisionsCost,
    )
    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
    const active = await store.activePlan(CHAT)
    if (decisionsCost === null) {
      expect(active?.version.usage?.costUsd).toBeNull()
      expect(d1Scalar(db, "SELECT cost_usd FROM meal_plan_version")).toBeNull()
    } else {
      expect(active?.version.usage?.costUsd).toBeCloseTo(0.03 + decisionsCost)
      expect(d1Scalar(db, "SELECT cost_usd FROM meal_plan_version")).toBeCloseTo(0.03 + decisionsCost)
    }
    const planMessage = telegramMessages.find((message) => message.text.includes("School week of"))
    expect(planMessage?.text).toContain(
      decisionsCost === null ? "Cost unavailable" : `Cost: $${(0.03 + decisionsCost).toFixed(4)}`,
    )
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/alpha/decisions"))).toHaveLength(1)
  })

  it("does not expose a prior plan's provisional meals to a new initial plan", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const store = createMealPlanningStore(d1)
    await store.loadOrCreateProfile(CHAT)
    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "prior-workflow",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })
    const priorGrid = Object.fromEntries(
      DAYS.map((day) => [
        day,
        Object.fromEntries(
          Object.keys(SLOT_COOK).map((slot) => [
            slot,
            { dish: "old invented meal", items: ["salt"], cookMinutes: 0, vegetarian: true, priorNightPrep: false },
          ]),
        ),
      ]),
    )
    await store.createActivePlan({
      planId: "prior-plan",
      chatId: CHAT,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      timezone: TZ,
      instanceId: "prior-workflow",
      generationId: "prior-workflow",
      candidate: {
        grid: priorGrid,
        easyBuys: [],
        policyOutcomes: {},
      } as never,
      evaluation: { pass: true, failures: [], measurements: {} } as never,
      weeklyInventory: { items: [], notes: [] },
      weeklyExceptions: { items: [] },
      provisionalMealDefinitions: [
        {
          id: "provisional_old",
          status: "provisional",
          name: "Old invented meal",
          principalIngredients: ["old ingredient"],
          vegetarian: true,
          suitableSlots: ["breakfast"],
          packedFood: { suitable: false, dry: false },
          typicalCookMinutes: 10,
          priorNightPrep: "none",
          requiredIngredients: ["salt", "cumin"],
          optionalIngredients: [],
          allowedIngredientChoices: [],
        },
      ],
    })
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    expect(deepseekBodies[0]?.messages.at(-1)?.content).not.toContain("provisional_old")
    expect(deepseekBodies[0]?.messages.at(-1)?.content).toContain("Plan-local provisional definitions")
    expect(deepseekBodies[0]?.messages.at(-1)?.content).toContain("none")
  })

  it.each([
    [7, true],
    [14, false],
  ])("resets week-scoped context and compares only the immediately prior week (%i days ago)", async (daysAgo, hasPriorWeek) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z") // Wed 09-09
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const priorWeek = resolvePlanningWeek(invokedAtMs - daysAgo * 24 * 60 * 60 * 1000, TZ)
    const store = createMealPlanningStore(d1)
    await store.loadOrCreateProfile(CHAT)
    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "prior-week-workflow",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })
    const priorGrid = Object.fromEntries(
      DAYS.map((day) => [
        day,
        Object.fromEntries(
          Object.keys(SLOT_COOK).map((slot) => [
            slot,
            { dish: "old week dish", items: ["salt"], cookMinutes: 0, vegetarian: true, priorNightPrep: false },
          ]),
        ),
      ]),
    )
    await store.createActivePlan({
      planId: "prior-week-plan",
      chatId: CHAT,
      weekStart: priorWeek.weekStart,
      weekEnd: priorWeek.weekEnd,
      timezone: TZ,
      instanceId: "prior-week-workflow",
      generationId: "prior-week-workflow",
      candidate: { grid: priorGrid, easyBuys: [], policyOutcomes: {} } as never,
      evaluation: { pass: true, failures: [], measurements: {} } as never,
      weeklyInventory: {
        items: [
          { name: "peas", status: "available" },
          { name: "idli batter", status: "available" },
          { name: "french beans", status: "available" },
        ],
        notes: [],
      },
      weeklyExceptions: {
        items: [{ kind: "school_closed", appliesTo: { day: "Mon" }, instruction: "Prior-week holiday" }],
      },
      provisionalMealDefinitions: [],
    })
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const firstPrompt = deepseekBodies[0]?.messages.at(-1)?.content ?? ""
    expect(firstPrompt.includes("old week dish")).toBe(hasPriorWeek)
    expect(firstPrompt.includes("Previous week's dishes")).toBe(hasPriorWeek)
    expect(firstPrompt).toContain("Weekly inventory: none")
    expect(firstPrompt).not.toContain("Weekly exceptions:")
    expect(firstPrompt).not.toContain("idli batter")
    expect(firstPrompt).not.toContain("Prior-week holiday")

    const active = await store.activePlan(CHAT)
    expect(active?.plan.weekStart).toBe(week.weekStart)
    expect(active?.plan.weeklyInventory.items).toEqual([])
    expect(active?.plan.weeklyExceptions.items).toEqual([])
  })

  it("keeps week-scoped inventory and holidays for a same-week re-invocation", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z") // Wed 09-09
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const store = createMealPlanningStore(d1)
    await store.loadOrCreateProfile(CHAT)
    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "same-week-workflow",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })
    const priorGrid = Object.fromEntries(
      DAYS.map((day) => [
        day,
        Object.fromEntries(
          Object.keys(SLOT_COOK).map((slot) => [
            slot,
            { dish: "old week dish", items: ["salt"], cookMinutes: 0, vegetarian: true, priorNightPrep: false },
          ]),
        ),
      ]),
    )
    await store.createActivePlan({
      planId: "same-week-plan",
      chatId: CHAT,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      timezone: TZ,
      instanceId: "same-week-workflow",
      generationId: "same-week-workflow",
      candidate: { grid: priorGrid, easyBuys: [], policyOutcomes: {} } as never,
      evaluation: { pass: true, failures: [], measurements: {} } as never,
      weeklyInventory: { items: [{ name: "peas", status: "available" }], notes: [] },
      weeklyExceptions: {
        items: [{ kind: "school_closed", appliesTo: { day: "Mon" }, instruction: "Same-week holiday" }],
      },
      provisionalMealDefinitions: [],
    })
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const firstPrompt = deepseekBodies[0]?.messages.at(-1)?.content ?? ""
    expect(firstPrompt).toContain("Weekly inventory: peas")
    expect(firstPrompt).toContain("Weekly exceptions:")
    expect(firstPrompt).not.toContain("Previous week's dishes")

    const active = await store.activePlan(CHAT)
    expect(active?.plan.weeklyInventory.items).toEqual([{ name: "peas", status: "available" }])
    expect(active?.plan.weeklyExceptions.items).toEqual([
      { kind: "school_closed", appliesTo: { day: "Mon" }, instruction: "Same-week holiday" },
    ])
  })

  it.each([
    "skipped",
    "reported",
    "failed",
  ] as const)("accounts for %s extraction before successful planning", async (extraction) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    const extractionResponse = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "extract-1",
                function: {
                  name: "extract_week_context",
                  arguments:
                    extraction === "failed"
                      ? "{malformed"
                      : JSON.stringify({ inventoryChanges: [], exceptionAdds: [] }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.005 },
    }
    const evaluate = deepseekResponse([{ name: "evaluate_meal_plan", input: base }])
    const propose = deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }])
    const { telegramMessages, deepseekBodies } = stubNetwork([
      ...(extraction === "skipped" ? [] : [extractionResponse]),
      { ...evaluate, usage: { ...evaluate.usage, cost: 0.01 } },
      { ...propose, usage: { ...propose.usage, cost: 0.02 } },
    ])
    await runAgentCenteredMealPlanningWorkflow(
      makeEnv(namespace, d1, { LLM_MAX_RETRIES: "0" }),
      mealEvent(invokedAtMs, extraction === "skipped" ? "" : "Plan this week."),
      step as never,
    )
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.version.version).toBe(1)
    expect(deepseekBodies).toHaveLength(extraction === "skipped" ? 2 : 3)
    const planMessage = telegramMessages.find((message) => message.text.includes("School week of"))
    if (extraction === "failed") {
      expect(active?.version.usage?.costUsd).toBeNull()
      expect(d1Scalar(db, "SELECT cost_status FROM meal_plan_version")).toBe("unavailable")
      expect(planMessage?.text).toContain("Cost unavailable")
    } else {
      // The packed-meal semantic validation is batched into one Decisions call
      // and its returned cost is included with extraction and planner usage.
      const expectedCost = extraction === "skipped" ? 0.032 : 0.037
      expect(active?.version.usage?.costUsd).toBeCloseTo(expectedCost)
      expect(d1Scalar(db, "SELECT cost_status FROM meal_plan_version")).toBe("reported")
      expect(planMessage?.text).toContain(`Cost: $${expectedCost.toFixed(4)}`)
    }
  })

  it("applies extracted initial inventory before evaluating and persisting the plan", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    delete base.grid.Fri["school-lunch"]
    delete base.grid.Fri.snack2
    const logSpy = vi.spyOn(console, "log")
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([
        {
          name: "extract_week_context",
          input: {
            inventoryChanges: [
              { name: "carrots", status: "available" },
              { name: "paneer", status: "unavailable" },
            ],
            exceptionAdds: [
              {
                kind: "half_day",
                appliesTo: { day: "Fri", mealSlots: ["school-lunch"] },
                instruction: "No school lunch on Friday.",
              },
            ],
          },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await runAgentCenteredMealPlanningWorkflow(
      makeEnv(namespace, d1),
      mealEvent(invokedAtMs, "Plan this week. I have carrots and do not have paneer."),
      step as never,
    )

    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.weeklyInventory.items).toEqual([
      { name: "carrot", status: "available" },
      { name: "paneer", status: "unavailable" },
    ])
    expect(active?.plan.weeklyExceptions.items).toEqual([
      {
        kind: "half_day",
        appliesTo: { day: "Fri" },
        instruction: "No school lunch on Friday.",
      },
    ])
    expect(deepseekBodies[1].messages.at(-1)?.content).toContain("Weekly inventory: carrot, paneer (unavailable)")
    const extractionLog = logSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((line) => line.event === "meal-planning-context-extraction")
    expect(extractionLog).toMatchObject({
      outcome: "succeeded",
      details: {
        applied: true,
        inventoryChangeCount: 2,
        exceptionAddCount: 1,
      },
    })
  })

  it("adds a Mini App review button only after persisting its private-chat context", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const base = seedCandidate()
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await runAgentCenteredMealPlanningWorkflow(
      makeEnv(namespace, d1, {
        MINI_APP_ORIGIN: "https://mini-app.example.test/ignored-path?ignored=query",
        TELEGRAM_ALLOWED_USER_ID: "parent-123",
      }),
      mealEvent(invokedAtMs),
      step as never,
    )

    const planMessage = telegramMessages.find((message) => message.text.includes("School week of"))
    expect(planMessage).toBeTruthy()
    if (!planMessage) throw new Error("Expected persisted plan message")
    const buttons = (planMessage.replyMarkup as { inline_keyboard: Array<Array<Record<string, unknown>>> })
      .inline_keyboard
    expect(buttons.every((row) => row.length === 1)).toBe(true)
    expect(buttons.flat()).toEqual([
      expect.objectContaining({ text: "Give feedback" }),
      { text: "Review this week's plan", web_app: { url: "https://mini-app.example.test/mini-app" } },
    ])
    const context = await createMealPlanningStore(d1).resolveMiniAppReviewContext("parent-123")
    expect(context).toEqual(
      expect.objectContaining({ chatId: CHAT, planId: expect.any(String), weekEnd: week.weekEnd }),
    )
  })

  it("turns a feedback reply into a version-2 revision with an immutable submission batch", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace, registrations } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const revised = revisionPatch("Mon", "snack1", SEED_MEAL_IDS["vegetable cutlet"])
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: "Mon snack: prefer idli",
          messageId: 200,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(revised, [{ id: "tg-200", text: "Mon snack: prefer idli" }]),
        },
      ]),
    ])

    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.version).toBe(2)
    expect(active?.version.requestKind).toBe("revision")
    expect(active?.version.feedbackBatchId).toBe("edit-0:revision-0")
    // The revision's own generation usage is recorded on its version row.
    expect(active?.version.usage).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      model: "~openai/gpt-luna-latest",
      costUsd: null,
    })
    // The v2 message reports the cumulative run total (v1 + v2 usage), like LinkedIn drafts.
    const planMessages = telegramMessages.filter((message) => message.text.includes("School week of"))
    expect(planMessages).toHaveLength(2)
    expect(planMessages[0]?.text).toContain("2 in / 2 out")
    expect(planMessages[1]?.text).toContain("4 in / 4 out")
    const v1 = db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 1").get() as {
      candidate_json: string
    }
    const persistedBase = JSON.parse(v1.candidate_json) as { grid: Record<string, Record<string, MealCell>> }
    expect(active?.version.candidate.grid.Mon.breakfast).toEqual(persistedBase.grid.Mon.breakfast)
    expect(active?.version.candidate.grid.Tue).toEqual(persistedBase.grid.Tue)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(telegramMessages.filter((message) => message.text.includes("School week of")).length).toBe(2)
    expect(registrations.filter((registration) => registration.kind === "meal-feedback").length).toBe(2)
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 1, generation: 1 }))
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 2, generation: 2 }))
  })

  it("promotes scoped feedback while repairing an untargeted cell invalidated by a new hard exclusion", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const store = createMealPlanningStore(d1)
    const initialProfile = await store.loadOrCreateProfile(CHAT)
    initialProfile.profile = {
      ...SEED_PROFILE,
      mealDefinitions: (SEED_PROFILE.mealDefinitions ?? []).map((definition) => ({
        ...definition,
        suitableSlots: Object.keys(SLOT_COOK),
        packedFood: { suitable: true, dry: true },
        typicalCookMinutes: 0,
        priorNightPrep: "none",
        principalIngredients: [],
        requiredIngredients: definition.id === SEED_MEAL_IDS.paratha ? ["peanut"] : [],
        optionalIngredients: [],
      })),
    }
    const safeMondayId = "test-safe-monday-breakfast"
    const safeRepairId = "test-safe-exclusion-repair"
    initialProfile.profile.mealDefinitions = [
      ...(initialProfile.profile.mealDefinitions ?? []),
      ...[
        { id: safeMondayId, name: "Unique Monday toast" },
        { id: safeRepairId, name: "Unique replacement porridge" },
      ].map((definition) => ({
        ...definition,
        principalIngredients: [],
        vegetarian: true as const,
        suitableSlots: ["breakfast"],
        packedFood: { suitable: false, dry: false },
        typicalCookMinutes: 0,
        priorNightPrep: "none" as const,
        requiredIngredients: [],
        optionalIngredients: [],
        status: "established" as const,
      })),
    ]
    initialProfile.profile.pantryBaseline = [...initialProfile.profile.pantryBaseline, "peanut"]
    db.prepare("UPDATE meal_profile SET profile_json = ? WHERE chat_id = ?").run(
      JSON.stringify(initialProfile.profile),
      CHAT,
    )
    const base = seedCandidate()
    const initialMeals = initialProfile.profile.mealDefinitions ?? []
    const usedMeals = new Set([safeMondayId, safeRepairId])
    base.grid = {}
    for (const day of DAYS) {
      base.grid[day] = {}
      const slots =
        day === "Sat"
          ? Object.keys(SLOT_COOK).filter((slot) => !["snack2", "school-lunch"].includes(slot))
          : Object.keys(SLOT_COOK)
      for (const slot of slots) {
        const definition =
          day === "Wed" && slot === "breakfast"
            ? initialMeals.find((meal) => meal.id === SEED_MEAL_IDS.paratha)
            : initialMeals.find(
                (meal) =>
                  !usedMeals.has(meal.id) &&
                  meal.status === "established" &&
                  meal.suitableSlots.includes(slot) &&
                  (!meal.halfDaySnack || (day === "Sat" && slot === "snack1")),
              )
        if (!definition) throw new Error(`missing unique initial meal for ${day} ${slot}`)
        base.grid[day][slot] = { mealDefinitionId: definition.id }
        usedMeals.add(definition.id)
      }
    }
    const feedbackText = "Mon breakfast: prefer Unique Monday toast"
    const patch = {
      grid: {
        Mon: { breakfast: { mealDefinitionId: safeMondayId } },
        Wed: { breakfast: { mealDefinitionId: safeRepairId } },
      },
    }
    const network = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: patch }]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(patch, [{ id: "tg-411", text: feedbackText }]),
        },
      ]),
    ])
    const env = makeEnv(namespace, d1)
    await runAgentCenteredMealPlanningWorkflow(env, mealEvent(invokedAtMs), createFakeStep([], invokedAtMs) as never)
    const activeBefore = await store.activePlan(CHAT)
    if (!activeBefore) throw new Error("missing generated plan")
    const previousGrid = structuredClone(activeBefore.version.candidate.grid)
    initialProfile.profile.dietaryExclusions = ["peanut"]
    db.prepare("UPDATE meal_profile SET profile_json = ? WHERE chat_id = ?").run(
      JSON.stringify(initialProfile.profile),
      CHAT,
    )
    const event = {
      ...mealEvent(invokedAtMs),
      instanceId: "edit-exclusion-repair",
      payload: {
        ...mealEvent(invokedAtMs).payload,
        edit: {
          planInstanceId: mealEvent(invokedAtMs).instanceId,
          userId: "42",
          feedback: {
            interactionKind: "meal-feedback-reply",
            source: "telegram-reply",
            text: feedbackText,
            messageId: 411,
          },
        },
      },
    } as WorkflowEvent<MealPlanningWorkflowParams>
    await runMealPlanningEditWorkflow(env, event, createMemoizingStep([], invokedAtMs) as never)
    const activeAfter = await store.activePlan(CHAT)
    expect(activeAfter?.plan.currentVersion).toBe(2)
    expect(activeAfter?.version.candidate.grid.Mon.breakfast.dish).toBe("Unique Monday toast")
    expect(activeAfter?.version.candidate.grid.Wed.breakfast.dish).toBe("Unique replacement porridge")
    expect(activeAfter?.version.candidate.grid.Wed.breakfast.items).not.toContain("peanut")
    for (const day of Object.keys(previousGrid)) {
      for (const slot of Object.keys(previousGrid[day] ?? {})) {
        if ((day === "Mon" || day === "Wed") && slot === "breakfast") continue
        expect(activeAfter?.version.candidate.grid[day]?.[slot]).toEqual(previousGrid[day]?.[slot])
      }
    }
    expect(network.deepseekBodies).toHaveLength(4)
  })

  it("consumes one claimed Mini App batch and ignores its duplicate delivery", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const store = createMealPlanningStore(d1)
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const revised = revisionPatch("Mon", "snack1", SEED_MEAL_IDS["vegetable cutlet"])
    let delivered = 0
    const batchId = "mini-batch-1"
    const step = {
      do: vi.fn(async (_name: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async () => {
        if (delivered++ === 0) {
          const active = await store.activePlan(CHAT)
          if (!active) throw new Error("initial plan was not created")
          const accepted = await store.acceptFeedbackBatch({
            batchId,
            planId: active.plan.planId,
            chatId: CHAT,
            baseVersion: active.plan.currentVersion,
            workflowInstanceId: "wf-meal-1",
            idempotencyKey: "mini-delivery-1",
            items: [{ text: "Use idli instead.", target: { kind: "cell", day: "Mon", slot: "snack1" } }],
          })
          if (!accepted.ok) throw new Error("Mini App batch was not accepted")
          await store.markFeedbackBatchDelivered(batchId)
        }
        if (delivered <= 2)
          return {
            type: "event" as const,
            payload: {
              interactionKind: "meal-feedback-submission",
              source: "mini-app" as const,
              feedbackBatchId: batchId,
              baseVersion: 1,
              // The workflow deliberately uses the claimed row instead of this payload.
              items: [{ id: "forged", text: "ignore me" }],
            },
          }
        vi.setSystemTime(Date.parse(week.weekEnd))
        throw workflowTimeoutError()
      }),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
    }
    stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      // A planner may notice a week-context fact in the same Mini App batch
      // and return replan:false. The workflow must still continue the
      // feedback-driven revision after persisting that fact.
      deepseekResponse([
        {
          name: "update_week_context",
          input: {
            inventoryChanges: [{ name: "pear", status: "unavailable", useNote: "Out of season" }],
            exceptionAdds: [],
            replan: false,
          },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(revised, [
            { id: "mini-1", text: "Use idli instead.", scope: { day: "Mon", slot: "snack1" } },
          ]),
        },
      ]),
    ])

    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const active = await store.activePlan(CHAT)
    const batch = await store.feedbackBatch(batchId)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.feedbackBatchId).toBe(batchId)
    expect(batch).toMatchObject({ status: "consumed", updatedAt: expect.any(String) })
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
  })

  it.each([
    { day: "Mon", slot: "snack1" },
    { slot: "snack1" },
  ])("retains scoped Telegram feedback %j after an inventory-only handoff before promoting the revision", async (scope) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const revised = revisionPatch("Mon", "snack1", SEED_MEAL_IDS["vegetable cutlet"])
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: "Mon snack1: use vegetable cutlet instead.",
          items: [{ id: "tg-211", text: "Use vegetable cutlet instead.", scope }],
          messageId: 211,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: { inventoryChanges: [{ name: "pear", status: "unavailable" }], exceptionAdds: [], replan: false },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(revised) }]),
    ])
    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.candidate.grid.Mon.snack1.dish).toBe("vegetable cutlet")
    const initial = db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 1").get() as {
      candidate_json: string
    }
    expect(active?.version.candidate.grid.Tue).toEqual(JSON.parse(initial.candidate_json).grid.Tue)
    expect(active?.plan.weeklyInventory.items).toContainEqual({ name: "pear", status: "unavailable" })
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(deepseekBodies).toHaveLength(5)
  })

  it.each([
    ...[" and ", ", ", " but ", " so "].flatMap((separator) => [
      { text: `We have no pears${separator}Friday should be lighter`, day: "Fri", slot: "breakfast" },
      { text: `We have no pears${separator}school lunch should be lighter`, day: "Mon", slot: "school-lunch" },
    ]),
    ...[" and ", ", "].flatMap((separator) => [
      { text: `We have no pears${separator}less oily meals for Friday`, day: "Fri", slot: "breakfast" },
      {
        text: `We have no pears${separator}more apples than Monday and Friday should be lighter`,
        day: "Fri",
        slot: "breakfast",
      },
    ]),
    { text: "Make Friday lighter. We have no pears.", day: "Fri", slot: "breakfast" },
    ...[" and ", ", "].flatMap((separator) => [
      ...["no repeat dishes this week", "avoid repeated meals", "without repeat dishes"].map((constraint) => ({
        text: `We have no pears${separator}${constraint}`,
        day: "Wed",
        slot: "breakfast",
      })),
      ...[
        "put vegetable cutlet on Friday breakfast",
        "include vegetable cutlet for Friday breakfast",
        "omit the planned dish on Friday breakfast",
        "change Friday breakfast to vegetable cutlet",
      ].map((instruction) => ({
        text: `Remove pears from inventory${separator}${instruction}`,
        day: "Fri",
        slot: "breakfast",
      })),
    ]),
    { text: "We have no pears. For Monday snack1, use vegetable cutlet instead.", day: "Mon", slot: "snack1" },
    { text: "We have no pears. Please trade the paratha for vegetable cutlet.", day: "Wed", slot: "breakfast" },
    { text: "No repeat dishes this week; we are out of pears.", day: "Wed", slot: "breakfast" },
    { text: "We have no pears, more variety for Friday lunch", day: "Fri", slot: "school-lunch" },
    { text: "Add the paneer from the pantry to Friday lunch", day: "Fri", slot: "school-lunch" },
    { text: "Make school lunch lighter; pears are out.", day: "Mon", slot: "school-lunch" },
    {
      text: "Remove pears from inventory before Friday and swap Monday snack1 to vegetable cutlet.",
      day: "Mon",
      slot: "snack1",
    },
  ])("preserves raw Telegram plan intent after a context-only handoff: $text", async ({ text, day, slot }) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const revised = revisionPatch(day, slot, SEED_MEAL_IDS["vegetable cutlet"])
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text,
          messageId: 211,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: { inventoryChanges: [{ name: "pear", status: "unavailable" }], exceptionAdds: [], replan: false },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(revised) }]),
    ])
    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.candidate.grid[day][slot].dish).toBe("vegetable cutlet")
    const initial = db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 1").get() as {
      candidate_json: string
    }
    expect(active?.version.candidate.grid.Tue).toEqual(JSON.parse(initial.candidate_json).grid.Tue)
    expect(active?.plan.weeklyInventory.items).toContainEqual({ name: "pear", status: "unavailable" })
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(deepseekBodies).toHaveLength(5)
  })

  it.each([
    { fact: "We have no pears.", instruction: "Replace poha and use idli instead.", calendar: false, replan: false },
    ...[false, true].flatMap((replan) => [
      { fact: "We have no pears.", instruction: "Use idli instead of poha.", calendar: false, replan },
      { fact: "Thursday is closed.", instruction: "Use idli instead of poha.", calendar: true, replan },
      {
        fact: "We have no pears.",
        instruction: "Use a lighter dish for Friday lunch instead of something heavy.",
        calendar: false,
        replan,
      },
      {
        fact: "We have no pears.",
        instruction: "Make poha lighter instead of something heavy.",
        calendar: false,
        replan,
      },
    ]),
  ])("preserves the requested new dish after a context handoff: $fact $instruction replan=$replan", async ({
    fact,
    instruction,
    calendar,
    replan,
  }) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    base.grid.Tue["school-lunch"] = { mealDefinitionId: SEED_MEAL_IDS["vegetable cutlet"] }
    const targetDay = instruction.includes("Friday") ? "Fri" : "Mon"
    const targetSlot = instruction.includes("Friday") ? "school-lunch" : "home-lunch"
    const revised = revisionPatch(targetDay, targetSlot, SEED_MEAL_IDS.idli)
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: `${fact} ${instruction}`,
          messageId: 214,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: {
            inventoryChanges: calendar ? [] : [{ name: "pear", status: "unavailable" }],
            exceptionAdds: calendar
              ? [{ kind: "school_closed", appliesTo: { day: "Thu" }, instruction: "Thursday is closed" }]
              : [],
            replan,
          },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(revised) }]),
    ])
    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
    const initial = JSON.parse(
      (db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 1").get() as { candidate_json: string })
        .candidate_json,
    )
    expect(initial.grid.Mon["home-lunch"].dish).toBe("poha")
    expect(
      Object.values(initial.grid)
        .flatMap((slots) => Object.values(slots as Record<string, MealCell>))
        .some((cell) => cell.dish === "idli"),
    ).toBe(false)
    expect(SEED_PROFILE.mealDefinitions?.some((definition) => definition.name === "idli")).toBe(true)
    const followUpText = deepseekBodies[3].messages.map((message) => message.content ?? "").join("\n")
    expect(followUpText).toContain(instruction)
    expect(followUpText).toContain(`Carry out the requested replan: ${instruction}`)
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.candidate.grid[targetDay][targetSlot].dish).toBe("idli")
    expect(active?.version.candidate.grid.Tue).toEqual(initial.grid.Tue)
    if (calendar) {
      expect(active?.version.candidate.grid.Thu).toBeUndefined()
      expect(active?.plan.weeklyExceptions.items).toContainEqual(
        expect.objectContaining({ kind: "school_closed", appliesTo: { day: "Thu" } }),
      )
    } else expect(active?.plan.weeklyInventory.items).toContainEqual({ name: "pear", status: "unavailable" })
    expect(deepseekBodies).toHaveLength(5)
  })

  it.each([
    "We have no pears.",
    "We have more pears than Monday and Friday.",
    "We have more pears than Monday, Friday.",
    ...[" and ", ", "].flatMap((separator) => [
      `We have more pears than Monday${separator}more apples than Friday.`,
      `We have more pears${separator}less paneer for Friday.`,
      `We have more pears${separator}fewer apples for Friday lunch.`,
      `We have more pears${separator}no more poha for Friday.`,
      `We have more pears${separator}2 more apples than Friday.`,
    ]),
    "We have more pears than we had on Monday.",
    "We have more pears for Monday breakfast.",
    "Remove pears from inventory; we ran out before Friday.",
    "Add pears to inventory for Friday lunch.",
    "We are out of pears.",
  ])("keeps raw inventory-only feedback on the no-revision path: %s", async (text) => {
    const status = text.includes("more") || text.startsWith("Add") ? "available" : "unavailable"
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text,
          messageId: 211,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: { inventoryChanges: [{ name: "pear", status }], exceptionAdds: [], replan: false },
        },
      ]),
    ])
    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(1)
    const initial = db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 1").get() as {
      candidate_json: string
    }
    expect(active?.version.candidate.grid.Tue).toEqual(JSON.parse(initial.candidate_json).grid.Tue)
    expect(active?.plan.weeklyInventory.items).toContainEqual({ name: "pear", status })
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)
    expect(deepseekBodies).toHaveLength(3)
  })

  it.each([
    "removed",
    "eligible",
    "move",
    "mixed",
    "calendar",
    "cell",
  ])("filters closed-day feedback without losing eligible replacements or moves (%s)", async (mode) => {
    const eligible = mode === "eligible"
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const fridayDish = mode === "move" ? "masala oats" : "vegetable cutlet"
    const revised = mode === "calendar" ? { grid: {} } : revisionPatch("Fri", "school-lunch", SEED_MEAL_IDS[fridayDish])
    if (eligible) revised.grid.Mon = { snack1: { mealDefinitionId: SEED_MEAL_IDS["sabudana cutlet"] } }
    const dish = eligible ? "banana" : "masala oats"
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: "Thursday is closed. Replace the dish and swap Friday lunch.",
          items:
            mode === "mixed"
              ? [
                  {
                    id: "mixed",
                    text: "Thursday is closed. Replace masala oats. Put vegetable cutlet on Friday lunch.",
                  },
                ]
              : mode === "calendar"
                ? [
                    { id: "closure", text: "Thursday is closed." },
                    { id: "dish", text: "Replace masala oats." },
                  ]
                : mode === "cell"
                  ? [
                      {
                        id: "cell",
                        text: "Use vegetable cutlet.",
                        target: { kind: "cell", day: "Fri", slot: "school-lunch" },
                      },
                    ]
                  : [
                      { id: "closure", text: "Thursday is closed." },
                      { id: "dish", text: mode === "move" ? "Move masala oats to another spot." : `Replace ${dish}.` },
                      ...(mode === "move"
                        ? []
                        : [{ id: "friday", text: `Use ${fridayDish}.`, scope: { day: "Fri", slot: "school-lunch" } }]),
                    ],
          messageId: 212,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: {
            inventoryChanges: [],
            exceptionAdds: [{ kind: "school_closed", instruction: "Thursday is closed", appliesTo: { day: "Thu" } }],
            replan: mode === "calendar",
          },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(revised) }]),
    ])
    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
    const initial = JSON.parse(
      (db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 1").get() as { candidate_json: string })
        .candidate_json,
    )
    expect(Object.values(initial.grid.Thu).some((cell) => (cell as MealCell).dish === "masala oats")).toBe(true)
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.candidate.grid.Thu).toBeUndefined()
    expect(active?.version.candidate.grid.Fri["school-lunch"].dish).toBe(
      mode === "calendar" ? initial.grid.Fri["school-lunch"].dish : fridayDish,
    )
    expect(active?.version.candidate.grid.Mon.snack1.dish).toBe(
      eligible ? "sabudana cutlet" : initial.grid.Mon.snack1.dish,
    )
    const followUpText = deepseekBodies[3].messages.map((message) => message.content ?? "").join("\n")
    if (["removed", "mixed", "calendar"].includes(mode)) expect(followUpText).not.toContain("Replace masala oats")
    else if (mode !== "cell")
      expect(followUpText).toContain(
        mode === "move"
          ? "- Plan-wide feedback: Move masala oats to another spot."
          : "- Plan-wide feedback: Replace banana.",
      )
    if (mode === "mixed") expect(followUpText).toContain("Put vegetable cutlet on Friday lunch")
    if (mode === "calendar") expect(followUpText).toContain("Reconcile the grid with the updated schedule")
    expect(deepseekBodies).toHaveLength(5)
  })

  it.each(
    [false, true].flatMap((replan) =>
      [
        "Use idli instead of poha.",
        "Make poha lighter instead of something heavy.",
        "Use idli for Friday lunch instead of poha.",
        "Use idli instead of poha for Friday lunch.",
      ].map((instruction) => ({
        replan,
        instruction,
      })),
    ),
  )("does not revive a projected-away target: $instruction replan=$replan", async ({ replan, instruction }) => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    base.grid.Mon["home-lunch"] = { mealDefinitionId: SEED_MEAL_IDS["vegetable cutlet"] }
    base.grid.Thu.breakfast = { mealDefinitionId: SEED_MEAL_IDS.poha }
    const fridayLunch = base.grid.Fri["school-lunch"]
    base.grid.Fri["school-lunch"] = base.grid.Tue["school-lunch"]
    base.grid.Tue["school-lunch"] = fridayLunch
    const revised = { grid: {} }
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: `Thursday is closed. ${instruction}`,
          messageId: 215,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: {
            inventoryChanges: [],
            exceptionAdds: [{ kind: "school_closed", appliesTo: { day: "Thu" }, instruction: "Thursday is closed" }],
            replan,
          },
        },
      ]),
      ...(replan
        ? [
            deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
            deepseekResponse([{ name: "propose_plan", input: proposeInput(revised) }]),
          ]
        : []),
    ])
    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
    const initial = JSON.parse(
      (db.prepare("SELECT candidate_json FROM meal_plan_version WHERE version = 1").get() as { candidate_json: string })
        .candidate_json,
    )
    expect(initial.grid.Thu.breakfast.dish).toBe("poha")
    expect(
      Object.entries(initial.grid)
        .filter(([day]) => day !== "Thu")
        .flatMap(([, slots]) => Object.values(slots as Record<string, MealCell>))
        .some((cell) => cell.dish === "poha"),
    ).toBe(false)
    expect(initial.grid.Fri["school-lunch"].dish).toBe("idli")
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(replan ? 2 : 1)
    expect(active?.plan.weeklyExceptions.items).toContainEqual(
      expect.objectContaining({ kind: "school_closed", appliesTo: { day: "Thu" } }),
    )
    expect(active?.version.candidate.grid.Fri).toEqual(initial.grid.Fri)
    expect(deepseekBodies).toHaveLength(replan ? 5 : 3)
    if (replan) {
      expect(active?.version.candidate.grid.Thu).toBeUndefined()
      const followUpText = deepseekBodies[3].messages.map((message) => message.content ?? "").join("\n")
      expect(followUpText).not.toContain(instruction)
      expect(followUpText).toContain("Reconcile the grid with the updated schedule")
    }
  })

  it("recognizes a dish restored by a full-day exception before deciding whether to revise", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const env = makeEnv(namespace, d1)
    const revised = revisionPatch("Thu", "school-lunch", SEED_MEAL_IDS["vegetable cutlet"])
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: {
            inventoryChanges: [],
            exceptionAdds: [
              { kind: "full_day", appliesTo: { day: "Thu" }, instruction: "Thursday is a full day this week" },
            ],
            replan: false,
          },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(revised) }]),
    ])
    await runAgentCenteredMealPlanningWorkflow(
      env,
      mealEvent(invokedAtMs),
      createFakeStep([], Date.parse(week.weekEnd)) as never,
    )
    // The saved plan predates a newly configured recurring Thursday half-day.
    db.prepare("UPDATE meal_profile SET schedule_json = ?").run(
      JSON.stringify({ ...SEED_SCHEDULE, halfDays: ["Thu", "Sat"] }),
    )
    const before = await createMealPlanningStore(d1).activePlan(CHAT)
    const dish = before?.version.candidate.grid.Thu["school-lunch"].dish
    expect(dish).toBeDefined()
    await runMealPlanningEditWorkflow(
      env,
      {
        ...mealEvent(invokedAtMs),
        instanceId: "edit-restored-cell",
        payload: {
          ...mealEvent(invokedAtMs).payload,
          edit: {
            planInstanceId: "wf-meal-1",
            userId: "42",
            feedback: {
              interactionKind: "meal-feedback-reply",
              source: "telegram-reply",
              text: `Thursday is a full day this week. Replace ${dish}.`,
              messageId: 213,
            },
          },
        },
      },
      createMemoizingStep([], Date.now()) as never,
    )
    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.candidate.grid.Thu["school-lunch"].dish).toBe("vegetable cutlet")
    expect(deepseekBodies).toHaveLength(5)
    expect(deepseekBodies[3].messages.map((message) => message.content ?? "").join("\n")).toContain(`Replace ${dish}`)
  })

  it("R09: records a reported next-day holiday without creating a revised plan", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z") // Wed; tomorrow is Thu
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: "Tomorrow is a holiday.",
          messageId: 209,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: {
            inventoryChanges: [],
            exceptionAdds: [
              { kind: "school_closed", instruction: "Tomorrow is a holiday.", appliesTo: { day: "Thu" } },
            ],
            replan: false,
          },
        },
      ]),
    ])

    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(1)
    expect(active?.plan.weeklyExceptions.items).toEqual([
      { kind: "school_closed", instruction: "Tomorrow is a holiday.", appliesTo: { day: "Thu" } },
    ])
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)
    expect(telegramMessages.some((message) => message.text === "Updated this week's meal-planning context.")).toBe(true)
  })

  it("R10: applies a next-day holiday then revises the remaining plan against that updated week", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z") // Wed; tomorrow is Thu
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const emptyPatch = { grid: {} }
    const step = createFakeStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: "Tomorrow is a holiday—recreate the remaining week using unused prep.",
          messageId: 210,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([
        {
          name: "update_week_context",
          input: {
            inventoryChanges: [],
            exceptionAdds: [
              {
                kind: "school_closed",
                instruction: "Tomorrow is a holiday—recreate the remaining week using unused prep.",
                appliesTo: { day: "Thu" },
              },
            ],
            replan: true,
          },
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: emptyPatch }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(emptyPatch) }]),
    ])

    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const active = await createMealPlanningStore(d1).activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.candidate.grid.Thu).toBeUndefined()
    expect(active?.version.candidate.grid.Wed.breakfast.dish).toBe("paratha")
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(telegramMessages.filter((message) => message.text.includes("School week of")).length).toBe(2)
  })

  it("completes two revisions under name-memoized steps, persisting v2 and v3 with fresh plan messages and registrations", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace, registrations } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const revised = revisionPatch("Mon", "snack1", SEED_MEAL_IDS["vegetable cutlet"])
    // The v3 candidate keeps the v2 Mon change and adds a Tue change.
    const revisedAgain = revisionPatch("Tue", "snack1", SEED_MEAL_IDS["sabudana cutlet"])
    // Every revision runs through distinct per-occurrence step names, so the
    // memoized runtime cannot return the initial plan's send/register/promote
    // results for v2/v3.
    const step = createMemoizingStep(
      [
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: "Mon snack: prefer idli",
          messageId: 200,
        },
        {
          interactionKind: "meal-feedback-reply",
          source: "telegram-reply",
          text: "Tue snack: prefer poha",
          messageId: 201,
        },
      ],
      Date.parse(week.weekEnd),
    )
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revised }]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(revised, [{ id: "tg-200", text: "Mon snack: prefer idli" }]),
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revisedAgain }]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(revisedAgain, [{ id: "tg-201", text: "Tue snack: prefer poha" }]),
        },
      ]),
    ])

    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(3)
    expect(active?.version.version).toBe(3)
    expect(active?.version.requestKind).toBe("revision")
    expect(active?.version.feedbackBatchId).toBe("edit-1:revision-0")
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(3)
    expect(telegramMessages.filter((message) => message.text.includes("School week of")).length).toBe(3)
    expect(registrations.filter((registration) => registration.kind === "meal-feedback").length).toBe(3)
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 1, generation: 1 }))
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 2, generation: 2 }))
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 3, generation: 3 }))
  })

  it("rejects expired, stale and foreign-owner edit runs without invoking the planner", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const env = makeEnv(namespace, d1)
    const event = mealEvent(invokedAtMs)
    const base = seedCandidate()
    const { deepseekBodies } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])
    await runAgentCenteredMealPlanningWorkflow(env, event, createFakeStep([], invokedAtMs) as never)
    const feedback = { interactionKind: "meal-feedback-reply" as const, text: "Move lunch", version: 0 }
    await runMealPlanningEditWorkflow(
      env,
      {
        ...event,
        instanceId: "stale",
        payload: { ...event.payload, edit: { planInstanceId: event.instanceId, userId: "42", feedback } },
      },
      createFakeStep([], invokedAtMs) as never,
    )
    await runMealPlanningEditWorkflow(
      env,
      {
        ...event,
        instanceId: "foreign",
        payload: {
          ...event.payload,
          edit: { planInstanceId: event.instanceId, userId: "other", feedback: { ...feedback, version: 1 } },
        },
      },
      createFakeStep([], invokedAtMs) as never,
    )
    vi.setSystemTime(Date.parse(resolvePlanningWeek(invokedAtMs, TZ).weekEnd))
    await runMealPlanningEditWorkflow(
      env,
      {
        ...event,
        instanceId: "expired",
        payload: {
          ...event.payload,
          edit: { planInstanceId: event.instanceId, userId: "42", feedback: { ...feedback, version: 1 } },
        },
      },
      createFakeStep([], Date.now()) as never,
    )
    expect(deepseekBodies).toHaveLength(2)
    expect((await createMealPlanningStore(d1).activePlan(CHAT))?.plan.currentVersion).toBe(1)
  })

  it("sends meal-agent-unavailable and persists nothing when the agent fails", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const { telegramMessages } = stubNetwork([proseResponse(), proseResponse(), proseResponse()])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const store = createMealPlanningStore(d1)
    expect(await store.activePlan(CHAT)).toBeNull()
    expect(telegramMessages.some((message) => message.text.includes("couldn't reach"))).toBe(true)
  })

  it("logs the session failure category when the agent fails", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    stubNetwork([proseResponse(), proseResponse(), proseResponse()])
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    let captured: unknown[] = []
    try {
      await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)
      captured = log.mock.calls.map((call) => call[0])
    } finally {
      log.mockRestore()
    }
    const sessionLine = captured.find(
      (entry) => typeof entry === "string" && entry.includes('"event":"meal-planning-agent-session"'),
    )
    expect(sessionLine).toContain('"outcome":"failed"')
    expect(sessionLine).toContain('"failureCategory":"missing-required-handoff"')
  })

  it("sends meal-agent-unavailable and persists nothing when the provider request fails", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const step = createFakeStep([], Date.parse(week.weekEnd))
    const telegramMessages: string[] = []
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("api.deepseek.com") || String(url).includes("openrouter.ai/api/v1"))
        throw new Error("upstream down")
      const body = JSON.parse((init?.body as string) ?? "{}") as { text: string }
      telegramMessages.push(body.text)
      return jsonResponse({ ok: true, result: { message_id: 1 } })
    })
    vi.stubGlobal("fetch", fetchMock)
    await runAgentCenteredMealPlanningWorkflow(
      { ...makeEnv(namespace, d1), LLM_MAX_RETRIES: "0" },
      mealEvent(invokedAtMs),
      step as never,
    )
    const store = createMealPlanningStore(d1)
    expect(await store.activePlan(CHAT)).toBeNull()
    expect(telegramMessages.some((text) => text.includes("couldn't reach"))).toBe(true)
  })

  it("keeps the saved same-week plan active when a replacement provider request fails", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const store = createMealPlanningStore(d1)
    await store.loadOrCreateProfile(CHAT)
    await store.startPlanGeneration({
      chatId: CHAT,
      generationId: "prior-generation",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })
    await store.createActivePlan({
      planId: "prior-same-week-plan",
      chatId: CHAT,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      timezone: TZ,
      instanceId: "prior-workflow",
      generationId: "prior-generation",
      candidate: { grid: {}, easyBuys: [], policyOutcomes: {} } as never,
      evaluation: { pass: true, failures: [], measurements: {} } as never,
      weeklyInventory: { items: [], notes: [] },
      weeklyExceptions: { items: [] },
    })

    const telegramMessages: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("api.deepseek.com") || String(url).includes("openrouter.ai/api/v1"))
          throw new Error("upstream down")
        const body = JSON.parse((init?.body as string) ?? "{}") as { text: string }
        telegramMessages.push(body.text)
        return jsonResponse({ ok: true, result: { message_id: 1 } })
      }),
    )

    const step = createFakeStep([], Date.parse(week.weekEnd))
    await runAgentCenteredMealPlanningWorkflow(
      { ...makeEnv(namespace, d1), LLM_MAX_RETRIES: "0" },
      mealEvent(invokedAtMs),
      step as never,
    )

    expect(await store.activePlan(CHAT)).toMatchObject({
      plan: { planId: "prior-same-week-plan", status: "active", currentVersion: 1 },
      version: { version: 1 },
    })
    expect(await store.listPlanHistory(CHAT)).toMatchObject([
      { plan: { planId: "prior-same-week-plan", status: "active" } },
    ])
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan")).toBe(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)
    expect(telegramMessages.some((text) => text.includes("couldn't reach"))).toBe(true)
  })

  it("delivers stale notices in independent edit runs with memoized steps", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    // Two stale button taps: each must send its own stale-plan notice even
    // though the memoized runtime would return an earlier same-named step's
    // result instead of delivering the second message.
    const base = seedCandidate()
    const step = createMemoizingStep(
      [
        { interactionKind: "meal-feedback", source: "telegram-reply", version: 0 },
        { interactionKind: "meal-feedback", source: "telegram-reply", version: 0 },
      ],
      Date.parse(week.weekEnd),
    )
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const stalePlans = telegramMessages.filter((message) => message.text.includes("already updated"))
    expect(stalePlans.length).toBe(2)
  })

  it("reports a stale feedback callback before the generation message during replacement", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { d1 } = createD1TestDb()
    const store = createMealPlanningStore(d1)
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    let delivered = false
    const step = {
      do: vi.fn(async (_name: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async () => {
        if (!delivered) {
          delivered = true
          const active = await store.activePlan(CHAT)
          if (!active) throw new Error("initial plan was not created")
          const promoted = await store.promotePlanVersion({
            planId: active.plan.planId,
            chatId: CHAT,
            baseVersion: 1,
            candidate: active.version.candidate,
            evaluation: active.version.evaluation,
            video: active.version.video,
            provisionalMealDefinitions: active.version.provisionalMealDefinitions,
            inventory: {
              weeklyInventory: active.plan.weeklyInventory,
              weeklyExceptions: active.plan.weeklyExceptions,
            },
            feedbackBatch: { batchId: "stale-callback", items: [{ id: "stale", text: "late feedback" }] },
          })
          if (!promoted.ok) throw new Error("replacement plan was not persisted")
          await store.startPlanGeneration({
            chatId: CHAT,
            generationId: "replacement-generation",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })
          return {
            type: "event" as const,
            payload: { interactionKind: "meal-feedback" as const, source: "telegram-reply" as const, version: 1 },
          }
        }
        vi.setSystemTime(Date.parse(week.weekEnd) + 1)
        throw workflowTimeoutError()
      }),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
    }
    const { telegramMessages } = stubNetwork([
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await generateThenEdit(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    expect(telegramMessages.some((message) => message.text.includes("already updated"))).toBe(true)
    expect(telegramMessages.some((message) => message.text.includes("being generated"))).toBe(false)
  })

  it("carries the clarification transcript into the next provider request", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    stubUuidSequence()
    const { d1 } = createD1TestDb()
    const { namespace } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    // The first randomUUID is the clarification interactionId, so the force-reply
    // event must carry `uuid-1` to be accepted as the matching reply.
    const step = createFakeStep(
      [{ interactionId: "uuid-1", source: "telegram-reply", text: "yes" }],
      Date.parse(week.weekEnd),
    )
    const base = seedCandidate()
    const { deepseekBodies } = stubNetwork([
      clarifyResponse("How many people should the week serve?"),
      deepseekResponse([{ name: "evaluate_meal_plan", input: base }]),
      deepseekResponse([{ name: "propose_plan", input: proposeInput(base) }]),
    ])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const store = createMealPlanningStore(d1)
    expect(await store.activePlan(CHAT)).not.toBeNull()
    const secondRequest = deepseekBodies[1]
    expect(secondRequest).toBeTruthy()
    const transcript = secondRequest.messages
    const assistantClarify = transcript.find(
      (message) => message.role === "assistant" && message.tool_calls?.[0]?.function?.name === "needs_clarification",
    )
    expect(assistantClarify).toBeTruthy()
    expect(
      transcript.some((message) => message.role === "tool" && message.tool_call_id === "needs_clarification"),
    ).toBe(true)
    expect(transcript.some((message) => message.role === "user" && message.content === "yes")).toBe(true)
    expect(deepseekBodies[0]?.messages.some((message) => message.role === "user" && message.content === "yes")).toBe(
      false,
    )
  })
})
