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
const mockReconcileManagedSeries = vitest.hoisted(() => vitest.fn())
const mockDeleteManagedEvent = vitest.hoisted(() => vitest.fn())
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
    reconcileManagedSeries: mockReconcileManagedSeries,
    deleteManagedEvent: mockDeleteManagedEvent,
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

const UNTIMED_PROPOSAL = (durationMinutes = 30) => ({
  title: { value: "Call Jamie", source: "explicit" as const },
  localDate: { value: "2026-07-28", source: "explicit" as const },
  durationMinutes: { value: durationMinutes, source: "explicit" as const },
  classification: { value: "ordinary", source: "inferred" as const },
})

const RECURRING_PROPOSAL = {
  title: { value: "Weekly review", source: "explicit" as const },
  firstDate: { value: "2026-07-28", source: "explicit" as const },
  startTime: { state: "provided" as const, value: "19:00", source: "explicit" as const },
  durationMinutes: { value: 30, source: "inferred" as const },
  classification: { value: "ordinary", source: "inferred" as const },
  recurrence: {
    cadence: "weekly" as const,
    source: "explicit" as const,
    weekdays: { mode: "first_date_weekday" as const },
  },
  end: { mode: "count" as const, occurrences: 3, source: "explicit" as const },
  description: { state: "omitted" as const },
  location: { state: "omitted" as const },
  reminderMinutes: { state: "omitted" as const },
}

function queueProposal(startTime = "19:00"): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [{ id: "proposal", name: "submit_one_off_proposal", input: PROPOSAL(startTime) }],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
}

function queueUntimedProposal(durationMinutes = 30): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [{ id: "untimed-proposal", name: "submit_one_off_proposal", input: UNTIMED_PROPOSAL(durationMinutes) }],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
}

const SNAPSHOT_FIELD_NAMES = [
  "title",
  "localDate",
  "startTime",
  "durationMinutes",
  "classification",
  "description",
  "location",
  "reminderMinutes",
] as const

function dialogueSnapshot(fields: Record<string, { value: unknown; source: "explicit" | "inferred" }>) {
  return Object.fromEntries(SNAPSHOT_FIELD_NAMES.map((name) => [name, fields[name] ?? { source: "missing" }]))
}

