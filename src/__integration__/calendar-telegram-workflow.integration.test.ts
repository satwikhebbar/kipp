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
  }),
  GoogleCalendarError: MockGoogleCalendarError,
}))

import { CalendarWorkflow } from "../calendar/workflow"
import { INTERACTION_KIND } from "../core/types"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { createFakeInteractionRouter, createFakeNetwork, createFakeWorkflowBinding } from "./setup"

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
    end: { mode: "count" as const, occurrences: 3 },
  },
}

const FIRST_CONFLICT = [{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }]
const SECOND_CONFLICT = [{ start: "2026-08-04T13:30:00.000Z", end: "2026-08-04T14:00:00.000Z" }]
const PRODUCTION_TEST_ORIGIN = "https://calendar.example.test"

function toolResult(messages: ToolConversationMessage[], name: string): Record<string, unknown> {
  const message = [...messages].reverse().find((candidate) => candidate.role === "tool" && candidate.name === name)
  if (message?.role !== "tool") throw new Error(`Missing ${name} result`)
  return (message.output as { ok: true; output: Record<string, unknown> }).output
}

function queueReady(candidate: typeof ONE_OFF | typeof RECURRING): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [{ id: "evaluate", name: "evaluate_calendar_candidate", input: candidate }],
    usage: {},
  })
  mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => ({
    toolCalls: [
      {
        id: "ready",
        name: "ready_to_create",
        input: { planId: toolResult(messages, "evaluate_calendar_candidate").planId },
      },
    ],
    usage: {},
  }))
}

function queueChoice(candidate: typeof ONE_OFF | typeof RECURRING): void {
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
            message: "7pm conflicts. A safe alternative is available.",
            reasonCodes: evaluation.issues.map((issue) => issue.code),
            interaction: { kind: "options", optionIds: evaluation.options.map((option) => option.optionId) },
          },
        },
      ],
      usage: {},
    }
  })
}

function queueQuestion(
  message = "Please provide a title, date, and valid time.",
  reasonCodes = ["invalid_title", "missing_date", "missing_or_invalid_time"],
): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [
      {
        id: "question",
        name: "needs_user_input",
        input: {
          message,
          reasonCodes,
          interaction: { kind: "reply" },
        },
      },
    ],
    usage: {},
  })
}

function queueEvaluationQuestion(candidate: typeof ONE_OFF | typeof RECURRING, message: string): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [{ id: "evaluate-question", name: "evaluate_calendar_candidate", input: candidate }],
    usage: {},
  })
  mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => {
    const evaluation = toolResult(messages, "evaluate_calendar_candidate") as { issues: Array<{ code: string }> }
    return {
      toolCalls: [
        {
          id: "evaluated-question",
          name: "needs_user_input",
          input: {
            message,
            reasonCodes: evaluation.issues.map((issue) => issue.code),
            interaction: { kind: "reply" },
          },
        },
      ],
      usage: {},
    }
  })
}

