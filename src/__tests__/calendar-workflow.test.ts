import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import type { Env } from "../core/types"
import type { ToolConversationMessage } from "../providers"

vitest.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
  }
  return { WorkflowEntrypoint }
})

const mockGenerate = vitest.hoisted(() => vitest.fn())
const mockBusyIntervals = vitest.hoisted(() => vitest.fn())
const mockListEvents = vitest.hoisted(() => vitest.fn())
const mockCreateManagedEvent = vitest.hoisted(() => vitest.fn())
const mockUpdateManagedEvent = vitest.hoisted(() => vitest.fn())
const mockReconcileManagedSeries = vitest.hoisted(() => vitest.fn())
const mockDeleteManagedEvent = vitest.hoisted(() => vitest.fn())
const mockFindConflictingEvents = vitest.hoisted(() => vitest.fn())
const mockMoveExistingEvent = vitest.hoisted(() => vitest.fn())
const MockGoogleCalendarError = vitest.hoisted(
  () =>
    class GoogleCalendarError extends Error {
      readonly kind: "authorization" | "transient" | "permanent"
      constructor(message: string, kind?: "authorization" | "transient" | "permanent") {
        super(message)
        this.kind = kind ?? (message as typeof this.kind)
      }
    },
)

vitest.mock("../providers", () => ({ createToolProvider: () => ({ generate: mockGenerate }) }))
vitest.mock("../integrations/google-calendar", () => ({
  createGoogleCalendarClient: () => ({
    getBusyIntervals: mockBusyIntervals,
    listEvents: mockListEvents,
    createManagedEvent: mockCreateManagedEvent,
    updateManagedEvent: mockUpdateManagedEvent,
    reconcileManagedSeries: mockReconcileManagedSeries,
    deleteManagedEvent: mockDeleteManagedEvent,
    findConflictingEvents: mockFindConflictingEvents,
    moveExistingEvent: mockMoveExistingEvent,
  }),
  GoogleCalendarError: MockGoogleCalendarError,
}))

import { CalendarWorkflow } from "../calendar/workflow"

const ONE_OFF = {
  kind: "one_off" as const,
  proposal: {
    title: "Call Jamie",
    localDate: "2026-07-28",
    startTime: "19:00",
    durationMinutes: 30,
    dateIsExplicit: true,
    timeIsExplicit: true,
    classification: "ordinary" as const,
    needsClarification: false,
  },
}

const RECURRING = {
  kind: "recurring" as const,
  proposal: {
    title: "Weekly review",
    firstDate: "2026-07-28",
    dateIsExplicit: true,
    startTime: "19:00",
    timeIsExplicit: true,
    durationMinutes: 30,
    classification: "ordinary" as const,
    recurrence: { cadence: "weekly" as const, weekdays: { mode: "first_date_weekday" as const } },
    recurrenceIsExplicit: true,
    needsClarification: false,
    end: { mode: "count" as const, occurrences: 3 },
  },
}

function toolResult(messages: ToolConversationMessage[], name: string): Record<string, unknown> {
  const message = [...messages].reverse().find((candidate) => candidate.role === "tool" && candidate.name === name)
  if (message?.role !== "tool") throw new Error(`Missing ${name} result`)
  const guarded = message.output as { ok: true; output: Record<string, unknown> }
  return guarded.output
}

function queueReady(candidate: typeof ONE_OFF | typeof RECURRING): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [
      { id: `evaluate-${mockGenerate.mock.calls.length}`, name: "evaluate_calendar_candidate", input: candidate },
    ],
    usage: {},
  })
  mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => ({
    toolCalls: [
      {
        id: `ready-${mockGenerate.mock.calls.length}`,
        name: "ready_to_create",
        input: { planId: toolResult(messages, "evaluate_calendar_candidate").planId },
      },
    ],
    usage: {},
  }))
}