function queueClarification(
  message = "What date should I schedule this for?",
  fields: Record<string, { value: unknown; source: "explicit" | "inferred" }> = {},
  missingField = "localDate",
): void {
  mockGenerate.mockResolvedValueOnce({
    toolCalls: [
      {
        id: "clarify",
        name: "request_clarification",
        input: { message, missingField, fields: dialogueSnapshot(fields) },
      },
    ],
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
    isWaiting: () => Boolean(waiter),
    created,
  }
}

async function waitForMessages(network: ReturnType<typeof createFakeNetwork>, count: number): Promise<void> {
  await vitest.waitFor(() => expect(network.getState().telegramMessages.length).toBeGreaterThanOrEqual(count))
}

async function waitForWorkflowWait(calendar: ReturnType<typeof liveWorkflowBinding>): Promise<void> {
  await vitest.waitFor(() => expect(calendar.isWaiting()).toBe(true))
}

async function waitForMessageText(
  network: ReturnType<typeof createFakeNetwork>,
  text: string,
  count = 1,
): Promise<void> {
  try {
    await vitest.waitFor(() =>
      expect(network.getState().telegramMessages.filter((message) => message.text?.includes(text))).toHaveLength(count),
    )
  } catch {
    const observed = network
      .getState()
      .telegramMessages.map((message) => message.text)
      .filter(Boolean)
      .join(" | ")
    throw new Error(`Expected ${count} Telegram message(s) containing "${text}". Observed: ${observed}`)
  }
}

function callbackToken(network: ReturnType<typeof createFakeNetwork>, messageIndex: number, buttonIndex = 0): string {
  const markup = network.getState().telegramMessages[messageIndex]?.replyMarkup
  const keyboard = markup?.inline_keyboard as Array<Array<{ callback_data: string }>>
  return keyboard[0][buttonIndex].callback_data
}

describe("calendar Telegram workflow integration", () => {
  beforeEach(() => {
    vitest.useFakeTimers()
    vitest.setSystemTime(new Date("2026-07-01T00:00:00.000Z"))
    mockGenerate.mockReset()
    mockBusyIntervals.mockReset()
    mockCreateManagedEvent.mockReset()
    mockUpdateManagedEvent.mockReset()
    mockReconcileManagedSeries.mockReset()
    mockDeleteManagedEvent.mockReset()
    mockReconcileManagedSeries.mockResolvedValue(undefined)
    mockDeleteManagedEvent.mockResolvedValue(undefined)
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

  it("routes a recurring Telegram request through one native parent and bounded instance reconciliation", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockGenerate.mockResolvedValueOnce({
      toolCalls: [{ id: "recurring", name: "submit_recurring_proposal", input: RECURRING_PROPOSAL }],
      usage: {},
    })
    mockBusyIntervals.mockResolvedValue([])

    await handleTelegramWebhook(
      message("/calendar Weekly review every Tuesday at 7pm starting 2026-07-28 for 3 occurrences", 1),
      runtimeEnv,
    )
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      { instanceId: "calendar-wf-1", payload: (calendar.created[0].params as { params: unknown }).params },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )
    await waitForMessageText(network, "3 occurrences")
    calendar.timeout()
    await run

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ recurrence: [expect.stringContaining("COUNT=3")] }),
    )
    expect(mockReconcileManagedSeries).toHaveBeenCalledWith(expect.anything(), [])
  })

  it("checks an explicit Telegram time only in deterministic Calendar code", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockGenerate
      .mockResolvedValueOnce({
        toolCalls: [
          {
            id: "obsolete-availability-tool",
            name: "get_available_slots",
            input: { localDate: "2026-07-28", durationMinutes: 30 },
          },
        ],
        usage: {},
      })
      .mockResolvedValueOnce({
        toolCalls: [{ id: "proposal", name: "submit_one_off_proposal", input: PROPOSAL("14:30") }],
        usage: {},
      })
    mockBusyIntervals.mockResolvedValue([])

    await handleTelegramWebhook(message("/calendar Call Jamie on 2026-07-28 at 2:30pm", 1), runtimeEnv)
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      { instanceId: "calendar-wf-1", payload: (calendar.created[0].params as { params: unknown }).params },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )
    await waitForMessages(network, 2)
    calendar.timeout()
    await run

    expect(mockGenerate.mock.calls[0][0].tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "get_available_slots" })]),
    )
    expect(mockBusyIntervals).toHaveBeenCalledTimes(1)
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T09:00:00.000Z" }))
  })

  it("recovers a missing required handoff inside a webhook-started Calendar workflow", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    mockGenerate.mockResolvedValueOnce({ text: "I need more details.", usage: {} }).mockResolvedValueOnce({
      toolCalls: [{ id: "proposal", name: "submit_one_off_proposal", input: PROPOSAL("14:30") }],
      usage: {},
    })
    mockBusyIntervals.mockResolvedValue([])

    await handleTelegramWebhook(message("/calendar Call Jamie on 2026-07-28 at 2:30pm", 1), runtimeEnv)
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      { instanceId: "calendar-wf-1", payload: (calendar.created[0].params as { params: unknown }).params },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )
    await waitForMessages(network, 2)
    calendar.timeout()
    await run

    expect(mockGenerate).toHaveBeenCalledTimes(2)
    expect(mockGenerate.mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([
        { role: "assistant", text: "I need more details." },
        {
          role: "user",
          text: expect.stringContaining("did not invoke a required handoff action"),
        },
      ]),
    )
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })

  it("keeps the scheduled time when a Telegram Edit changes only duration", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueUntimedProposal(30)
    queueUntimedProposal(15)
    mockBusyIntervals.mockResolvedValue([])

    await handleTelegramWebhook(message("/calendar Call Jamie on 2026-07-28 for 30 minutes", 1), runtimeEnv)
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      { instanceId: "calendar-wf-1", payload: (calendar.created[0].params as { params: unknown }).params },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )
    await waitForMessages(network, 2)
    await handleTelegramWebhook(callback(callbackToken(network, 1)), runtimeEnv)
    await waitForMessages(network, 3)
    await handleTelegramWebhook(message("Make this a 15 min call please", 2), runtimeEnv)
    await waitForMessages(network, 4)
    calendar.timeout()
    await run

    expect(mockBusyIntervals).toHaveBeenCalledTimes(1)
    expect(mockUpdateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2026-07-28T13:30:00.000Z", end: "2026-07-28T13:45:00.000Z" }),
    )
  })

  it("retains an offered slot when Telegram binds a concise confirmation reply", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    queueClarification("The only available slot on July 30 is at 19:00. Would you like that time?")
    queueProposal("19:00")
    mockBusyIntervals.mockResolvedValue([])

    await handleTelegramWebhook(message("/calendar Call Jamie", 1), runtimeEnv)
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      { instanceId: "calendar-wf-1", payload: (calendar.created[0].params as { params: unknown }).params },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )
    await waitForMessages(network, 2)
    await handleTelegramWebhook(message("Proceed", 2), runtimeEnv)
    await waitForMessages(network, 3)
    calendar.timeout()
    await run

    expect(mockGenerate.mock.calls[1]?.[0].messages[1].text).toContain(
      "Calendar planner asked: The only available slot on July 30 is at 19:00. Would you like that time?\nUser replied: Proceed",
    )
    expect(mockCreateManagedEvent).toHaveBeenCalledTimes(1)
  })

  it("preserves typed conflict state through confirmation, explanation, and another replacement", async () => {
    const network = createFakeNetwork()
    vitest.stubGlobal("fetch", network.fetch)
    const router = createFakeInteractionRouter()
    const calendar = liveWorkflowBinding()
    const runtimeEnv = env({ INTERACTION_ROUTER: router.namespace, CALENDAR_WORKFLOW: calendar as never })
    const initialFields = PROPOSAL("11:30")
    const replacementFields = PROPOSAL("14:30")
    queueProposal("11:30")
    queueClarification("Should I use 2:30pm tomorrow instead?", replacementFields)
    queueProposal("14:30")
    queueClarification("I can only see that 2:30pm is occupied. Would you like another time?", replacementFields)
    queueProposal("17:00")
    mockBusyIntervals
      .mockResolvedValueOnce([{ start: "2026-07-28T06:00:00.000Z", end: "2026-07-28T06:30:00.000Z" }])
      .mockResolvedValueOnce([{ start: "2026-07-28T09:00:00.000Z", end: "2026-07-28T09:30:00.000Z" }])
      .mockResolvedValueOnce([])

    await handleTelegramWebhook(message("/calendar Do laundry on 2026-07-28 at 11:30am", 1), runtimeEnv)
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: runtimeEnv })
    const run = (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(
      { instanceId: "calendar-wf-1", payload: (calendar.created[0].params as { params: unknown }).params },
      { do: vitest.fn(async (_: string, fn: () => unknown) => fn()), waitForEvent: calendar.waitForEvent },
    )

    await waitForMessages(network, 2)
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(callback(callbackToken(network, 1, 1)), runtimeEnv)
    await waitForMessageText(network, "Reply with a replacement time")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(message("2:30pm", 2), runtimeEnv)
    await waitForMessageText(network, "Should I use 2:30pm")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(message("Yes", 3), runtimeEnv)
    await waitForMessageText(network, "That time is not free", 2)
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(message("Why is 2:30pm not free?", 4), runtimeEnv)
    await waitForMessageText(network, "I can only see that 2:30pm is occupied")
    await waitForWorkflowWait(calendar)
    await handleTelegramWebhook(message("Can we try 5pm then?", 5), runtimeEnv)
    await waitForMessageText(network, "Added: Call Jamie")
    await waitForWorkflowWait(calendar)
    calendar.timeout()
    await run

    expect(mockGenerate.mock.calls[1]?.[0].messages[1].text).toContain(
      `"pendingConflict":{"localDate":"${initialFields.localDate.value}","requestedStartTime":"11:30"`,
    )
    expect(mockGenerate.mock.calls[3]?.[0].messages[1].text).toContain("Why is 2:30pm not free?")
    expect(mockGenerate.mock.calls[3]?.[0].messages[1].text).not.toContain("Replacement time: Why")
    expect(mockGenerate.mock.calls[4]?.[0].messages[1].text).toContain(
      '"startTime":{"value":"14:30","source":"explicit"}',
    )
    expect(mockCreateManagedEvent).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-07-28T11:30:00.000Z" }))
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