function request(body: Record<string, unknown>, origin = "http://localhost"): Request {
  return new Request(origin, {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function message(text: string, messageId = 1, replyTo?: number, entities?: unknown[], origin?: string): Request {
  return request(
    {
      update_id: messageId,
      message: {
        message_id: messageId,
        from: { id: 42, is_bot: false },
        chat: { id: 100, type: "private" },
        text,
        ...(entities ? { entities } : {}),
        ...(replyTo ? { reply_to_message: { message_id: replyTo, from: { id: 7, is_bot: true } } } : {}),
      },
    },
    origin,
  )
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

function env(overrides?: Partial<Env>): Env {
  return {
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "my-secret",
    TELEGRAM_ALLOWED_USER_ID: "42",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    LLM_MAX_RETRIES: "0",
    TIMEZONE: "Asia/Kolkata",
    INTERACTION_ROUTER: createFakeInteractionRouter().namespace,
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as Env
}

function liveWorkflowBinding() {
  const created: Array<{ id: string; params: unknown }> = []
  const events: unknown[] = []
  let waiter: ((event: unknown) => void) | undefined
  return {
    create: vitest.fn(async (params: unknown) => {
      const id = "calendar-wf-1"
      created.push({ id, params })
      return { id }
    }),
    get: vitest.fn(() => ({
      sendEvent: vitest.fn(async (event: unknown) => {
        if (waiter) {
          const resolve = waiter
          waiter = undefined
          resolve(event)
        } else events.push(event)
      }),
    })),
    waitForEvent: () =>
      new Promise((resolve) => {
        const queued = events.shift()
        if (queued) resolve(queued)
        else waiter = resolve
      }),
    timeout: () => {
      if (waiter) {
        const resolve = waiter
        waiter = undefined
        resolve({ type: "timeout" })
      } else events.push({ type: "timeout" })
    },
    isWaiting: () => Boolean(waiter),
    queuedEvents: () => [...events],
    created,
  }
}

function startWorkflow(calendar: ReturnType<typeof liveWorkflowBinding>, runtimeEnv: Env): Promise<void> {
  const workflow = new CalendarWorkflow({} as never, {} as never)
  Object.assign(workflow, { env: runtimeEnv })
  const created = calendar.created[0]
  if (!created) throw new Error("Calendar workflow was not created")
  return (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
    { instanceId: "calendar-wf-1", payload: (created.params as { params: unknown }).params },
    { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
  )
}

async function waitForMessageText(
  network: ReturnType<typeof createFakeNetwork>,
  text: string,
  afterIndex = -1,
): Promise<number> {
  try {
    await vitest.waitFor(() =>
      expect(
        network
          .getState()
          .telegramMessages.some((candidate, index) => index > afterIndex && candidate.text?.includes(text)),
      ).toBe(true),
    )
  } catch {
    throw new Error(
      `Expected a Telegram message containing "${text}". Observed: ${network
        .getState()
        .telegramMessages.map((candidate) => candidate.text)
        .filter(Boolean)
        .join(" | ")}`,
    )
  }
  return network
    .getState()
    .telegramMessages.findIndex((candidate, index) => index > afterIndex && candidate.text?.includes(text))
}

async function waitForWorkflowWait(calendar: ReturnType<typeof liveWorkflowBinding>): Promise<void> {
  await vitest.waitFor(() => expect(calendar.isWaiting()).toBe(true))
}

function callbackToken(network: ReturnType<typeof createFakeNetwork>, messageIndex: number, buttonIndex = 0): string {
  const markup = network.getState().telegramMessages[messageIndex]?.replyMarkup
  const keyboard = markup?.inline_keyboard as Array<Array<{ callback_data: string }>>
  return keyboard[0]?.[buttonIndex]?.callback_data as string
}

describe("agent-centered Calendar Telegram integration", () => {
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
  })
  afterEach(() => {
    vitest.useRealTimers()
    vitest.unstubAllGlobals()
  })

  it("takes a clear Telegram request through evaluate, ready, one write, and template confirmation", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueReady(ONE_OFF)

    await handleTelegramWebhook(message("/calendar Call Jamie on 2026-07-28 at 7pm"), runtimeEnv)
    const run = startWorkflow(calendar, runtimeEnv)
    await waitForMessageText(network, "Added: Call Jamie")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockBusyIntervals).toHaveBeenCalledTimes(2)
  })

  it("routes a Telegram entity-addressed Calendar command through the complete workflow", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueReady(ONE_OFF)
    const command = "/calendar@KippBot"

    await handleTelegramWebhook(
      message(`${command}\u00a0Call Jamie on 2026-07-28 at 7pm`, 1, undefined, [
        { type: "bot_command", offset: 0, length: command.length },
      ]),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    await waitForMessageText(network, "Added: Call Jamie")
    calendar.timeout()
    await run

    expect(calendar.created).toHaveLength(1)
    expect((calendar.created[0].params as { params: { requestText: string } }).params.requestText).toBe(
      "Call Jamie on 2026-07-28 at 7pm",
    )
    expect(network.getState().telegramMessages.every((candidate) => !candidate.text?.includes("Unknown command"))).toBe(
      true,
    )
  })

  it("creates one native recurring parent and bounded instances from Telegram", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueReady(RECURRING)

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    await waitForMessageText(network, "3 occurrences")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ recurrence: [expect.stringContaining("COUNT=3")] }),
    )
    expect(mockReconcileManagedSeries).toHaveBeenCalledWith(expect.anything(), [])
  })

  it("repairs a malformed recurring handoff, asks once, and preserves the resumed recurrence", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    const missingDate = {
      ...RECURRING,
      proposal: { ...RECURRING.proposal, firstDate: "2026-07-28", dateIsExplicit: false },
    }
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [
        {
          id: "malformed-recurring",
          name: "evaluate_calendar_candidate",
          input: { kind: "recurring", proposal: { ...RECURRING.proposal, recurrence: undefined } },
        },
      ],
      usage: {},
    })
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [{ id: "missing-date", name: "evaluate_calendar_candidate", input: missingDate }],
      usage: {},
    })
    mockGenerate.mockImplementationOnce(async ({ messages }: { messages: ToolConversationMessage[] }) => ({
      toolCalls: [
        {
          id: "ask-date",
          name: "needs_user_input",
          input: {
            message: "Which Tuesday should the weekly review start on?",
            reasonCodes: (
              toolResult(messages, "evaluate_calendar_candidate") as { issues: Array<{ code: string }> }
            ).issues.map((issue) => issue.code),
            interaction: { kind: "reply" },
          },
        },
      ],
      usage: {},
    }))
    queueReady(RECURRING)

    await handleTelegramWebhook(message("/calendar Schedule a weekly review on Tuesdays at 7pm"), runtimeEnv)
    const run = startWorkflow(calendar, runtimeEnv)
    const questionIndex = await waitForMessageText(network, "Which Tuesday")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(message("Start 2026-07-28", 2, network.getState().nextMessageId - 1), runtimeEnv)
    const confirmationIndex = await waitForMessageText(network, "3 occurrences", questionIndex)
    calendar.timeout()
    await run

    expect(mockBusyIntervals).toHaveBeenCalledTimes(2)
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ recurrence: [expect.stringContaining("BYDAY=TU")] }),
    )
    expect(network.getState().telegramMessages[confirmationIndex]?.text).not.toContain("planId")
  })

  it("approves a below-half recurring adjustment through its fixed Telegram option", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockBusyIntervals.mockResolvedValue(FIRST_CONFLICT)
    queueChoice(RECURRING)

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    const choiceIndex = await waitForMessageText(network, "safe alternative")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, choiceIndex)), runtimeEnv)
    await waitForMessageText(network, "Adjusted dates: 1")
    calendar.timeout()
    await run

    expect(mockBusyIntervals).toHaveBeenCalledTimes(2)
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockReconcileManagedSeries).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        originalStart: "2026-07-28T13:30:00.000Z",
        start: "2026-07-28T14:15:00.000Z",
      }),
    ])
    expect(network.getState().telegramMessages[choiceIndex]?.text).not.toMatch(/(?:plan|option)[ _-]?id/i)
  })

  it("routes the recurring replacement-time action back through the agent before writing", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockBusyIntervals.mockResolvedValue(FIRST_CONFLICT)
    queueChoice(RECURRING)
    queueReady({ ...RECURRING, proposal: { ...RECURRING.proposal, startTime: "20:00" } })

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    const choiceIndex = await waitForMessageText(network, "safe alternative")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, choiceIndex, 1)), runtimeEnv)
    const replacementIndex = await waitForMessageText(network, "Reply with another time")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(message("Use 8pm", 2), runtimeEnv)
    await waitForMessageText(network, "at 20:00", replacementIndex)
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:30:00.000Z" }))
    expect(mockReconcileManagedSeries).toHaveBeenCalledWith(expect.anything(), [])
  })

  it("acknowledges a recurring conflict cancellation, answers its callback, and makes no Calendar mutation", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockBusyIntervals.mockResolvedValue(FIRST_CONFLICT)
    queueChoice(RECURRING)

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    const choiceIndex = await waitForMessageText(network, "safe alternative")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, choiceIndex, 2)), runtimeEnv)
    await waitForMessageText(network, "Cancelled")
    await run

    expect(network.getState().answeredCallbacks).toContain("cq-10")
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockUpdateManagedEvent).not.toHaveBeenCalled()
    expect(mockReconcileManagedSeries).not.toHaveBeenCalled()
  })

  it("acknowledges an OAuth reconnection cancellation and makes no Calendar mutation", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueReady(ONE_OFF)
    mockBusyIntervals
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new MockGoogleCalendarError("disconnected", "authorization"))

    await handleTelegramWebhook(message("/calendar Call Jamie on 2026-07-28 at 7pm"), runtimeEnv)
    const run = startWorkflow(calendar, runtimeEnv)
    const reconnectIndex = await waitForMessageText(network, "Google Calendar is not connected")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, reconnectIndex, 1)), runtimeEnv)
    await waitForMessageText(network, "Cancelled")
    await run

    expect(network.getState().answeredCallbacks).toContain("cq-10")
    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockUpdateManagedEvent).not.toHaveBeenCalled()
  })

  it("rejects an accepted recurring adjustment when fresh availability changes", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockBusyIntervals
      .mockResolvedValueOnce(FIRST_CONFLICT)
      .mockResolvedValueOnce([
        ...FIRST_CONFLICT,
        { start: "2026-07-28T14:15:00.000Z", end: "2026-07-28T14:45:00.000Z" },
      ])
    queueChoice(RECURRING)
    queueQuestion("Availability changed. Which time should I try instead?", ["requested_time_conflicts"])

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    const choiceIndex = await waitForMessageText(network, "safe alternative")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, choiceIndex)), runtimeEnv)
    await waitForMessageText(network, "Availability changed")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockGenerate.mock.calls[2]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "system", text: expect.stringContaining("availability changed") }),
    )
  })

  it("accepts the common-time branch at or above half of the recurring occurrences", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockBusyIntervals.mockResolvedValue([...FIRST_CONFLICT, ...SECOND_CONFLICT])
    queueChoice(RECURRING)

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    const choiceIndex = await waitForMessageText(network, "safe alternative")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, choiceIndex)), runtimeEnv)
    await waitForMessageText(network, "at 19:45")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:15:00.000Z" }))
    expect(mockReconcileManagedSeries).toHaveBeenCalledWith(expect.anything(), [])
  })

  it("asks for another series time when no common recurring time exists", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockBusyIntervals.mockResolvedValue(
      ["2026-07-28", "2026-08-04", "2026-08-11"].map((date) => ({
        start: `${date}T03:00:00.000Z`,
        end: `${date}T17:30:00.000Z`,
      })),
    )
    queueEvaluationQuestion(RECURRING, "I couldn't find one safe time for the complete series. Try another time.")

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    await waitForMessageText(network, "couldn't find one safe time")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).not.toHaveBeenCalled()
    expect(mockReconcileManagedSeries).not.toHaveBeenCalled()
  })

  it("routes one multi-issue agent request and resumes the persisted transcript", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueQuestion()
    queueReady(ONE_OFF)

    await handleTelegramWebhook(message("/calendar Schedule it"), runtimeEnv)
    const run = startWorkflow(calendar, runtimeEnv)
    await waitForMessageText(network, "title, date, and valid time")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(
      message("Call Jamie on 2026-07-28 at 7pm", 2, network.getState().nextMessageId - 1),
      runtimeEnv,
    )
    expect(calendar.get).toHaveBeenCalledWith("calendar-wf-1")
    await waitForMessageText(network, "Added: Call Jamie")
    calendar.timeout()
    await run

    expect(mockGenerate.mock.calls[1]?.[0].messages).toContainEqual({
      role: "user",
      text: "Call Jamie on 2026-07-28 at 7pm",
    })
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })

  it("routes a fixed conflict option through Telegram and freshly revalidates before writing", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const pipeline = createFakeWorkflowBinding()
    const runtimeEnv = env({
      INTERACTION_ROUTER: router.namespace,
      CALENDAR_WORKFLOW: calendar as never,
      PIPELINE_WORKFLOW: pipeline as never,
    })
    mockBusyIntervals.mockResolvedValue([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
    queueChoice(ONE_OFF)

    await handleTelegramWebhook(message("/calendar Call Jamie on 2026-07-28 at 7pm"), runtimeEnv)
    const run = startWorkflow(calendar, runtimeEnv)
    const conflictIndex = await waitForMessageText(network, "safe alternative")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, conflictIndex)), runtimeEnv)
    await waitForMessageText(network, "Added: Call Jamie")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:15:00.000Z" }))
    expect(pipeline.getReceivedEvents()).toHaveLength(0)
  })

  it("passes the created baseline through immediate Edit and updates without duplication", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueReady(ONE_OFF)
    queueReady({ ...ONE_OFF, proposal: { ...ONE_OFF.proposal, startTime: "20:00" } })

    await handleTelegramWebhook(message("/calendar Call Jamie on 2026-07-28 at 7pm"), runtimeEnv)
    const run = startWorkflow(calendar, runtimeEnv)
    const confirmationIndex = await waitForMessageText(network, "Added: Call Jamie")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, confirmationIndex)), runtimeEnv)
    await waitForMessageText(network, "Reply with the correction")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(message("Move it to 8pm", 2, network.getState().nextMessageId - 1), runtimeEnv)
    expect(calendar.get).toHaveBeenCalledWith("calendar-wf-1")
    await waitForMessageText(network, "Updated: Call Jamie")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockUpdateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockUpdateManagedEvent.mock.calls[0]?.[0].id).toBe(mockCreateManagedEvent.mock.calls[0]?.[0].id)
  })

  it("adds, changes, and removes recurring exceptions across whole-series Edit turns", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    const recurringAtEight = { ...RECURRING, proposal: { ...RECURRING.proposal, startTime: "20:00" } }
    const recurringAtNine = { ...RECURRING, proposal: { ...RECURRING.proposal, startTime: "21:00" } }
    const eightPmConflict = [{ start: "2026-07-28T14:30:00.000Z", end: "2026-07-28T15:00:00.000Z" }]
    mockBusyIntervals
      .mockResolvedValueOnce(FIRST_CONFLICT)
      .mockResolvedValueOnce(FIRST_CONFLICT)
      .mockResolvedValueOnce(eightPmConflict)
      .mockResolvedValueOnce(eightPmConflict)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    queueChoice(RECURRING)
    queueChoice(recurringAtEight)
    queueReady(recurringAtNine)

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    const firstChoiceIndex = await waitForMessageText(network, "safe alternative")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, firstChoiceIndex)), runtimeEnv)
    const addedIndex = await waitForMessageText(network, "Added: Weekly review", firstChoiceIndex)
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, addedIndex)), runtimeEnv)
    const firstEditIndex = await waitForMessageText(network, "correction for the entire recurring series", addedIndex)
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(
      message("Move the whole series to 8pm", 2, network.getState().nextMessageId - 1),
      runtimeEnv,
    )
    const secondChoiceIndex = await waitForMessageText(network, "safe alternative", firstEditIndex)
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, secondChoiceIndex)), runtimeEnv)
    const firstUpdateIndex = await waitForMessageText(network, "Updated: Weekly review", secondChoiceIndex)
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, firstUpdateIndex)), runtimeEnv)
    const secondEditIndex = await waitForMessageText(
      network,
      "correction for the entire recurring series",
      firstUpdateIndex,
    )
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(
      message("Move the whole series to 9pm", 3, network.getState().nextMessageId - 1),
      runtimeEnv,
    )
    await waitForMessageText(network, "Updated: Weekly review", secondEditIndex)
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockUpdateManagedEvent).toHaveBeenCalledTimes(2)
    const parentId = mockCreateManagedEvent.mock.calls[0]?.[0].id
    expect(mockUpdateManagedEvent.mock.calls.map(([event]) => event.id)).toEqual([parentId, parentId])
    expect(mockReconcileManagedSeries).toHaveBeenCalledTimes(3)
    expect(mockReconcileManagedSeries.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ start: "2026-07-28T14:15:00.000Z" }),
    ])
    expect(mockReconcileManagedSeries.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ originalStart: "2026-07-28T14:30:00.000Z" }),
    ])
    expect(mockReconcileManagedSeries.mock.calls[1]?.[1]?.[0]?.start).not.toBe(
      mockReconcileManagedSeries.mock.calls[0]?.[1]?.[0]?.start,
    )
    expect(mockReconcileManagedSeries.mock.calls[2]?.[1]).toEqual([])
  })

  it("reconnects once and re-evaluates a recurring request before writing", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({
      INTERACTION_ROUTER: router.namespace,
      CALENDAR_WORKFLOW: calendar as never,
      GOOGLE_CALENDAR_REDIRECT_ORIGIN: "",
    })
    mockBusyIntervals
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new MockGoogleCalendarError("disconnected", "authorization"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    queueReady(RECURRING)
    queueReady(RECURRING)

    await handleTelegramWebhook(
      message(
        "/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences",
        1,
        undefined,
        undefined,
        PRODUCTION_TEST_ORIGIN,
      ),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    const reconnectIndex = await waitForMessageText(network, "Reconnect, then tap Retry")
    expect(network.getState().telegramMessages[reconnectIndex]?.text).toContain(
      `${PRODUCTION_TEST_ORIGIN}/setup/google-calendar`,
    )
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, reconnectIndex)), runtimeEnv)
    await waitForMessageText(network, "Added: Weekly review", reconnectIndex)
    calendar.timeout()
    await run

    expect(mockGenerate).toHaveBeenCalledTimes(4)
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockReconcileManagedSeries).toHaveBeenCalledTimes(1)
    expect(mockGenerate.mock.calls[2]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "system", text: expect.stringContaining("authorization was restored") }),
    )
  })

  it("compensates a recurring parent when instance reconciliation fails after creation", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueReady(RECURRING)
    mockReconcileManagedSeries.mockRejectedValueOnce(new Error("reconciliation failed"))

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences"),
      runtimeEnv,
    )
    const run = startWorkflow(calendar, runtimeEnv)
    await waitForMessageText(network, "couldn't create that calendar block")
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(mockDeleteManagedEvent).toHaveBeenCalledWith(mockCreateManagedEvent.mock.calls[0]?.[0].id)
    expect(mockUpdateManagedEvent).not.toHaveBeenCalled()
  })

  it("does not dispatch expired or stale Calendar callbacks", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = createFakeWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    router.register(100, {
      interactionId: "expired",
      version: 1,
      workflowId: "calendar-wf",
      kind: INTERACTION_KIND.CALENDAR_EDIT,
      callbackToken: "expired",
      expiresAt: Date.now() - 1,
      interactionGroup: "calendar",
    })
    router.register(100, {
      interactionId: "old",
      version: 1,
      workflowId: "calendar-wf",
      kind: INTERACTION_KIND.CALENDAR_EDIT,
      callbackToken: "old",
      interactionGroup: "calendar",
    })
    router.register(100, {
      interactionId: "new",
      version: 2,
      workflowId: "calendar-wf",
      kind: INTERACTION_KIND.CALENDAR_EDIT,
      callbackToken: "new",
      interactionGroup: "calendar",
    })

    await handleTelegramWebhook(callback("expired", 3), runtimeEnv)
    await handleTelegramWebhook(callback("old", 4), runtimeEnv)

    expect(calendar.getReceivedEvents()).toHaveLength(0)
  })

  it("acknowledges but dispatches a duplicate Calendar callback only once", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = createFakeWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    router.register(100, {
      interactionId: "confirmation-edit",
      version: 1,
      workflowId: "calendar-wf",
      kind: INTERACTION_KIND.CALENDAR_EDIT,
      callbackToken: "confirmation-edit",
      interactionGroup: "calendar",
    })

    await handleTelegramWebhook(callback("confirmation-edit", 10), runtimeEnv)
    await handleTelegramWebhook(callback("confirmation-edit", 10), runtimeEnv)

    expect(calendar.getReceivedEvents()).toHaveLength(1)
  })
})
