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
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { INTERACTION_KIND } from "../types"
import { createFakeInteractionRouter, createFakeNetwork, createFakeWorkflowBinding } from "./setup"

const PROPOSAL = (startTime = "19:00") => ({
  title: { value: "Call Jamie", source: "explicit" as const },
  localDate: { value: "2026-07-28", source: "explicit" as const },
  startTime: { value: startTime, source: "explicit" as const },
  durationMinutes: { value: 30, source: "inferred" as const },
  classification: { value: "ordinary", source: "inferred" as const },
})

function queueProposal(startTime = "19:00"): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [{ id: "proposal", name: "submit_one_off_proposal", input: PROPOSAL(startTime) }],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
}

function queueClarification(message = "What date should I schedule this for?"): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [{ id: "clarify", name: "request_clarification", input: { message } }],
    usage: { inputTokens: 0, outputTokens: 0 },
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
        const event = events.shift()
        if (event) resolve(event)
        else waiter = resolve
      }),
    timeout: () => {
      if (waiter) {
        const resolve = waiter
        waiter = undefined
        resolve({ type: "timeout" })
      } else events.push({ type: "timeout" })
    },
    created,
  }
}

async function waitForMessages(network: ReturnType<typeof createFakeNetwork>, count: number): Promise<void> {
  await vitest.waitFor(() => expect(network.getState().telegramMessages.length).toBeGreaterThanOrEqual(count))
}

function callbackToken(network: ReturnType<typeof createFakeNetwork>, messageIndex: number): string {
  const markup = network.getState().telegramMessages[messageIndex]?.replyMarkup
  const keyboard = markup?.inline_keyboard as Array<Array<{ callback_data: string }>>
  return keyboard[0][0].callback_data
}

describe("calendar Telegram workflow integration", () => {
  beforeEach(() => {
    vitest.useFakeTimers()
    vitest.setSystemTime(new Date("2026-07-01T00:00:00.000Z"))
    mockGenerate.mockReset()
    mockBusyIntervals.mockReset()
    mockCreateManagedEvent.mockReset()
    mockUpdateManagedEvent.mockReset()
  })
  afterEach(() => {
    vitest.useRealTimers()
    vitest.unstubAllGlobals()
  })

  it("binds a clarification reply from Telegram to Calendar, then creates the proposed block", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueClarification()
    queueProposal()
    mockBusyIntervals.mockResolvedValue([])

    await handleTelegramWebhook(message("/calendar Call Jamie", 1), runtimeEnv)
    expect(calendar.created).toEqual([
      { id: "calendar-wf-1", params: { params: { chatId: "100", requestText: "Call Jamie", telegramMessageId: 1 } } },
    ])

    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      { instanceId: "calendar-wf-1", payload: (calendar.created[0].params as { params: unknown }).params },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )
    await waitForMessages(network, 2)
    expect(network.getState().telegramMessages[1]?.replyMarkup).toEqual({ force_reply: true })
    await handleTelegramWebhook(message("tomorrow at 7pm", 2), runtimeEnv)
    await waitForMessages(network, 3)
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
    expect(calendar.get).toHaveBeenCalledWith("calendar-wf-1")
  })

  it("routes a Calendar conflict alternative callback through the router and never through LinkedIn", async () => {
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
    queueProposal()
    mockBusyIntervals.mockResolvedValue([{ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T14:00:00.000Z" }])
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      {
        instanceId: "calendar-wf-1",
        payload: { chatId: "100", requestText: "Call Jamie on 2026-07-28 at 7pm", telegramMessageId: 1 },
      },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )
    await waitForMessages(network, 1)
    await handleTelegramWebhook(callback(callbackToken(network, 0)), runtimeEnv)
    await waitForMessages(network, 2)
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T14:15:00.000Z" }))
    expect(pipeline.getReceivedEvents()).toHaveLength(0)
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

  it("dispatches every Calendar control to Calendar while retaining LinkedIn routing", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = createFakeWorkflowBinding()
    const pipeline = createFakeWorkflowBinding()
    const runtimeEnv = env({
      INTERACTION_ROUTER: router.namespace,
      CALENDAR_WORKFLOW: calendar as never,
      PIPELINE_WORKFLOW: pipeline as never,
    })
    const calendarKinds = [
      INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
      INTERACTION_KIND.CALENDAR_CONFLICT_CANCEL,
      INTERACTION_KIND.CALENDAR_EDIT,
      INTERACTION_KIND.CALENDAR_RETRY,
    ]
    for (const [index, kind] of calendarKinds.entries()) {
      router.register(100, {
        interactionId: `calendar-${index}`,
        version: index + 1,
        workflowId: "calendar-wf",
        kind,
        callbackToken: `calendar-${index}`,
        interactionGroup: `calendar-${index}`,
      })
      await handleTelegramWebhook(callback(`calendar-${index}`, 20 + index), runtimeEnv)
    }
    router.register(100, {
      interactionId: "linkedin-approve",
      version: 1,
      workflowId: "linkedin-wf",
      kind: INTERACTION_KIND.APPROVE,
      callbackToken: "linkedin-approve",
    })
    await handleTelegramWebhook(callback("linkedin-approve", 30), runtimeEnv)

    expect(calendar.getReceivedEvents()).toHaveLength(calendarKinds.length)
    expect(
      calendar.getReceivedEvents().map((event) => (event.event as { payload: { text: string } }).payload.text),
    ).toEqual(calendarKinds.map((kind) => `__${kind}__`))
    expect(pipeline.getReceivedEvents()).toMatchObject([
      { instanceId: "linkedin-wf", event: { payload: { text: "__approve__" } } },
    ])
  })
})
