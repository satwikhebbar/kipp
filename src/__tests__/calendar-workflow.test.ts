import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../types"

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
  }
  return { WorkflowEntrypoint }
})

const mockGenerate = vi.hoisted(() => vi.fn())
const mockBusyIntervals = vi.hoisted(() => vi.fn())
const mockCreateManagedEvent = vi.hoisted(() => vi.fn())

vi.mock("../providers", () => ({ createToolProvider: () => ({ generate: mockGenerate }) }))
vi.mock("../integrations/google-calendar", () => ({
  createGoogleCalendarClient: () => ({
    getBusyIntervals: mockBusyIntervals,
    createManagedEvent: mockCreateManagedEvent,
  }),
  GoogleCalendarError: class GoogleCalendarError extends Error {},
}))

import { CalendarWorkflow } from "../calendar-workflow"

function environment(): Env {
  return {
    TELEGRAM_BOT_TOKEN: "bot-token",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    LLM_MAX_RETRIES: "0",
    TIMEZONE: "Asia/Kolkata",
  } as Env
}

function workflowEvent() {
  return {
    instanceId: "calendar-workflow-1",
    payload: { chatId: "123", requestText: "Call Jamie tomorrow at 7pm", telegramMessageId: 456 },
  }
}

describe("CalendarWorkflow", () => {
  beforeEach(() => {
    mockGenerate.mockReset()
    mockBusyIntervals.mockReset()
    mockCreateManagedEvent.mockReset()
  })

  it("creates exactly one deterministic Calendar event from a bounded proposal", async () => {
    mockGenerate
      .mockResolvedValueOnce({
        toolCalls: [
          {
            id: "proposal",
            name: "submit_one_off_proposal",
            input: {
              title: "Call Jamie",
              localDate: "2026-07-28",
              startTime: "19:00",
              durationMinutes: 30,
              dateIsExplicit: true,
              timeIsExplicit: true,
              classification: "ordinary",
              needsClarification: false,
            },
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      })
      .mockResolvedValueOnce({ text: "", usage: { inputTokens: 0, outputTokens: 0 } })
    mockBusyIntervals.mockResolvedValue([])
    mockCreateManagedEvent.mockResolvedValue(undefined)
    const telegram = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ result: { message_id: 1 } }) })
    vi.stubGlobal("fetch", telegram)
    const step = { do: vi.fn(async (_name: string, fn: () => unknown) => fn()) }
    const workflow = new CalendarWorkflow({} as never, {} as never)
    Object.assign(workflow, { env: environment() })

    await (workflow as unknown as { run: (event: unknown, step: unknown) => Promise<void> }).run(workflowEvent(), step)

    expect(mockCreateManagedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Call Jamie", timeZone: "Asia/Kolkata", reminderMinutes: 10 }),
    )
    expect(telegram).toHaveBeenLastCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("Added: Call Jamie") }),
    )
  })
})
