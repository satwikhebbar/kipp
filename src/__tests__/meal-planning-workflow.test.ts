import type { WorkflowEvent } from "cloudflare:workers"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { type MealPlanningLiveEvent, runAgentCenteredMealPlanningWorkflow } from "../meal-planning/agent-workflow"
import { createMealPlanningStore, SEED_MEAL_IDS, SEED_PROFILE } from "../meal-planning/store"
import type { MealCell, MealPlanSelectionCandidate } from "../meal-planning/types"
import { resolvePlanningWeek } from "../meal-planning/week"
import type { MealPlanningWorkflowParams } from "../meal-planning/workflow"
import { createD1TestDb, d1Count } from "./d1-test-db"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SLOT_COOK: Record<string, number> = { breakfast: 15, snack1: 0, snack2: 0, "school-lunch": 20, "home-lunch": 20 }
const POLICY_IDS = [
  "snack-policy",
  "equipment-gap",
  "packing-capacity",
  "nutrition-target-fruit",
  "nutrition-target-nuts",
  "school-rule",
  "cheat-day",
]
const CHAT = "chat-1"
const TZ = "Asia/Kolkata"

// Workflow fixtures intentionally reuse paratha in every slot. Keep that
// legacy fixture compact while giving its fixture definition stable metadata
// that makes those placements valid under the selection contract.
SEED_PROFILE.mealDefinitions = (SEED_PROFILE.mealDefinitions ?? []).map((definition) =>
  definition.id === SEED_MEAL_IDS.paratha
    ? { ...definition, packedFood: { suitable: true, dry: true }, typicalCookMinutes: 0 }
    : definition,
)

function cell(dish: string, items: string[], slot: string): MealCell {
  return { dish, vegetarian: true, items, cookMinutes: SLOT_COOK[slot], priorNightPrep: false }
}

function seedCandidate(override?: { day: string; slot: string; cell: MealCell }): MealPlanSelectionCandidate {
  const selectionBySlot: Record<string, string> = {
    breakfast: SEED_MEAL_IDS.paratha,
    snack1: SEED_MEAL_IDS.paratha,
    snack2: SEED_MEAL_IDS.paratha,
    "school-lunch": SEED_MEAL_IDS.paratha,
    "home-lunch": SEED_MEAL_IDS.paratha,
  }
  const grid: MealPlanSelectionCandidate["grid"] = {}
  for (const day of DAYS) {
    grid[day] = Object.fromEntries(Object.keys(SLOT_COOK).map((slot) => [slot, { mealDefinitionId: selectionBySlot[slot] }]))
  }
  if (override) grid[override.day][override.slot] = { mealDefinitionId: SEED_MEAL_IDS[override.cell.dish]! }
  return {
    grid,
    easyBuys: ["pomegranate", "apple"],
    policyOutcomes: Object.fromEntries(POLICY_IDS.map((id) => [id, { outcome: "satisfied", rationale: "ok" }])),
  }
}

function proposeInput(candidate: unknown, feedbackItems?: unknown) {
  return {
    candidate,
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [] },
    ...(feedbackItems ? { feedbackItems } : {}),
  }
}

function deepseekToolCall(name: string, input: unknown) {
  return { id: name, type: "function", function: { name, arguments: JSON.stringify(input) } }
}

