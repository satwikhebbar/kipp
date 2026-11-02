import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { URL as NodeURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import { workflowTimeoutError } from "../__tests__/fixtures/workflow-timeout"
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

import { CalendarWorkflow, type CalendarWorkflowParams } from "../calendar/workflow"
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
    needsClarification: false,
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
  let connected: Env | undefined
  const runs: Promise<void>[] = []
  let rejectWait: ((reason: Error) => void) | undefined
  let waiter: ((event: unknown) => void) | undefined
  return {
    connect: (env: Env) => {
      connected = env
    },
    settled: async () => Promise.all(runs),
    create: vitest.fn(async (input: { id?: string; params: CalendarWorkflowParams }) => {
      const id = input.id ?? "calendar-wf-1"
      if (created.some((run) => run.id === id)) throw new Error("Workflow already exists")
      created.push({ id, params: input })
      if (input.params.edit && connected) {
        const workflow = new CalendarWorkflow({} as never, {} as never)
        Object.assign(workflow, { env: connected })
        runs.push(
          workflow.run(
            { instanceId: id, payload: input.params } as never,
            {
              do: async (_: string, fn: () => unknown) => fn(),
              waitForEvent: () =>
                new Promise((resolve) => {
                  waiter = resolve
                }),
            } as never,
          ),
        )
      }
      return { id }
    }),
    get: vitest.fn(() => ({
      status: async () => ({ status: "running" }),
      sendEvent: vitest.fn(async (event: unknown) => {
        if (waiter) {
          const resolve = waiter
          waiter = undefined
          resolve(event)
        } else events.push(event)
      }),
    })),
    waitForEvent: () =>
      new Promise((resolve, reject) => {
        rejectWait = reject
        const queued = events.shift()
        if ((queued as { type?: string })?.type === "timeout") reject(workflowTimeoutError())
        else if (queued) resolve(queued)
        else waiter = resolve
      }),
    timeout: () => {
      if (waiter) {
        waiter = undefined
        rejectWait?.(workflowTimeoutError())
      } else events.push({ type: "timeout" })
    },
    isWaiting: () => Boolean(waiter),
    queuedEvents: () => [...events],
    created,
  }
}

function startWorkflow(calendar: ReturnType<typeof liveWorkflowBinding>, runtimeEnv: Env): Promise<void> {
  calendar.connect(runtimeEnv)
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
    await run
    expect(calendar.isWaiting()).toBe(false)
    await handleTelegramWebhook(callback(callbackToken(network, confirmationIndex)), runtimeEnv)
    await waitForMessageText(network, "Reply with the correction")
    await calendar.settled()
    await handleTelegramWebhook(message("Move it to 8pm", 2, network.getState().nextMessageId - 1), runtimeEnv)
    expect(calendar.created).toHaveLength(3)
    expect(calendar.get).not.toHaveBeenCalled()
    await waitForMessageText(network, "Updated: Call Jamie")
    await calendar.settled()
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
    await run
    await handleTelegramWebhook(callback(callbackToken(network, addedIndex)), runtimeEnv)
    const firstEditIndex = await waitForMessageText(network, "correction for the entire recurring series", addedIndex)
    await calendar.settled()
    await handleTelegramWebhook(
      message("Move the whole series to 8pm", 2, network.getState().nextMessageId - 1),
      runtimeEnv,
    )
    const secondChoiceIndex = await waitForMessageText(network, "safe alternative", firstEditIndex)
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, secondChoiceIndex)), runtimeEnv)
    const firstUpdateIndex = await waitForMessageText(network, "Updated: Weekly review", secondChoiceIndex)
    await calendar.settled()
    await handleTelegramWebhook(callback(callbackToken(network, firstUpdateIndex)), runtimeEnv)
    const secondEditIndex = await waitForMessageText(
      network,
      "correction for the entire recurring series",
      firstUpdateIndex,
    )
    await calendar.settled()
    await handleTelegramWebhook(
      message("Move the whole series to 9pm", 3, network.getState().nextMessageId - 1),
      runtimeEnv,
    )
    await waitForMessageText(network, "Updated: Weekly review", secondEditIndex)
    await calendar.settled()
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

