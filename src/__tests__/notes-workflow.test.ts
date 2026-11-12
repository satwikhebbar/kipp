import { afterEach, expect, it, vi } from "vitest"
import { createInteractionRouter } from "../core/interaction-router-client"
import type { Env } from "../core/types"
import { createTelegramClient } from "../integrations/telegram"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { sqliteInteractionRouter } from "./fixtures/interaction-router"

afterEach(() => vi.unstubAllGlobals())

function envFixture() {
  const ids = new Set<string>()
  const create = vi.fn(async ({ id }: { id: string }) => {
    if (ids.has(id)) throw new Error("exists")
    ids.add(id)
  })
  const sendEvent = vi.fn(async (_event: unknown) => {})
  const fixture = sqliteInteractionRouter()
  const env = {
    TELEGRAM_BOT_TOKEN: "test",
    TELEGRAM_WEBHOOK_SECRET: "test",
    TELEGRAM_ALLOWED_USER_ID: "42",
    BUFFER_PUBLICATIONS: {},
    INTERACTION_ROUTER: fixture.namespace,
    NOTES_WORKFLOW: {
      create,
      get: async (id: string) => ({ status: async () => ({ status: ids.has(id) ? "running" : "unknown" }), sendEvent }),
    },
  } as unknown as Env
  const requests: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true, result: { message_id: 1 } })
    }),
  )
  const update = (body: unknown, secret = "test") =>
    handleTelegramWebhook(
      new Request("https://kipp.test/webhook/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(body),
      }),
      env,
    )
  return { env, create, ids, sendEvent, update, requests }
}

it("authenticates /note and recovers a duplicate command without starting a second instance", async () => {
  const h = envFixture()
  const update = {
    update_id: 1,
    message: { message_id: 10, from: { id: 42 }, chat: { id: 100, type: "private" }, text: "/note raw thought" },
  }
  expect((await h.update(update, "wrong")).status).toBe(401)
  expect((await h.update({ ...update, message: { ...update.message, from: { id: 43 } } })).status).toBe(403)
  expect(h.create).not.toHaveBeenCalled()
  expect((await h.update(update)).status).toBe(200)
  expect((await h.update(update)).status).toBe(200)
  expect(h.ids.size).toBe(1)
  expect(h.create.mock.calls[0][0]).toMatchObject({
    params: { userId: "42", chatId: "100", requestText: "raw thought", telegramMessageId: 10 },
  })
})

it("returns 503 on uncertain command creation instead of acknowledging a lost invocation", async () => {
  const h = envFixture()
  h.create.mockRejectedValueOnce(new Error("lost"))
  expect(
    (
      await h.update({
        update_id: 1,
        message: { message_id: 10, from: { id: 42 }, chat: { id: 100 }, text: "/note raw thought" },
      })
    ).status,
  ).toBe(503)
})

it("resends the same retained authenticated event after a lost sendEvent response", async () => {
  const h = envFixture()
  const router = createInteractionRouter(h.env.INTERACTION_ROUTER, "100")
  await router.register({
    interactionId: "publish",
    workflowId: "wf",
    version: 1,
    kind: "notes-publish",
    callbackToken: "n:publish",
    expiresAt: Date.now() + 60_000,
    notes: { userId: "42", chatId: "100", fingerprint: "hash" },
  })
  h.sendEvent.mockRejectedValueOnce(new Error("lost response after enqueue"))
  const update = {
    update_id: 5,
    callback_query: { id: "cq", data: "n:publish", from: { id: 42 }, message: { message_id: 1, chat: { id: 100 } } },
  }
  expect((await h.update(update)).status).toBe(503)
  expect((await h.update(update)).status).toBe(200)
  expect(h.sendEvent).toHaveBeenCalledTimes(2)
  expect(h.sendEvent.mock.calls[0]).toEqual(h.sendEvent.mock.calls[1])
  expect(h.sendEvent.mock.calls[0][0]).toMatchObject({
    type: "notes-interaction",
    payload: { userId: "42", chatId: "100", telegramUpdateId: 5 },
  })
  expect((await h.update(update)).status).toBe(200)
  expect(h.sendEvent).toHaveBeenCalledTimes(2)
})

it("uses literal plain text and suppresses previews when Notes requests it, preserving legacy defaults", async () => {
  const h = envFixture()
  const tg = createTelegramClient("test")
  await tg.sendMessage("100", "*literal* _text_ https://example.com", { plainText: true, disableLinkPreview: true })
  expect(h.requests[0]).not.toHaveProperty("parse_mode")
  expect(h.requests[0]).toMatchObject({
    text: "*literal* _text_ https://example.com",
    link_preview_options: { is_disabled: true },
  })
  await tg.sendMessage("100", "legacy")
  expect(h.requests[1]).toMatchObject({ parse_mode: "Markdown" })
})