function deepseekResponse(toolCalls: Array<{ name: string; input: unknown }>) {
  return {
    choices: [
      { message: { content: "", tool_calls: toolCalls.map((call) => deepseekToolCall(call.name, call.input)) } },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
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

function stubNetwork(deepseekResponses: unknown[]) {
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
    if (urlStr.includes("api.deepseek.com")) {
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
  const registrations: Array<Record<string, unknown>> = []
  const namespace = {
    idFromName: (name: string) => name as never,
    get: (_id: unknown) => ({
      fetch: async (url: string | Request, init?: RequestInit) => {
        const path = new URL(typeof url === "string" ? url : url.url).pathname
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>
        if (path === "/register") registrations.push(body)
        return jsonResponse({ ok: true })
      },
    }),
  } as unknown as DurableObjectNamespace
  return { namespace, registrations }
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
      return { type: "timeout" as const }
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
      return { type: "timeout" as const }
    }),
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
  }
}

function mealEvent(invokedAtMs: number): WorkflowEvent<MealPlanningWorkflowParams> {
  return {
    instanceId: "wf-meal-1",
    payload: { chatId: CHAT, telegramMessageId: 10, requestText: "", invokedAtMs },
  } as unknown as WorkflowEvent<MealPlanningWorkflowParams>
}

function makeEnv(namespace: DurableObjectNamespace, d1: D1Database): Env {
  return {
    TELEGRAM_BOT_TOKEN: "bot:token",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    LLM_MODEL: "deepseek-chat",
    LLM_MAX_RETRIES: "3",
    INTERACTION_ROUTER: namespace,
    MEAL_PLANNING_DB: d1,
    TIMEZONE: TZ,
    LOG_LEVEL: "info",
  } as unknown as Env
}

describe("runAgentCenteredMealPlanningWorkflow", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("persists plan v1, sends the plan message with a feedback button, and parks until week end", async () => {
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
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(1)

    const planMessage = telegramMessages.find((message) => message.text.includes("School week of"))
    expect(planMessage).toBeTruthy()
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

  it("turns a feedback reply into a version-2 revision with an immutable submission batch", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace, registrations } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const revised = seedCandidate({ day: "Mon", slot: "snack1", cell: cell("pomegranate", ["pomegranate"], "snack1") })
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
          input: proposeInput(revised, [
            { id: "tg-200", text: "Mon snack: prefer idli", scope: { day: "Mon", slot: "snack1" } },
          ]),
        },
      ]),
    ])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(2)
    expect(active?.version.version).toBe(2)
    expect(active?.version.requestKind).toBe("revision")
    expect(active?.version.feedbackBatchId).toBe(`${active?.plan.planId}:v2`)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(1)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(2)
    expect(telegramMessages.filter((message) => message.text.includes("School week of")).length).toBe(2)
    expect(registrations.filter((registration) => registration.kind === "meal-feedback").length).toBe(2)
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 1, generation: 1 }))
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 2, generation: 2 }))
  })

  it("completes two revisions under name-memoized steps, persisting v2 and v3 with fresh plan messages and registrations", async () => {
    vi.useFakeTimers()
    const invokedAtMs = Date.parse("2026-09-09T03:30:00.000Z")
    vi.setSystemTime(invokedAtMs)
    const { db, d1 } = createD1TestDb()
    const { namespace, registrations } = fakeRouter()
    const week = resolvePlanningWeek(invokedAtMs, TZ)
    const base = seedCandidate()
    const revised = seedCandidate({ day: "Mon", slot: "snack1", cell: cell("pomegranate", ["pomegranate"], "snack1") })
    // The v3 candidate keeps the v2 Mon change and adds a Tue change.
    const revisedAgain = {
      ...revised,
      grid: { ...revised.grid, Tue: { ...revised.grid.Tue, snack1: { mealDefinitionId: SEED_MEAL_IDS.apple } } },
    }
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
          input: proposeInput(revised, [
            { id: "tg-200", text: "Mon snack: prefer idli", scope: { day: "Mon", slot: "snack1" } },
          ]),
        },
      ]),
      deepseekResponse([{ name: "evaluate_meal_plan", input: revisedAgain }]),
      deepseekResponse([
        {
          name: "propose_plan",
          input: proposeInput(revisedAgain, [
            { id: "tg-201", text: "Tue snack: prefer poha", scope: { day: "Tue", slot: "snack1" } },
          ]),
        },
      ]),
    ])

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const store = createMealPlanningStore(d1)
    const active = await store.activePlan(CHAT)
    expect(active?.plan.currentVersion).toBe(3)
    expect(active?.version.version).toBe(3)
    expect(active?.version.requestKind).toBe("revision")
    expect(active?.version.feedbackBatchId).toBe(`${active?.plan.planId}:v3`)
    expect(d1Count(db, "SELECT count(*) AS count FROM feedback_batch")).toBe(2)
    expect(d1Count(db, "SELECT count(*) AS count FROM meal_plan_version")).toBe(3)
    expect(telegramMessages.filter((message) => message.text.includes("School week of")).length).toBe(3)
    expect(registrations.filter((registration) => registration.kind === "meal-feedback").length).toBe(3)
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 1, generation: 1 }))
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 2, generation: 2 }))
    expect(registrations).toContainEqual(expect.objectContaining({ kind: "meal-feedback", version: 3, generation: 3 }))
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
      if (String(url).includes("api.deepseek.com")) throw new Error("upstream down")
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

  it("delivers two distinct notifications in one instance under name-memoized steps", async () => {
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

    await runAgentCenteredMealPlanningWorkflow(makeEnv(namespace, d1), mealEvent(invokedAtMs), step as never)

    const stalePlans = telegramMessages.filter((message) => message.text.includes("already updated"))
    expect(stalePlans.length).toBe(2)
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