function queueChoice(candidate: typeof ONE_OFF | typeof RECURRING, message = "That time conflicts."): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [{ id: "evaluate-choice", name: "evaluate_calendar_candidate", input: candidate }],
    usage: {},
  })
  mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => {
    const evaluation = toolResult(messages, "evaluate_calendar_candidate") as {
      issues: Array<{ code: string }>
      options: Array<{ optionId: string }>
    }
    return {
      toolCalls: [
        {
          id: "choice",
          name: "needs_user_input",
          input: {
            message,
            reasonCodes: evaluation.issues.map((issue) => issue.code),
            interaction: { kind: "options", optionIds: evaluation.options.map((option) => option.optionId) },
          },
        },
      ],
      usage: {},
    }
  })
}

function queueQuestion(message: string, reasonCodes = ["missing_date"]): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [
      {
        id: "question",
        name: "needs_user_input",
        input: { message, reasonCodes, interaction: { kind: "reply" } },
      },
    ],
    usage: {},
  })
}

function environment(): Env {
  return {
    TELEGRAM_BOT_TOKEN: "bot-token",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    LLM_MAX_RETRIES: "0",
    TIMEZONE: "Asia/Kolkata",
    GOOGLE_CALENDAR_REDIRECT_ORIGIN: "https://dev.kipp.example/",
    INTERACTION_ROUTER: {
      idFromName: () => "calendar-chat",
      get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true })) }),
    },
  } as unknown as Env
}

function workflowEvent(requestText = "Call Jamie on 2026-07-28 at 7pm") {
  return {
    instanceId: "calendar-workflow-1",
    payload: { chatId: "123", requestText, telegramMessageId: 456 },
  }
}

function createStep(...events: Array<{ type: string; payload?: { text: string; interactionId?: string } }>) {
  const waitForEvent = vitest.fn()
  for (const event of events) waitForEvent.mockResolvedValueOnce(event)
  return { do: vitest.fn(async (_name: string, fn: () => unknown) => fn()), waitForEvent }
}

function telegramMock() {
  const telegram = vitest
    .fn()
    .mockResolvedValue({ ok: true, json: () => Promise.resolve({ result: { message_id: 1 } }) })
  vitest.stubGlobal("fetch", telegram)
  return telegram
}

async function run(step: ReturnType<typeof createStep>, requestText?: string): Promise<void> {
  const workflow = new CalendarWorkflow({} as never, {} as never)
  Object.assign(workflow, { env: environment() })
  await (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
    workflowEvent(requestText),
    step,
  )
}

