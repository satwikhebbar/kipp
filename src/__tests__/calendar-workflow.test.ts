import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import type { Env } from "../types"

vitest.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
  }
  return { WorkflowEntrypoint }
})

const mockGenerate = vitest.hoisted(() => vitest.fn())
const mockBusyIntervals = vitest.hoisted(() => vitest.fn())
const mockCreateManagedEvent = vitest.hoisted(() => vitest.fn())
const mockUpdateManagedEvent = vitest.hoisted(() => vitest.fn())
const MockGoogleCalendarError = vitest.hoisted(
  () =>
    class GoogleCalendarError extends Error {
      constructor(readonly kind: string) {
        super(kind)
      }
    },
)

vitest.mock("../providers", () => ({ createToolProvider: () => ({ generate: mockGenerate }) }))
vitest.mock("../integrations/google-calendar", () => ({
  createGoogleCalendarClient: () => ({
    getBusyIntervals: mockBusyIntervals,
    createManagedEvent: mockCreateManagedEvent,
    updateManagedEvent: mockUpdateManagedEvent,
  }),
  GoogleCalendarError: MockGoogleCalendarError,
}))

import { CalendarWorkflow } from "../calendar-workflow"

const proposal = (startTime = "19:00") => ({
  title: { value: "Call Jamie", source: "explicit" as const },
  localDate: { value: "2026-07-28", source: "explicit" as const },
  startTime: { value: startTime, source: "explicit" as const },
  durationMinutes: { value: 30, source: "inferred" as const },
  classification: { value: "ordinary", source: "inferred" as const },
})

function queueProposal(startTime = "19:00"): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [
      {
        id: `proposal-${mockGenerate.mock.calls.length}`,
        name: "submit_one_off_proposal",
        input: proposal(startTime),
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
}

function queueClarification(message = "What date should I schedule this for?"): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [
      { id: `clarification-${mockGenerate.mock.calls.length}`, name: "request_clarification", input: { message } },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
}

function environment(): Env {
  return {
    TELEGRAM_BOT_TOKEN: "bot-token",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    LLM_MAX_RETRIES: "0",
    TIMEZONE: "Asia/Kolkata",
    INTERACTION_ROUTER: {
      idFromName: () => "calendar-chat",
      get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true })) }),
    },
  } as unknown as Env
}

function workflowEvent() {
  return {
    instanceId: "calendar-workflow-1",
    payload: { chatId: "123", requestText: "Call Jamie tomorrow at 7pm", telegramMessageId: 456 },
  }
}

