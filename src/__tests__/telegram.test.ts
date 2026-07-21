import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

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

  function callbackEnv() {
    const sendEvent = vi.fn()
    const get = vi.fn().mockResolvedValue({ sendEvent })
    const env = mockEnv()
    env.PIPELINE_WORKFLOW.get = get
    return { env, sendEvent, get }
  }

  it("handles confirm callback_query", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
    const { env, sendEvent, get } = callbackEnv()

    const res = await handleTelegramWebhook(callbackRequest(callbackBody("confirm:wf-abc")), env as never)
    expect(res.status).toBe(200)
    expect(get).toHaveBeenCalledWith("wf-abc")
    expect(sendEvent).toHaveBeenCalledWith({ type: "telegram-reply", payload: { userId: 42, text: "__approve__" } })
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("answerCallbackQuery"), expect.any(Object))
  })

  it("handles revise callback_query by setting pendingRevision", async () => {
    const REVISE_IDEAS = `---
id: 1
title: Test
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-xyz
---

Body`

    let putBody = ""
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") {
        putBody = opts.body as string
        return { ok: true, json: () => Promise.resolve({}) }
      }
      if (url?.includes?.("api.telegram.org"))
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 200 } }) }
      return { ok: true, json: () => Promise.resolve({ content: b64(REVISE_IDEAS), sha: "s1" }) }
    })
    const { env, sendEvent, get } = callbackEnv()

    const res = await handleTelegramWebhook(callbackRequest(callbackBody("revise:wf-xyz")), env as never)
    expect(res.status).toBe(200)
    expect(get).not.toHaveBeenCalled()
    expect(sendEvent).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("sendMessage"), expect.any(Object))
    const updated = JSON.parse(putBody)
    expect(atob(updated.content)).toContain("pendingRevision: 100")
  })

  it("routes free-text reply to correct chat when multiple pending revisions exist", async () => {
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

    const putBodies: string[] = []
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") {
        putBodies.push(JSON.parse(opts.body as string).content)
        return { ok: true, json: () => Promise.resolve({}) }
      }
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
      payload: { userId: 42, text: "Make it shorter" },
    })
    expect(sendEvent2).not.toHaveBeenCalled()
  })

  it("ignores callback_query with unknown prefix", async () => {
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
})