describe("agent-centered CalendarWorkflow", () => {
  beforeEach(() => {
    vitest.useFakeTimers()
    vitest.setSystemTime(new Date("2026-07-01T00:00:00.000Z"))
    mockGenerate.mockReset()
    mockBusyIntervals.mockReset().mockResolvedValue([])
    mockListEvents.mockReset().mockResolvedValue({ events: [], truncated: false })
    mockCreateManagedEvent.mockReset()
    mockUpdateManagedEvent.mockReset()
    mockReconcileManagedSeries.mockReset().mockResolvedValue(undefined)
    mockDeleteManagedEvent.mockReset().mockResolvedValue(undefined)
    mockFindConflictingEvents.mockReset().mockResolvedValue([])
    mockMoveExistingEvent.mockReset().mockResolvedValue({ ok: true })
    telegramMock()
  })
  afterEach(() => {
    vitest.useRealTimers()
    vitest.unstubAllGlobals()
  })

  it("revalidates and writes one exact one-off plan", async () => {
    queueReady(ONE_OFF)

    const step = createStep({ type: "timeout" })
    await run(step)

    expect(mockBusyIntervals).toHaveBeenCalledTimes(2)
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(step.do).toHaveBeenCalledWith("calendar-agent-revalidate-0", expect.any(Function))
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Call Jamie", start: "2026-07-28T13:30:00.000Z" }),
    )
  })

  it("creates one recurring parent and reconciles its bounded instances", async () => {
    queueReady(RECURRING)

    await run(createStep({ type: "timeout" }), "Weekly review every Tuesday at 7pm for 3 occurrences")

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ recurrence: [expect.stringContaining("COUNT=3")] }),
    )
    expect(mockReconcileManagedSeries).toHaveBeenCalledWith(expect.anything(), [])
  })

  it("resumes the native transcript after one agent-authored multi-issue request", async () => {
    queueQuestion("Please provide the title, date, and a valid time.", [
      "invalid_title",
      "missing_date",
      "missing_or_invalid_time",
    ])
    queueReady(ONE_OFF)

    await run(createStep({ type: "event", payload: { text: "Call Jamie tomorrow at 7pm" } }, { type: "timeout" }))

    expect(mockGenerate.mock.calls[1]?.[0].messages).toContainEqual({
      role: "user",
      text: "Call Jamie tomorrow at 7pm",
    })
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })

  it("clarifies an explicit unsupported recurrence before writing instead of degrading it", async () => {
    const quarterly = {
      ...RECURRING,
      proposal: {
        ...RECURRING.proposal,
        title: "Quarterly investment review",
        firstDate: "2026-09-26",
        needsClarification: true,
      },
    }
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [{ id: "evaluate-quarterly", name: "evaluate_calendar_candidate", input: quarterly }],
      usage: {},
    })
    mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => {
      const evaluation = toolResult(messages, "evaluate_calendar_candidate") as {
        issues: Array<{ code: string }>
      }
      return {
        toolCalls: [
          {
            id: "clarify-quarterly",
            name: "needs_user_input",
            input: {
              message:
                "Quarterly recurrence isn't supported. I can schedule daily, weekly, biweekly, monthly, or bimonthly within six months. Which cadence should I use?",
              reasonCodes: evaluation.issues.map((issue) => issue.code),
              interaction: { kind: "reply" },
            },
          },
        ],
        usage: {},
      }
    })
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [{ id: "evaluate-weekly", name: "evaluate_calendar_candidate", input: RECURRING }],
      usage: {},
    })
    mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => ({
      toolCalls: [
        {
          id: "ready-weekly",
          name: "ready_to_create",
          input: { planId: toolResult(messages, "evaluate_calendar_candidate").planId },
        },
      ],
      usage: {},
    }))

    await run(
      createStep({ type: "event", payload: { text: "Weekly is fine" } }, { type: "timeout" }),
      "Quarterly Investment Review starting Sep 26, 11:30am for 30min",
    )

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Weekly review", recurrence: [expect.stringContaining("COUNT=3")] }),
    )
  })

  it("recovers when the provider batches a fresh evaluation with a premature handoff", async () => {
    queueQuestion("Please provide the recurrence, time, duration, and first date.", [
      "missing_date",
      "unsupported_recurrence",
    ])
    const missingDate = {
      ...RECURRING,
      proposal: { ...RECURRING.proposal, firstDate: "2026-07-04", dateIsExplicit: false },
    }
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [{ id: "evaluate-missing-date", name: "evaluate_calendar_candidate", input: missingDate }],
      usage: {},
    })
    mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => {
      const evaluation = toolResult(messages, "evaluate_calendar_candidate") as { issues: Array<{ code: string }> }
      return {
        toolCalls: [
          {
            id: "ask-for-weekday",
            name: "needs_user_input",
            input: {
              message: "Which weekday should the biweekly review start on?",
              reasonCodes: evaluation.issues.map((issue) => issue.code),
              interaction: { kind: "reply" },
            },
          },
        ],
        usage: {},
      }
    })
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [
        { id: "evaluate-final", name: "evaluate_calendar_candidate", input: RECURRING },
        { id: "premature-ready", name: "ready_to_create", input: { planId: "not-yet-known" } },
      ],
      usage: {},
    })
    mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => ({
      toolCalls: [
        {
          id: "ready-after-evaluation",
          name: "ready_to_create",
          input: { planId: toolResult(messages, "evaluate_calendar_candidate").planId },
        },
      ],
      usage: {},
    }))

    await run(
      createStep(
        { type: "event", payload: { text: "biweekly, 9am, 15 min, starting this week" } },
        { type: "event", payload: { text: "Saturday" } },
        { type: "timeout" },
      ),
      "Schedule a recurring review of Substack metrics",
    )

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockGenerate.mock.calls[4]?.[0].messages).toContainEqual({
      role: "tool",
      toolCallId: "premature-ready",
      name: "ready_to_create",
      output: { ok: false, category: "batching-not-allowed" },
    })
  })

  it("binds a deterministic conflict option, freshly revalidates it, and writes once", async () => {
    const conflict = [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }]
    mockBusyIntervals.mockResolvedValue(conflict)
    queueChoice(ONE_OFF, "7pm conflicts. I can offer a safe alternative.")

    await run(
      createStep({ type: "event", payload: { text: "__calendar-conflict-alternative__" } }, { type: "timeout" }),
    )

    expect(mockBusyIntervals).toHaveBeenCalledTimes(2)
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:15:00.000Z" }))
  })

  it("renders recurring adjustment choices in authorized order with compact labels", async () => {
    mockBusyIntervals.mockResolvedValue([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
    queueChoice(
      RECURRING,
      "The first occurrence conflicts. I can move only that date to 7:45 PM. Choose a button below.",
    )
    const telegram = telegramMock()

    await run(createStep({ type: "timeout" }), "Weekly review every Tuesday at 7pm for 3 occurrences")

    const request = telegram.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(request.body as string) as {
      text: string
      reply_markup: { inline_keyboard: Array<Array<{ text: string }>> }
    }
    const labels = body.reply_markup.inline_keyboard[0]?.map((button) => button.text)
    expect(body.text).not.toContain("Option ID")
    expect(labels).toEqual(["Use adjustments", "Try another time", "Why this busy?", "Cancel"])
    expect(labels?.every((label) => label.length <= 16)).toBe(true)
  })

  it.each([
    ["cancelled", { type: "event", payload: { text: "__calendar-conflict-cancel__" } }, true],
    ["expired", { type: "timeout" }, false],
  ])("acknowledges only an actual conflict cancel and never writes when %s", async (_label, interaction, ack) => {
    mockBusyIntervals.mockResolvedValue([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
    queueChoice(ONE_OFF)
    const telegram = telegramMock()

    await run(createStep(interaction))

    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockUpdateManagedEvent).not.toHaveBeenCalled()
    const sentTexts = telegram.mock.calls
      .map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { text: string }).text)
      .filter(Boolean)
    expect(sentTexts.some((text) => text.includes("Cancelled"))).toBe(ack)
  })

  it("does not silently substitute when an accepted option changes before write", async () => {
    mockBusyIntervals
      .mockResolvedValueOnce([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
      .mockResolvedValueOnce([
        { start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" },
        { start: "2026-07-28T14:15:00.000Z", end: "2026-07-28T14:45:00.000Z" },
      ])
    queueChoice(ONE_OFF)
    queueQuestion("Availability changed. Please choose another time.", ["no_available_time"])

    await run(
      createStep({ type: "event", payload: { text: "__calendar-conflict-alternative__" } }, { type: "timeout" }),
    )

    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockGenerate.mock.calls[2]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "system", text: expect.stringContaining("availability changed") }),
    )
  })

  it("passes the trusted created baseline into Edit and updates the same identity", async () => {
    queueReady(ONE_OFF)
    queueReady({ ...ONE_OFF, proposal: { ...ONE_OFF.proposal, startTime: "20:00" } })

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-edit__" } },
        { type: "event", payload: { text: "Move it to 8pm" } },
        { type: "timeout" },
      ),
    )

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockUpdateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockUpdateManagedEvent.mock.calls[0]?.[0].id).toBe(mockCreateManagedEvent.mock.calls[0]?.[0].id)
    expect(mockGenerate.mock.calls[2]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "system", text: expect.stringContaining("Trusted created-event baseline") }),
    )
  })

  it("compensates a newly created recurring parent when reconciliation fails", async () => {
    queueReady(RECURRING)
    mockReconcileManagedSeries.mockRejectedValueOnce(new Error("reconciliation failed"))

    await run(createStep(), "Weekly review every Tuesday at 7pm for 3 occurrences")

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockDeleteManagedEvent).toHaveBeenCalledWith(mockCreateManagedEvent.mock.calls[0]?.[0].id)
  })

  it("retries only confirmation delivery after a successful write", async () => {
    queueReady(ONE_OFF)
    const telegram = vitest
      .fn()
      .mockRejectedValueOnce(new Error("delivery failed"))
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ result: { message_id: 1 } }) })
    vitest.stubGlobal("fetch", telegram)

    await run(createStep({ type: "timeout" }))

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(telegram).toHaveBeenCalledTimes(2)
  })

  it("does not resend a delivered confirmation when its Edit wait fails", async () => {
    queueReady(RECURRING)
    const telegram = telegramMock()
    const step = createStep()
    step.waitForEvent.mockRejectedValueOnce(new Error("workflow wait failed"))

    await run(step, "Weekly review every Tuesday at 7pm for 3 occurrences")

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(telegram).toHaveBeenCalledTimes(1)
    expect((telegram.mock.calls[0]?.[1] as { body?: string } | undefined)?.body).toContain("3 occurrences")
  })

  it("offers one deterministic reconnect and retries through a new agent evaluation", async () => {
    queueReady(ONE_OFF)
    mockBusyIntervals
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new MockGoogleCalendarError("disconnected", "authorization"))
      .mockResolvedValue([])
    queueReady(ONE_OFF)

    await run(createStep({ type: "event", payload: { text: "__calendar-retry__" } }, { type: "timeout" }))

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockGenerate.mock.calls[2]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "system", text: expect.stringContaining("authorization was restored") }),
    )
  })

  it("acknowledges and does not write when reconnection is cancelled", async () => {
    queueReady(ONE_OFF)
    mockBusyIntervals
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new MockGoogleCalendarError("disconnected", "authorization"))
    const telegram = telegramMock()

    await run(createStep({ type: "event", payload: { text: "__calendar-cancel__" } }))

    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockUpdateManagedEvent).not.toHaveBeenCalled()
    const sentTexts = telegram.mock.calls
      .map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { text: string }).text)
      .filter(Boolean)
    expect(sentTexts.some((text) => text.includes("Cancelled"))).toBe(true)
  })

  it("keeps dynamic request context out of the static agent instructions", async () => {
    queueQuestion("What date should I use?")

    await run(createStep({ type: "timeout" }))

    const messages = mockGenerate.mock.calls[0]?.[0].messages as ToolConversationMessage[]
    expect(messages[0]).toEqual(
      expect.objectContaining({ role: "system", text: expect.stringContaining("bounded Calendar agent") }),
    )
    expect(messages[0]).not.toEqual(expect.objectContaining({ text: expect.stringContaining("Call Jamie") }))
    expect(messages[1]).toEqual(expect.objectContaining({ role: "user", text: expect.stringContaining("Call Jamie") }))
  })

  it("stops after eight unresolved human turns without reading or writing Calendar", async () => {
    for (let turn = 0; turn < 8; turn++) queueQuestion(`Please clarify the date (${turn + 1}).`)
    const telegram = telegramMock()
    const replies = Array.from({ length: 8 }, (_, turn) => ({
      type: "event",
      payload: { text: `Still ambiguous ${turn + 1}` },
    }))

    await run(createStep(...replies))

    expect(mockGenerate).toHaveBeenCalledTimes(8)
    expect(mockBusyIntervals).not.toHaveBeenCalled()
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(telegram).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.stringContaining("start a new request") }),
    )
  })

  it("discloses a conflict, moves one existing event, auto-creates the request, and fully undoes", async () => {
    const conflict = [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }]
    mockBusyIntervals.mockResolvedValueOnce(conflict).mockResolvedValueOnce(conflict).mockResolvedValueOnce([])
    mockFindConflictingEvents.mockResolvedValue([
      {
        id: "existing-1",
        title: "Standup",
        start: "2026-07-28T13:30:00.000Z",
        end: "2026-07-28T14:00:00.000Z",
        allDay: false,
        etag: "etag-1",
        movable: true,
      },
    ])
    queueChoice(ONE_OFF, "7pm conflicts. I can offer a safe alternative.")
    const telegram = telegramMock()

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-conflict-disclose__" } },
        { type: "event", payload: { text: "__calendar-conflict-reschedule__" } },
        { type: "event", payload: { text: "__calendar-conflict-move__" } },
        { type: "event", payload: { text: "__calendar-conflict-undo__" } },
      ),
    )

    expect(mockFindConflictingEvents).toHaveBeenCalledTimes(1)
    expect(mockMoveExistingEvent.mock.calls[0]).toEqual([
      "existing-1",
      "2026-07-28T14:15:00.000Z",
      "2026-07-28T14:45:00.000Z",
    ])
    expect(mockMoveExistingEvent.mock.calls[1]).toEqual([
      "existing-1",
      "2026-07-28T13:30:00.000Z",
      "2026-07-28T14:00:00.000Z",
    ])
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateManagedEvent.mock.calls[0]?.[0]).toMatchObject({
      summary: "Call Jamie",
      start: "2026-07-28T13:30:00.000Z",
      end: "2026-07-28T14:00:00.000Z",
    })
    expect(mockDeleteManagedEvent).toHaveBeenCalledWith(mockCreateManagedEvent.mock.calls[0]?.[0].id)
    const texts = telegram.mock.calls
      .map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { text: string }).text)
      .filter(Boolean)
    expect(texts.some((text) => text.includes("Standup (19:00–19:30)"))).toBe(true)
    expect(texts.some((text) => text.includes("Moved Standup"))).toBe(true)
    expect(texts.some((text) => text.includes("Restored Standup"))).toBe(true)
    expect(texts.every((text) => !text.includes("existing-1"))).toBe(true)
  })

  it("discloses a recurring conflict as disclosure-only and never offers a reschedule action", async () => {
    const conflict = [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }]
    mockBusyIntervals.mockResolvedValue(conflict)
    mockFindConflictingEvents.mockResolvedValue([
      {
        id: "series-1",
        title: "Standup",
        start: "2026-07-28T13:30:00.000Z",
        end: "2026-07-28T14:00:00.000Z",
        allDay: false,
        etag: "etag-series",
        movable: false,
      },
    ])
    queueChoice(RECURRING)
    const telegram = telegramMock()

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-conflict-disclose__" } },
        { type: "event", payload: { text: "__calendar-conflict-cancel__" } },
      ),
      "Weekly review every Tuesday at 7pm for 3 occurrences",
    )

    expect(mockFindConflictingEvents).toHaveBeenCalledTimes(1)
    expect(mockFindConflictingEvents).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "Asia/Kolkata",
    )
    expect(mockMoveExistingEvent).not.toHaveBeenCalled()
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    const messages = telegram.mock.calls.map(
      ([, init]) =>
        JSON.parse((init as RequestInit).body as string) as {
          text: string
          reply_markup?: { inline_keyboard: Array<Array<{ text: string }>> }
        },
    )
    const disclosure = messages.find((candidate) => candidate.text.includes("occupied by"))
    expect(disclosure?.text).toContain("Standup (19:00–19:30)")
    const labels = disclosure?.reply_markup?.inline_keyboard[0]?.map((button) => button.text)
    expect(labels).toEqual(["Try another time", "Cancel"])
    expect(messages.some((candidate) => candidate.text.includes("Cancelled"))).toBe(true)
    expect(messages.every((candidate) => !candidate.text.includes("series-1"))).toBe(true)
  })

  it("discloses non-movable events without a reschedule action and cancels cleanly", async () => {
    const conflict = [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }]
    mockBusyIntervals.mockResolvedValue(conflict)
    mockFindConflictingEvents.mockResolvedValue([
      {
        id: "all-day-1",
        title: "Holiday",
        start: "2026-07-28",
        end: "2026-07-29",
        allDay: true,
        etag: "etag-all",
        movable: false,
      },
    ])
    queueChoice(ONE_OFF)
    const telegram = telegramMock()

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-conflict-disclose__" } },
        { type: "event", payload: { text: "__calendar-conflict-cancel__" } },
      ),
    )

    expect(mockFindConflictingEvents).toHaveBeenCalledTimes(1)
    expect(mockMoveExistingEvent).not.toHaveBeenCalled()
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    const texts = telegram.mock.calls
      .map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { text: string }).text)
      .filter(Boolean)
    expect(texts.some((text) => text.includes("Holiday (all day)"))).toBe(true)
    expect(texts.some((text) => text.includes("Cancelled"))).toBe(true)
    expect(texts.some((text) => text.includes("existing-1") || text.includes("all-day-1"))).toBe(false)
  })

  it("compensates when the auto-created request fails after the move verified", async () => {
    const conflict = [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }]
    mockBusyIntervals.mockResolvedValueOnce(conflict).mockResolvedValueOnce(conflict).mockResolvedValueOnce([])
    mockFindConflictingEvents.mockResolvedValue([
      {
        id: "existing-1",
        title: "Standup",
        start: "2026-07-28T13:30:00.000Z",
        end: "2026-07-28T14:00:00.000Z",
        allDay: false,
        etag: "etag-1",
        movable: true,
      },
    ])
    mockCreateManagedEvent.mockRejectedValueOnce(new MockGoogleCalendarError("create failed", "permanent"))
    queueChoice(ONE_OFF)
    const telegram = telegramMock()

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-conflict-disclose__" } },
        { type: "event", payload: { text: "__calendar-conflict-reschedule__" } },
        { type: "event", payload: { text: "__calendar-conflict-move__" } },
      ),
    )

    expect(mockMoveExistingEvent).toHaveBeenCalledTimes(2)
    expect(mockMoveExistingEvent.mock.calls[1]).toEqual([
      "existing-1",
      "2026-07-28T13:30:00.000Z",
      "2026-07-28T14:00:00.000Z",
    ])
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    const texts = telegram.mock.calls
      .map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { text: string }).text)
      .filter(Boolean)
    expect(texts.some((text) => text.includes("couldn't create your block"))).toBe(true)
  })

  it("surfaces a safe availability-changed outcome on a 412 precondition-failed move", async () => {
    const conflict = [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }]
    mockBusyIntervals.mockResolvedValue(conflict)
    mockFindConflictingEvents.mockResolvedValue([
      {
        id: "existing-1",
        title: "Standup",
        start: "2026-07-28T13:30:00.000Z",
        end: "2026-07-28T14:00:00.000Z",
        allDay: false,
        etag: "etag-1",
        movable: true,
      },
    ])
    mockMoveExistingEvent.mockResolvedValueOnce({ ok: false, reason: "precondition-failed" })
    queueChoice(ONE_OFF)
    queueQuestion("Availability changed. Please choose another time.", ["no_available_time"])

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-conflict-disclose__" } },
        { type: "event", payload: { text: "__calendar-conflict-reschedule__" } },
        { type: "event", payload: { text: "__calendar-conflict-move__" } },
        { type: "timeout" },
      ),
    )

    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockMoveExistingEvent).toHaveBeenCalledTimes(1)
    expect(mockGenerate.mock.calls[2]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "system", text: expect.stringContaining("availability changed") }),
    )
  })
})
