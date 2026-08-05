import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

import { INTERACTION_KIND, type WorkflowInteraction, type WorkflowInteractionKind } from "../core/types"
import { createTelegramClient } from "../integrations/telegram"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function mockEnv() {
  return {
    GITHUB_PAT: "pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "my-secret",
    TELEGRAM_ALLOWED_USER_ID: "",
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
    LINKEDIN_ACCESS_TOKEN: "",
    LINKEDIN_REFRESH_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    PIPELINE_WORKFLOW: { create: vi.fn(), get: vi.fn() },
    CALENDAR_WORKFLOW: undefined as Workflow | undefined,
    INTERACTION_ROUTER: {
      idFromName: vi.fn(() => "router-id"),
      get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ interaction: null })) })),
    },
  }
}

describe("createTelegramClient", () => {
  beforeEach(() => mockFetch.mockReset())

  it("sendMessage calls the Telegram API and returns message_id", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }) })
    const tg = createTelegramClient("bot:token")
    const result = await tg.sendMessage(123, "Hello")
    expect(result.messageId).toBe(42)
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot:token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"chat_id":123'),
      }),
    )
  })

  it("answerCallbackQuery calls the Telegram API", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
    const tg = createTelegramClient("bot:token")
    await tg.answerCallbackQuery("cq-id", "done")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot:token/answerCallbackQuery",
      expect.objectContaining({
        body: expect.stringContaining('"text":"done"'),
      }),
    )
  })

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve("bad") })
    const tg = createTelegramClient("bot:token")
    await expect(tg.sendMessage(1, "x")).rejects.toThrow("Telegram API error 400 on sendMessage")
  })
})