function createStep(...events: Array<{ type: string; payload?: { text: string } }>) {
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

async function run(step: ReturnType<typeof createStep>): Promise<void> {
  const workflow = new CalendarWorkflow({} as never, {} as never)
  Object.assign(workflow, { env: environment() })
  await (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(workflowEvent(), step)
}

describe("CalendarWorkflow", () => {
  beforeEach(() => {
    vitest.useFakeTimers()
    vitest.setSystemTime(new Date("2026-07-01T00:00:00.000Z"))
    mockGenerate.mockReset()
    mockBusyIntervals.mockReset()
    mockCreateManagedEvent.mockReset()
    mockUpdateManagedEvent.mockReset()
  })
  afterEach(() => vitest.useRealTimers())

  it("creates exactly one deterministic Calendar event from a bounded proposal", async () => {
    queueProposal()
    mockBusyIntervals.mockResolvedValue([])
    const telegram = telegramMock()

    await run(createStep({ type: "timeout" }))

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Call Jamie", timeZone: "Asia/Kolkata", reminderMinutes: 10 }),
    )
    expect(telegram).toHaveBeenLastCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("Added: Call Jamie") }),
    )
  })

  it("keeps static planner instructions separate from dynamic user context", async () => {
    queueClarification()
    telegramMock()

    await run(createStep({ type: "timeout" }))

    const initialMessages = mockGenerate.mock.calls[0][0].messages.slice(0, 2)
    expect(initialMessages).toEqual([
      expect.objectContaining({ role: "system", text: expect.stringContaining("calendar planner") }),
      expect.objectContaining({
        role: "user",
        text: expect.stringContaining("User request: Call Jamie tomorrow at 7pm"),
      }),
    ])
    expect(initialMessages[0].text).not.toContain("Call Jamie tomorrow at 7pm")
    expect(initialMessages[0].text).not.toContain("Today is")
    expect(initialMessages[1].text).toContain("Today is")
  })

  it("does not write and asks for a retry when the provider returns prose without a decision action", async () => {
    mockGenerate.mockResolvedValue({ text: "I need more details.", usage: { inputTokens: 0, outputTokens: 0 } })
    const telegram = telegramMock()

    await run(createStep())

    expect(mockBusyIntervals).not.toHaveBeenCalled()
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(telegram).toHaveBeenLastCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("didn't return a scheduling decision") }),
    )
  })

  it("does not create an event when the model marks a date as inferred", async () => {
    const telegram = telegramMock()

    // The planner can normalize an explicit date, but it cannot choose one.
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [
        {
          id: "proposal-with-inferred-date",
          name: "submit_one_off_proposal",
          input: { ...proposal(), localDate: { value: "2026-07-29", source: "inferred" } },
        },
      ],
      usage: {},
    })

    await run(createStep({ type: "timeout" }))

    expect(mockBusyIntervals).not.toHaveBeenCalled()
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(telegram).toHaveBeenLastCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("What date should I schedule this for?") }),
    )
  })

  it("replans after a focused clarification without reading Calendar data before the reply", async () => {
    queueClarification("What date should I schedule your investment review for?")
    queueProposal()
    mockBusyIntervals.mockResolvedValue([])
    telegramMock()

    await run(createStep({ type: "event", payload: { text: "tomorrow" } }, { type: "timeout" }))

    expect(mockGenerate).toHaveBeenCalledTimes(2)
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })

  it("keeps an offered available time in context when the user accepts it concisely", async () => {
    queueClarification("The only available slot on July 30 is at 19:00. Would you like that time?")
    queueProposal("19:00")
    mockBusyIntervals.mockResolvedValue([])
    telegramMock()

    await run(createStep({ type: "event", payload: { text: "Proceed" } }, { type: "timeout" }))

    expect(mockGenerate.mock.calls[1]?.[0].messages[1].text).toContain(
      "Calendar planner asked: The only available slot on July 30 is at 19:00. Would you like that time?\nUser replied: Proceed",
    )
    expect(mockGenerate.mock.calls[1]?.[0].messages[0].text).toContain("do not look up availability again")
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })

  it("creates the deterministic safe alternative after the user chooses it", async () => {
    queueProposal()
    mockBusyIntervals.mockResolvedValue([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
    telegramMock()

    await run(
      createStep({ type: "event", payload: { text: "__calendar-conflict-alternative__" } }, { type: "timeout" }),
    )

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:15:00.000Z" }))
  })

  it("asks for a replacement time instead of passing the control action to the planner", async () => {
    queueProposal()
    queueProposal("20:00")
    mockBusyIntervals.mockResolvedValueOnce([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
    mockBusyIntervals.mockResolvedValueOnce([])
    telegramMock()

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-conflict-replace__" } },
        { type: "event", payload: { text: "8pm" } },
        { type: "timeout" },
      ),
    )

    expect(mockGenerate.mock.calls[1]?.[0].messages[1].text).toContain("Replacement time: 8pm")
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:30:00.000Z" }))
  })

  it("does not create an event when the conflict prompt is cancelled or expires", async () => {
    queueProposal()
    queueProposal()
    mockBusyIntervals.mockResolvedValue([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
    telegramMock()

    await run(createStep({ type: "event", payload: { text: "__calendar-conflict-cancel__" } }))
    await run(createStep({ type: "timeout" }))

    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
  })

  it("updates the same managed event after an Edit correction", async () => {
    queueProposal()
    queueProposal("20:00")
    mockBusyIntervals.mockResolvedValue([])
    telegramMock()

    await run(
      createStep(
        { type: "event", payload: { text: "__calendar-edit__" } },
        { type: "event", payload: { text: "Make it 8pm" } },
        { type: "timeout" },
      ),
    )

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockUpdateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:30:00.000Z" }))
  })

  it("permits exactly one authorization retry", async () => {
    queueProposal()
    queueProposal()
    mockBusyIntervals.mockRejectedValueOnce(new MockGoogleCalendarError("authorization"))
    mockBusyIntervals.mockResolvedValueOnce([])
    telegramMock()

    await run(createStep({ type: "event", payload: { text: "__calendar-retry__" } }, { type: "timeout" }))

    expect(mockBusyIntervals).toHaveBeenCalledTimes(2)
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })

  it("stops after four clarification cycles and asks for a new request", async () => {
    for (let i = 0; i < 4; i++) queueClarification(`What detail ${i + 1} is missing?`)
    const telegram = telegramMock()

    await run(
      createStep(
        { type: "event", payload: { text: "one" } },
        { type: "event", payload: { text: "two" } },
        { type: "event", payload: { text: "three" } },
        { type: "event", payload: { text: "four" } },
      ),
    )

    expect(mockGenerate).toHaveBeenCalledTimes(4)
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(telegram).toHaveBeenLastCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("Please start a new /calendar request") }),
    )
  })

  it("requires a decision action after a single availability lookup", async () => {
    mockGenerate
      .mockResolvedValueOnce({
        toolCalls: [
          {
            id: "availability",
            name: "get_available_slots",
            input: { localDate: "2026-07-28", durationMinutes: 30 },
          },
        ],
        usage: {},
      })
      .mockResolvedValueOnce({
        toolCalls: [{ id: "proposal", name: "submit_one_off_proposal", input: proposal() }],
        usage: {},
      })
    mockBusyIntervals.mockResolvedValue([])
    telegramMock()

    await run(createStep({ type: "timeout" }))

    expect(mockGenerate).toHaveBeenCalledTimes(2)
    expect(mockGenerate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ toolChoice: "required", reasoning: "disabled" }),
    )
    expect(mockGenerate.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        toolChoice: "required",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "submit_one_off_proposal" }),
          expect.objectContaining({ name: "request_clarification" }),
        ]),
      }),
    )
    expect(mockGenerate.mock.calls[1][0].tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "get_available_slots" })]),
    )
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })
})