describe("Cloudflare Workflows runtime contracts", () => {
  it.each([
    "calendar-agent-save-edit-context-0",
    "calendar-agent-confirmation-0-notify",
    "calendar-agent-confirmation-0-register",
    "uncheckpointed-create",
    "uncheckpointed-update",
    "uncheckpointed-confirmation",
    "oauth-recovery",
  ])("recovers the production Calendar workflow across runtime reboot: %s", async (scenario) => {
    const require = createRequire(import.meta.url)
    const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
    const { Miniflare } = runtimeRequire("miniflare") as {
      Miniflare: new (
        options: unknown,
      ) => {
        dispatchFetch(url: string, init?: RequestInit): Promise<Response>
        dispose(): Promise<void>
      }
    }
    const { build } = runtimeRequire("esbuild") as {
      build(options: unknown): Promise<{ outputFiles: { text: string }[] }>
    }
    const oauth = scenario === "oauth-recovery"
    const checkpointLost = scenario.startsWith("uncheckpointed-")
    const generationOnly = oauth || scenario === "uncheckpointed-create" || scenario === "uncheckpointed-confirmation"
    const boundary =
      scenario === "uncheckpointed-confirmation"
        ? "calendar-agent-confirmation-0-notify"
        : checkpointLost
          ? `calendar-agent-${generationOnly ? "create" : "update"}-0`
          : oauth
            ? "calendar-agent-edit-context-1"
            : scenario
    const candidate = {
      kind: "one_off",
      proposal: {
        title: "Runtime recovery probe",
        localDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
        startTime: "19:00",
        durationMinutes: 30,
        dateIsExplicit: true,
        timeIsExplicit: true,
        classification: "ordinary",
        needsClarification: false,
      },
    }
    const providerBodies: unknown[] = []
    const mutations: Array<{ operation: string; body: Record<string, unknown> }> = []
    const savedEvents = new Map<string, Record<string, unknown>>()
    const notifications: Array<{
      text: string
      options?: { replyMarkup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
    }> = []
    const entries: string[] = []
    const checkpoints: string[] = []
    let refreshAttempts = 0
    const boundaryModules: Record<string, string> = {
      providers: `export function createToolProvider() { return {generate: async (request) => (await fetch("https://probe/provider", {method:"POST", body:JSON.stringify(request)})).json()}; }`,
      "integrations/telegram": `export function createTelegramClient() { return {sendMessage: async (chatId, text, options) => (await fetch("https://probe/telegram", {method:"POST", body:JSON.stringify({chatId,text,options})})).json()}; }`,
    }
    const source = `
      import { CalendarWorkflow } from "./src/calendar/workflow";
      import { InteractionRouterDO } from "./src/core/interaction-router";
      import { TokenVaultDO } from "./src/core/token-vault";
      import { createTokenVault } from "./src/core/token-vault-client";
      export {TokenVaultDO};
      const now = Date.now;
      Date.now = () => now() + Number(globalThis.PROBE_CLOCK_OFFSET || 0);
      export class ProbeRouter extends InteractionRouterDO {
        constructor(ctx, env) { super(ctx, env); this.probeState = ctx; }
        async fetch(request) {
          if (new URL(request.url).pathname === "/latest") return Response.json(this.probeState.storage.sql.exec("SELECT session_id FROM edit_contexts WHERE active = 1").toArray());
          return super.fetch(request);
        }
      }
      export class RecoveryProbe extends CalendarWorkflow {
        async run(event, step) {
          globalThis.PROBE_CLOCK_OFFSET = this.env.PROBE_CLOCK_OFFSET;
          await fetch("https://probe/entry", {method:"POST", body:event.instanceId});
          const wrapped = {
            do: async (name, ...args) => {
              if (event.payload.probeBoundary === name && ${checkpointLost}) {
                const fn = args.pop();
                return step.do(name, {retries:{limit:2,delay:"1 second",backoff:"constant"}}, async (...fnArgs) => {
                  const result = await fn(...fnArgs);
                  if (!this.env.PROBE_RECOVERING) {
                    await fetch("https://probe/checkpoint", {method:"POST", body:event.instanceId});
                    throw new Error("Injected response/checkpoint loss after write");
                  }
                  return result;
                });
              }
              if (event.payload.probeBoundary === name) {
                await fetch("https://probe/checkpoint", {method:"POST", body:event.instanceId});
                await step.waitForEvent("injected-interruption", {type:"continue", timeout:"1 hour"});
              }
              return step.do(name, ...args);
            },
            waitForEvent: (...args) => step.waitForEvent(...args)
          };
          return super.run(event, wrapped);
        }
      }
      export default { async fetch(request, env) {
        globalThis.PROBE_CLOCK_OFFSET = env.PROBE_CLOCK_OFFSET;
        const url = new URL(request.url);
        const id = url.searchParams.get("id") || "generation";
        const router = env.INTERACTION_ROUTER.get(env.INTERACTION_ROUTER.idFromName("telegram-chat:chat"));
        if (url.pathname.startsWith("/router/")) return router.fetch(new Request("http://router/" + url.pathname.slice(8), request));
        if (url.pathname === "/generate" || url.pathname === "/authorize") {
          const expired = ${oauth} && url.pathname === "/generate";
          await createTokenVault(env, "google-calendar").writeTokens({access_token:"test-token",refresh_token:"refresh",expires_in:3600,created_at:new Date(Date.now() - (expired ? 7200000 : 0)).toISOString()});
          if (url.pathname === "/authorize") {
            await (await env.CALENDAR_WORKFLOW.get(id)).sendEvent({type:"telegram-reply",payload:{text:"__calendar-retry__"}});
            return Response.json({ok:true});
          }
          await env.CALENDAR_WORKFLOW.create({id,params:{chatId:"chat",telegramMessageId:1,requestText:"Create recovery probe",setupOrigin:"https://kipp.example",probeBoundary:${JSON.stringify(generationOnly ? boundary : null)}}});
          return Response.json({ok:true});
        }
        if (url.pathname === "/edit") {
          const [context] = await (await router.fetch("http://router/latest", {method:"POST",body:"{}"})).json();
          await env.CALENDAR_WORKFLOW.create({id, params:{chatId:"chat",telegramMessageId:2,requestText:"",probeBoundary:${JSON.stringify(boundary)},edit:{sessionId:context.session_id,userId:"42",text:"Keep this time",openPrompt:false}}});
          return Response.json({sessionId:context.session_id});
        }
        const instance = await env.CALENDAR_WORKFLOW.get(id);
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
          name: "external-service-boundaries",
          setup(plugin: {
            onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void
            onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void
          }) {
            plugin.onResolve({ filter: /\/(providers|integrations\/telegram)$/ }, ({ path }) => ({
              path: path.endsWith("providers") ? "providers" : "integrations/telegram",
              namespace: "boundary",
            }))
            plugin.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({
              contents: boundaryModules[path],
              loader: "js",
            }))
          },
        },
      ],
    })
    const persistence = await mkdtemp(join(tmpdir(), "kipp-edit-recovery-"))
    const options = {
      modules: true,
      script: outputFiles[0].text,
      compatibilityDate: "2026-07-08",
      bindings: {
        TELEGRAM_ALLOWED_USER_ID: "42",
        TELEGRAM_BOT_TOKEN: "test",
        TIMEZONE: "Asia/Kolkata",
        LOG_LEVEL: "error",
        GOOGLE_CALENDAR_CLIENT_ID: "test-client",
        GOOGLE_CALENDAR_CLIENT_SECRET: "test-secret",
        TOKEN_ENCRYPTION_KEY_IDS: "test",
        TOKEN_ENCRYPTION_KEY_test: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        PROBE_CLOCK_OFFSET: "0",
        PROBE_RECOVERING: "",
      },
      workflows: { CALENDAR_WORKFLOW: { name: "recovery-probe", className: "RecoveryProbe" } },
      durableObjects: {
        INTERACTION_ROUTER: { className: "ProbeRouter", useSQLite: true },
        TOKEN_VAULT: { className: "TokenVaultDO", useSQLite: true },
      },
      workflowsPersist: join(persistence, "workflows"),
      durableObjectsPersist: join(persistence, "router"),
      outboundService: async (request: Request) => {
        const url = new URL(request.url)
        if (url.hostname === "oauth2.googleapis.com") {
          refreshAttempts++
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        }
        if (url.hostname === "www.googleapis.com") {
          if (url.pathname.endsWith("/freeBusy")) return Response.json({ calendars: { primary: { busy: [] } } })
          if (request.method === "GET") {
            const saved = savedEvents.get(url.pathname.split("/").at(-1) ?? "")
            return Response.json(saved ?? {}, { status: saved ? 200 : 404 })
          }
          const body = (await request.json()) as Record<string, unknown>
          mutations.push({ operation: request.method === "POST" ? "create" : "update", body })
          if (request.method === "POST" && savedEvents.has(String(body.id))) return new Response(null, { status: 409 })
          savedEvents.set(String(body.id), body)
          return Response.json(body)
        }
        if (url.hostname !== "probe") throw new Error(`unexpected external request ${request.url}`)
        const path = url.pathname
        if (path === "/entry") {
          entries.push(await request.text())
          return new Response("ok")
        }
        if (path === "/checkpoint") {
          checkpoints.push(await request.text())
          return new Response("ok")
        }
        const body = (await request.json()) as { messages: ToolConversationMessage[]; text: string }
        if (path === "/provider") {
          providerBodies.push(body)
          const last = body.messages.at(-1)
          const evaluated = last?.role === "tool" && last.name === "evaluate_calendar_candidate"
          const planId = evaluated ? toolResult(body.messages, "evaluate_calendar_candidate").planId : undefined
          return Response.json({
            toolCalls: [
              {
                id: String(providerBodies.length),
                name: evaluated ? (planId ? "ready_to_create" : "needs_user_input") : "evaluate_calendar_candidate",
                input: evaluated
                  ? planId
                    ? { planId }
                    : { message: "Reconnect calendar.", reasonCodes: ["missing_time"], interaction: { kind: "reply" } }
                  : candidate,
              },
            ],
            usage: {},
          })
        }
        if (path === "/telegram") {
          notifications.push(body)
          return Response.json({ messageId: notifications.length })
        }
        throw new Error(`unexpected external request ${request.url}`)
      },
    }
    let runtime = new Miniflare(options)
    /** Polls observable runtime state with a bounded deadline. */
    async function waitFor(check: () => Promise<boolean>): Promise<void> {
      const deadline = Date.now() + 10_000
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`runtime recovery probe did not reach expected state: ${scenario}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    /** Reads the current status from the real workflow binding. */
    async function status(id: string): Promise<string> {
      return ((await (await runtime.dispatchFetch(`http://probe/status?id=${id}`)).json()) as { status: string }).status
    }
    const id = generationOnly ? "generation" : "edit-recovery"
    try {
      expect((await runtime.dispatchFetch("http://probe/generate")).ok).toBe(true)
      if (oauth) {
        await waitFor(async () => notifications.some((m) => m.text.includes("Reconnect, then tap Retry")))
        expect(savedEvents.size).toBe(0)
        expect(refreshAttempts).toBeGreaterThan(0)
        // Reboot while the production authorization prompt is waiting, then reconnect.
        await runtime.dispatchFetch("http://probe/pause?id=generation")
        await waitFor(async () => (await status("generation")) === "paused")
        await runtime.dispose()
        runtime = new Miniflare(options)
        expect(await status("generation")).toBe("paused")
        await runtime.dispatchFetch("http://probe/resume?id=generation")
        await waitFor(async () => entries.filter((entry) => entry === "generation").length === 2)
        expect((await runtime.dispatchFetch("http://probe/authorize")).ok).toBe(true)
      }
      let sessionId: string | undefined
      if (!generationOnly) {
        await waitFor(async () => (await status("generation")) === "complete")
        const edit = await runtime.dispatchFetch(`http://probe/edit?id=${id}`)
        expect(edit.ok, await edit.clone().text()).toBe(true)
        sessionId = ((await edit.json()) as { sessionId: string }).sessionId
      }
      await waitFor(async () => checkpoints.includes(id))
      expect(savedEvents.size).toBe(1)
      const providerCount = providerBodies.length
      const mutationCount = mutations.length
      const notificationCount = notifications.length
      await runtime.dispatchFetch(`http://probe/pause?id=${id}`)
      await waitFor(async () => (await status(id)) === "paused")
      await runtime.dispose()
      options.bindings.PROBE_RECOVERING = "true"
      // OAuth generation resumes beyond the original authorization/plan deadline.
      options.bindings.PROBE_CLOCK_OFFSET = oauth ? String(16 * 60_000) : "0"
      runtime = new Miniflare(options)
      expect(await status(id)).toBe("paused")
      if (!generationOnly) {
        const claim = await runtime.dispatchFetch("http://probe/router/edit/claim", {
          method: "POST",
          body: JSON.stringify({ resourceId: "calendar:generation", workflowId: "competitor", domain: "calendar" }),
        })
        expect(await claim.json()).toEqual({ ok: false })
      }
      await runtime.dispatchFetch(`http://probe/resume?id=${id}`)
      await waitFor(async () => entries.filter((entry) => entry === id).length === (oauth ? 3 : 2))
      if (!checkpointLost) await runtime.dispatchFetch(`http://probe/continue?id=${id}`)
      await waitFor(async () => (await status(id)) === "complete")
      expect(providerBodies).toHaveLength(providerCount)
      expect(savedEvents.size).toBe(1)
      const writeRetried = checkpointLost && scenario !== "uncheckpointed-confirmation"
      expect(mutations).toHaveLength(mutationCount + (writeRetried ? 1 : 0))
      if (writeRetried) expect(mutations.at(-1)).toEqual(mutations.at(-2))
      if (scenario === "uncheckpointed-confirmation") expect(notifications.at(-1)).toEqual(notifications.at(-2))
      expect(notifications).toHaveLength(scenario.includes("register") ? notificationCount : notificationCount + 1)
      expect(notifications.map((m) => m.text).join(" ")).not.toMatch(/couldn't|didn't return/)
      const latestContexts = (await (
        await runtime.dispatchFetch("http://probe/router/latest", { method: "POST", body: "{}" })
      ).json()) as Array<{ session_id: string }>
      expect(latestContexts).toEqual([{ session_id: expect.any(String) }])
      expect(latestContexts[0].session_id).not.toBe(sessionId)
      const token = notifications.at(-1)?.options?.replyMarkup?.inline_keyboard[0][0].callback_data
      expect(token).toBeTruthy()
      const resolved = await runtime.dispatchFetch("http://probe/router/resolve", {
        method: "POST",
        body: JSON.stringify({ callbackToken: token, telegramUpdateId: 99 }),
      })
      expect(await resolved.json()).toMatchObject({
        interaction: { workflowId: id, edit: { sessionId: latestContexts[0].session_id } },
      })
      const released = await runtime.dispatchFetch("http://probe/router/edit/claim", {
        method: "POST",
        body: JSON.stringify({ resourceId: "calendar:generation", workflowId: "competitor", domain: "calendar" }),
      })
      expect(await released.json()).toEqual({ ok: true })
    } finally {
      await runtime.dispose()
      await rm(persistence, { recursive: true, force: true })
    }
  }, 30_000)

  it("deduplicates edit delivery and recovers a terminated edit's SQLite lock in the actual runtime", async () => {
    const require = createRequire(import.meta.url)
    const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
    const { Miniflare } = runtimeRequire("miniflare") as {
      Miniflare: new (
        options: unknown,
      ) => {
        dispatchFetch(url: string, init?: RequestInit): Promise<Response>
        dispose(): Promise<void>
      }
    }
    const { build } = runtimeRequire("esbuild") as {
      build(options: unknown): Promise<{ outputFiles: { text: string }[] }>
    }
    const source = `
      import { WorkflowEntrypoint } from "cloudflare:workers";
      import { startEditWorkflow } from "./src/core/edit-workflow";
      import { InteractionRouterDO } from "./src/core/interaction-router";
      export class ProbeRouter extends InteractionRouterDO {
        constructor(ctx, env) { super(ctx, env); this.probeState = ctx; }
        async fetch(request) {
          if (new URL(request.url).pathname === "/probe-owner") {
            const row = this.probeState.storage.sql.exec("SELECT workflow_id FROM edit_locks WHERE resource_id = ?", "event").toArray()[0];
            return Response.json({owner: row?.workflow_id ?? null});
          }
          return super.fetch(request);
        }
      }
      export class EditProbe extends WorkflowEntrypoint {
        async run(event, step) {
          const router = this.env.ROUTER.get(this.env.ROUTER.idFromName("chat"));
          const claim = await step.do("claim", async () => {
            const response = await router.fetch("http://router/edit/claim", {
              method: "POST", body: JSON.stringify({resourceId: "event", workflowId: event.instanceId, domain: "calendar"})
            });
            return response.json();
          });
          if (!claim.ok) throw new Error("lock unavailable");
          await step.waitForEvent("feedback", {type: "feedback", timeout: "1 hour"});
          return {completed: true};
        }
      }
      export default {
        async fetch(request, env) {
          const url = new URL(request.url);
          const id = url.searchParams.get("id");
          if (url.pathname === "/start") {
            return Response.json({id: await startEditWorkflow(env.CALENDAR_WORKFLOW, id, {})});
          }
          if (url.pathname === "/start-lost-response") {
            const binding = {
              async create(options) {
                await env.CALENDAR_WORKFLOW.create(options);
                throw new Error("create response lost");
              },
              get(instanceId) { return env.CALENDAR_WORKFLOW.get(instanceId); }
            };
            return Response.json({id: await startEditWorkflow(binding, id, {})});
          }
          if (url.pathname === "/terminate") {
            await (await env.CALENDAR_WORKFLOW.get(id)).terminate();
            return Response.json({ok: true});
          }
          if (url.pathname === "/deliver") {
            await (await env.CALENDAR_WORKFLOW.get(id)).sendEvent({type: "feedback", payload: {}});
            return Response.json({ok: true});
          }
          if (url.pathname === "/status") {
            return Response.json(await (await env.CALENDAR_WORKFLOW.get(id)).status());
          }
          return env.ROUTER.get(env.ROUTER.idFromName("chat")).fetch(
            new Request("http://router" + url.pathname, request)
          );
        }
      };
    `
    const { outputFiles } = await build({
      stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      external: ["cloudflare:workers"],
    })
    const runtime = new Miniflare({
      modules: true,
      script: outputFiles[0].text,
      compatibilityDate: "2026-07-08",
      workflows: { CALENDAR_WORKFLOW: { name: "edit-probe", className: "EditProbe" } },
      durableObjects: { ROUTER: { className: "ProbeRouter", useSQLite: true } },
    })
    /** Waits for the actual runtime to settle into the requested workflow state. */
    async function waitForStatus(id: string, expected: string): Promise<void> {
      const deadline = Date.now() + 10_000
      let status: { status?: string } = {}
      do {
        status = await (await runtime.dispatchFetch(`http://probe/status?id=${id}`)).json()
        if (status.status === expected || status.status === "errored") break
        await new Promise((resolve) => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      expect(status, JSON.stringify(status)).toMatchObject({ status: expected })
    }
    /** Exercises the production router through its real Durable Object binding. */
    async function lockRequest(path: string, workflowId: string): Promise<unknown> {
      const response = await runtime.dispatchFetch(`http://probe${path}`, {
        method: "POST",
        body: JSON.stringify({ resourceId: "event", workflowId, domain: "calendar" }),
      })
      expect(response.ok).toBe(true)
      return response.json()
    }
    /** Waits for the workflow itself to acquire its lock before testing exclusion. */
    async function waitForOwner(id: string): Promise<void> {
      const deadline = Date.now() + 10_000
      let owner: unknown
      do {
        owner = await lockRequest("/probe-owner", id)
        if ((owner as { owner: string }).owner === id) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      expect(owner).toEqual({ owner: id })
    }
    try {
      const starts = await Promise.all([
        runtime.dispatchFetch("http://probe/start?id=first-update"),
        runtime.dispatchFetch("http://probe/start?id=first-update"),
      ])
      for (const response of starts) expect(response.ok).toBe(true)
      const [first, duplicate] = await Promise.all(starts.map((response) => response.json() as Promise<{ id: string }>))
      expect(first.id).toMatch(/^edit-[0-9a-f]{64}$/)
      expect(duplicate.id).toBe(first.id)
      await waitForOwner(first.id)
      expect(await lockRequest("/edit/claim", "competing-edit")).toEqual({ ok: false })

      expect((await runtime.dispatchFetch(`http://probe/terminate?id=${first.id}`)).ok).toBe(true)
      await waitForStatus(first.id, "terminated")
      const secondResponse = await runtime.dispatchFetch("http://probe/start?id=second-update")
      expect(secondResponse.ok).toBe(true)
      const second = (await secondResponse.json()) as { id: string }
      expect(second.id).not.toBe(first.id)
      await waitForOwner(second.id)

      expect(await lockRequest("/edit/release", first.id)).toEqual({ ok: true })
      expect(await lockRequest("/edit/claim", "competing-edit")).toEqual({ ok: false })
      expect(await lockRequest("/edit/claim", second.id)).toEqual({ ok: true })

      expect((await runtime.dispatchFetch(`http://probe/deliver?id=${second.id}`)).ok).toBe(true)
      await waitForStatus(second.id, "complete")
      const retry = await runtime.dispatchFetch("http://probe/start?id=second-update")
      expect(retry.ok).toBe(true)
      expect(await retry.json()).toEqual(second)
      await waitForStatus(second.id, "complete")
      // A completed run also permits recovery if its final lock release was lost.
      expect(await lockRequest("/edit/claim", "next-edit")).toEqual({ ok: true })
      expect(await lockRequest("/edit/release", "next-edit")).toEqual({ ok: true })

      const lost = await runtime.dispatchFetch("http://probe/start-lost-response?id=lost-update")
      expect(lost.ok).toBe(true)
      const recovered = (await lost.json()) as { id: string }
      await waitForOwner(recovered.id)
      const redelivery = await runtime.dispatchFetch("http://probe/start?id=lost-update")
      expect(redelivery.ok).toBe(true)
      expect(await redelivery.json()).toEqual(recovered)
    } finally {
      await runtime.dispose()
    }
  }, 30_000)

  it("normalizes an actual runtime timeout and receives actual event payloads", async () => {
    // Use Wrangler's bundled runtime so this checks the same implementation as local dev.
    const require = createRequire(import.meta.url)
    const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
    const { Miniflare } = runtimeRequire("miniflare") as {
      Miniflare: new (
        options: unknown,
      ) => {
        dispatchFetch(url: string): Promise<Response>
        dispose(): Promise<void>
      }
    }
    const { transform } = runtimeRequire("esbuild") as {
      transform(source: string, options: unknown): Promise<{ code: string }>
    }
    const adapter = await readFile(new NodeURL("../core/workflow-events.ts", import.meta.url), "utf8")
    const source = `${adapter}
      import { WorkflowEntrypoint } from "cloudflare:workers";
      export class TimeoutProbe extends WorkflowEntrypoint {
        async run(event, step) {
          return waitForWorkflowEvent(step, "probe", {type: "probe-event", timeout: "1 second"});
        }
      }
      export default {
        async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/start") {
            const instance = await env.PROBE.create({id: url.searchParams.get("id")});
            if (url.searchParams.has("deliver")) await instance.sendEvent({type: "probe-event", payload: {text: "hello"}});
            return Response.json({id: instance.id});
          }
          return Response.json(await (await env.PROBE.get(url.searchParams.get("id"))).status());
        }
      };
    `
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" })
    const runtime = new Miniflare({
      modules: true,
      script: code,
      compatibilityDate: "2026-07-08",
      workflows: { PROBE: { name: "timeout-probe", className: "TimeoutProbe" } },
    })
    try {
      for (const [id, deliver, expected] of [
        ["timeout-case", false, { type: "timeout" }],
        ["event-case", true, { type: "event", payload: { text: "hello" } }],
      ] as const) {
        expect((await runtime.dispatchFetch(`http://probe/start?id=${id}${deliver ? "&deliver=1" : ""}`)).ok).toBe(true)
        let status: { status?: string; output?: unknown; error?: unknown } = {}
        const deadline = Date.now() + 10_000
        do {
          status = await (await runtime.dispatchFetch(`http://probe/status?id=${id}`)).json()
          if (status.status === "complete" || status.status === "errored") break
          await new Promise((resolve) => setTimeout(resolve, 50))
        } while (Date.now() < deadline)
        expect(status, JSON.stringify(status)).toMatchObject({ status: "complete", output: expected })
      }
    } finally {
      await runtime.dispose()
    }
  }, 20_000)
})