describe("handleTelegramWebhook", () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("rejects invalid webhook secret", async () => {
    const res = await handleTelegramWebhook(
      new Request("http://localhost", { headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" } }),
      mockEnv() as never,
    )
    expect(res.status).toBe(401)
  })

  it("rejects malformed JSON body", async () => {
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body: "not json",
      }),
      mockEnv() as never,
    )
    expect(res.status).toBe(400)
  })

  it("rejects null JSON body", async () => {
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body: "null",
      }),
      mockEnv() as never,
    )
    expect(res.status).toBe(400)
  })

  it("rejects array JSON body", async () => {
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      }),
      mockEnv() as never,
    )
    expect(res.status).toBe(400)
  })

  it("rejects scalar JSON body", async () => {
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body: '"just a string"',
      }),
      mockEnv() as never,
    )
    expect(res.status).toBe(400)
  })

  function callbackBody(data: string) {
    return JSON.stringify({
      update_id: 1,
      callback_query: { id: "cq-1", from: { id: 42 }, message: { message_id: 10, chat: { id: 100 } }, data },
    })
  }

  function callbackRequest(body: string) {
    return new Request("http://localhost", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
      body,
    })
  }

  type TestRoutedInteraction = WorkflowInteraction & { workflowId: string }
  const APPROVE_KIND: WorkflowInteractionKind = INTERACTION_KIND.APPROVE
  const REVISE_KIND: WorkflowInteractionKind = INTERACTION_KIND.REVISE

  function callbackEnv(interaction?: TestRoutedInteraction) {
    const sendEvent = vi.fn()
    const get = vi.fn().mockResolvedValue({ sendEvent })
    const env = mockEnv()
    env.PIPELINE_WORKFLOW.get = get
    env.INTERACTION_ROUTER = {
      idFromName: vi.fn(() => "router-id"),
      get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ interaction: interaction ?? null })) })),
    }
    return { env, sendEvent, get }
  }

  it("handles confirm callback_query", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
    const { env, sendEvent, get } = callbackEnv({
      interactionId: "i-1",
      version: 1,
      workflowId: "wf-abc",
      kind: APPROVE_KIND,
      telegramUpdateId: 1,
    })

    const res = await handleTelegramWebhook(callbackRequest(callbackBody("confirm:wf-abc")), env as never)
    expect(res.status).toBe(200)
    expect(get).toHaveBeenCalledWith("wf-abc")
    expect(sendEvent).toHaveBeenCalledWith({
      type: "telegram-reply",
      payload: expect.objectContaining({ userId: 42, text: "__approve__", interactionId: "i-1" }),
    })
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("answerCallbackQuery"), expect.any(Object))
  })

  it("routes revise callback through the interaction router without GitHub writes", async () => {
    mockFetch.mockImplementation(async (url: string, _opts?: RequestInit) => {
      if (url?.includes?.("api.telegram.org"))
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 200 } }) }
      return { ok: true, json: () => Promise.resolve({}) }
    })
    const { env, sendEvent, get } = callbackEnv({
      interactionId: "i-2",
      version: 1,
      workflowId: "wf-xyz",
      kind: REVISE_KIND,
      telegramUpdateId: 1,
    })

    const res = await handleTelegramWebhook(callbackRequest(callbackBody("revise:wf-xyz")), env as never)
    expect(res.status).toBe(200)
    expect(get).toHaveBeenCalledWith("wf-xyz")
    expect(sendEvent).toHaveBeenCalledWith({
      type: "telegram-reply",
      payload: expect.objectContaining({ text: "__revise__" }),
    })
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("api.github.com"), expect.any(Object))
  })

  it("routes plain revision feedback through the interaction router", async () => {
    const REVISIONS = `---
id: 1
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-one
  pendingRevision: 100
---

Idea 1
---
id: 2
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-two
  pendingRevision: 200
---

Idea 2`

    mockFetch.mockImplementation(async (url: string, _opts?: RequestInit) => {
      if (url?.includes?.("api.telegram.org"))
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
      return { ok: true, json: () => Promise.resolve({ content: b64(REVISIONS), sha: "s1" }) }
    })

    const sendEvent1 = vi.fn()
    const sendEvent2 = vi.fn()
    const env = mockEnv()
    env.PIPELINE_WORKFLOW.get = vi.fn((id: string) => {
      if (id === "wf-one") return Promise.resolve({ sendEvent: sendEvent1 })
      if (id === "wf-two") return Promise.resolve({ sendEvent: sendEvent2 })
      return Promise.reject(new Error("unknown"))
    }) as never
    env.INTERACTION_ROUTER = {
      idFromName: vi.fn(() => "router-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          Response.json({
            interaction: {
              interactionId: "i-feedback",
              version: 1,
              workflowId: "wf-one",
              kind: INTERACTION_KIND.REVISION_FEEDBACK,
              telegramUpdateId: 3,
              text: "Make it shorter",
            },
          }),
        ),
      })),
    }

    const body = JSON.stringify({
      update_id: 3,
      message: {
        message_id: 7,
        from: { id: 42, is_bot: false },
        chat: { id: 100, type: "private" },
        text: "Make it shorter",
      },
    })
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env as never,
    )

    expect(res.status).toBe(200)
    expect(sendEvent1).toHaveBeenCalledWith({
      type: "telegram-reply",
      payload: expect.objectContaining({ userId: 42, text: "Make it shorter", interactionId: "i-feedback" }),
    })
    expect(sendEvent2).not.toHaveBeenCalled()
  })

  it("ignores callback_query with an unknown router token", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
    const { env, sendEvent, get } = callbackEnv()

    const res = await handleTelegramWebhook(callbackRequest(callbackBody("bad-data")), env as never)
    expect(res.status).toBe(200)
    expect(get).not.toHaveBeenCalled()
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it("handles quick-capture message", async () => {
    const putBodies: string[] = []
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") {
        putBodies.push(opts.body as string)
        return { ok: true, json: () => Promise.resolve({}) }
      }
      if (url?.includes?.("api.telegram.org"))
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
      return { ok: true, json: () => Promise.resolve({ content: b64(""), sha: "s1" }) }
    })

    const body = JSON.stringify({
      update_id: 1,
      message: {
        message_id: 5,
        from: { id: 42, is_bot: false, first_name: "Test" },
        chat: { id: 100, type: "private" },
        text: "/add Quick idea here",
      },
    })
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      mockEnv() as never,
    )
    expect(res.status).toBe(200)
    expect(putBodies.length).toBeGreaterThanOrEqual(1)
    const decoded = atob(JSON.parse(putBodies[0]).content)
    expect(decoded).toContain("id: 1")
    expect(decoded).toContain("Quick idea here")
  })

  it("handles /generate command", async () => {
    const RAW = `---
id: 1
title: Raw idea
status: raw
created: 2026-07-01T12:00:00Z
source: manual
---

Body text`

    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
      if (url?.includes?.("api.telegram.org"))
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
      return { ok: true, json: () => Promise.resolve({ content: b64(RAW), sha: "s1" }) }
    })

    const env = mockEnv()
    env.PIPELINE_WORKFLOW.create = vi.fn().mockResolvedValue({ id: "wf-1" })

    const body = JSON.stringify({
      update_id: 2,
      message: {
        message_id: 6,
        from: { id: 42, is_bot: false, first_name: "Test" },
        chat: { id: 100, type: "private" },
        text: "/generate",
      },
    })
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env as never,
    )
    expect(res.status).toBe(200)
    expect(env.PIPELINE_WORKFLOW.create).toHaveBeenCalled()
  })

  it("shows Calendar help without invoking an LLM or workflow", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) })
    const env = mockEnv()
    const calendarWorkflow = { create: vi.fn() }
    env.CALENDAR_WORKFLOW = calendarWorkflow as never
    const body = JSON.stringify({
      update_id: 4,
      message: { message_id: 8, from: { id: 42 }, chat: { id: 100, type: "private" }, text: "/calendar" },
    })

    await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env as never,
    )

    expect(calendarWorkflow.create).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("sendMessage"), expect.any(Object))
  })

  it("starts the separate Calendar workflow for a Calendar request", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) })
    const env = mockEnv()
    const calendarWorkflow = { create: vi.fn().mockResolvedValue({ id: "calendar-1" }) }
    env.CALENDAR_WORKFLOW = calendarWorkflow as never
    const body = JSON.stringify({
      update_id: 5,
      message: {
        message_id: 9,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        text: "/calendar Call Jamie tomorrow at 7pm",
      },
    })

    await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env as never,
    )

    expect(calendarWorkflow.create).toHaveBeenCalledWith({
      params: {
        chatId: "100",
        requestText: "Call Jamie tomorrow at 7pm",
        telegramMessageId: 9,
        setupOrigin: "http://localhost",
      },
    })
  })

  it("routes an entity-addressed Calendar command separated by Telegram whitespace", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) })
    const env = mockEnv()
    const calendarWorkflow = { create: vi.fn().mockResolvedValue({ id: "calendar-1" }) }
    env.CALENDAR_WORKFLOW = calendarWorkflow as never
    const command = "/calendar@KippBot"
    const body = JSON.stringify({
      update_id: 6,
      message: {
        message_id: 10,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        text: `${command}\u00a0Schedule a recurring review of substack metrics`,
        entities: [{ type: "bot_command", offset: 0, length: command.length }],
      },
    })

    await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env as never,
    )

    expect(calendarWorkflow.create).toHaveBeenCalledWith({
      params: {
        chatId: "100",
        requestText: "Schedule a recurring review of substack metrics",
        telegramMessageId: 10,
        setupOrigin: "http://localhost",
      },
    })
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("Unknown command") }),
    )
  })

  it("logs privacy-safe command ingress metadata at info level", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) })
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const env = { ...mockEnv(), LOG_LEVEL: "info" as const }
    const calendarWorkflow = { create: vi.fn().mockResolvedValue({ id: "calendar-1" }) }
    env.CALENDAR_WORKFLOW = calendarWorkflow as never
    const command = "/calendar@KippBot"
    const requestText = "Private review details"

    await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          update_id: 7,
          message: {
            message_id: 11,
            from: { id: 42 },
            chat: { id: 100, type: "private" },
            text: `${command}\u00a0${requestText}`,
            entities: [{ type: "bot_command", offset: 0, length: command.length }],
          },
        }),
      }),
      env as never,
    )

    const ingress = log.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as { event?: string; details?: Record<string, unknown> })
      .find((entry) => entry.event === "telegram-message-ingress")
    expect(ingress?.details).toEqual({
      messageId: 11,
      chatType: "private",
      textLength: `${command}\u00a0${requestText}`.length,
      startsWithSlash: true,
      commandEntityPresent: true,
      commandEntityOffset: 0,
      commandEntityLength: command.length,
      botAddressed: true,
      separatorKind: "other-whitespace",
      separatorCodePoint: 160,
      parsedCommand: "calendar",
      calendarParsed: true,
      replyToBot: false,
    })
    expect(log.mock.calls.flat().join(" ")).not.toContain(requestText)
  })
})
