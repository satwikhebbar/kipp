import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest"
import type { ToolConversationMessage } from "../providers"
import type { Env } from "../types"

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

import { CalendarWorkflow } from "../calendar-workflow"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { INTERACTION_KIND } from "../types"
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

function queueQuestion(): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [
      {
        id: "question",
        name: "needs_user_input",
        input: {
          message: "Please provide a title, date, and valid time.",
          reasonCodes: ["invalid_title", "missing_date", "missing_or_invalid_time"],
          interaction: { kind: "reply" },
        },
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

function message(text: string, messageId = 1, replyTo?: number): Request {
  return request({
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 42, is_bot: false },
      chat: { id: 100, type: "private" },
      text,
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

async function waitForMessageText(network: ReturnType<typeof createFakeNetwork>, text: string): Promise<number> {
  try {
    await vitest.waitFor(() =>
      expect(network.getState().telegramMessages.some((candidate) => candidate.text?.includes(text))).toBe(true),
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
  return network.getState().telegramMessages.findIndex((candidate) => candidate.text?.includes(text))
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
})
