import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { createBaseEnv, createFakeNetwork, createFakeWorkflowBinding } from "./setup"

const baseEnv = createBaseEnv

function telegramRequest(body: unknown) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("telegram-to-backlog", () => {
  let harness: ReturnType<typeof createFakeNetwork>
  let binding: ReturnType<typeof createFakeWorkflowBinding>

  beforeEach(() => {
    harness = createFakeNetwork()
    binding = createFakeWorkflowBinding()
    vi.stubGlobal("fetch", harness.fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("handles /add by creating a raw idea in Notion", async () => {
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 1,
        message: {
          message_id: 5,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/add My post idea here",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const state = harness.getState()
    const pages = [...state.notionPages.values()]
    expect(pages).toHaveLength(1)
    expect(pages[0].kippId).toBe(1)
    expect(pages[0].status).toBe("raw")
    expect(pages[0].source).toBe("telegram")
    expect(pages[0].markdown).toBe("My post idea here")
    expect(pages[0].chatId).toBe("100")

    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Saved as idea")
  })

  it("rejects /add with only whitespace as a usage prompt", async () => {
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 1,
        message: {
          message_id: 5,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/add   ",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const state = harness.getState()
    expect([...state.notionPages.values()]).toHaveLength(0)
    expect(state.telegramMessages).toHaveLength(1)
    expect(state.telegramMessages[0].text).toBe("Usage: /add <idea text>")
  })

  it("handles /generate by creating a workflow for the named idea", async () => {
    harness = createFakeNetwork({
      notionPages: [
        {
          pageId: "page_1",
          kippId: 1,
          title: "",
          status: "raw",
          source: "telegram",
          markdown: "Idea one",
        },
        {
          pageId: "page_2",
          kippId: 2,
          title: "",
          status: "raw",
          source: "manual",
          markdown: "Idea two",
        },
      ],
    })
    vi.stubGlobal("fetch", harness.fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 2,
        message: {
          message_id: 6,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/generate 2",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const created = binding.getCreated()
    expect(created.length).toBe(1)
    expect(created[0].params).toMatchObject({ pageId: "page_2", ideaId: "2", source: "manual" })

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Started workflow")
  })

  it("starts a workflow for a named substack idea", async () => {
    harness = createFakeNetwork({
      notionPages: [
        {
          pageId: "page_1",
          kippId: 1,
          title: "",
          status: "raw",
          source: "substack",
          markdown: "From Substack",
          substackUrl: "https://example.substack.com/p/one",
        },
      ],
    })
    vi.stubGlobal("fetch", harness.fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 2,
        message: {
          message_id: 6,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/generate 1",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const created = binding.getCreated()
    expect(created.length).toBe(1)
    expect(created[0].params).toMatchObject({ pageId: "page_1", ideaId: "1", source: "substack" })
  })

  it("rejects /generate for an idea that is not raw", async () => {
    harness = createFakeNetwork({
      notionPages: [
        {
          pageId: "page_1",
          kippId: 1,
          title: "",
          status: "awaiting-feedback",
          source: "manual",
          markdown: "Already in progress",
        },
      ],
    })
    vi.stubGlobal("fetch", harness.fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 2,
        message: {
          message_id: 6,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/generate 1",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(binding.getCreated().length).toBe(0)

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Nothing to generate for that idea.")
  })

  it("defaults to the oldest raw idea when /generate has no idea id", async () => {
    harness = createFakeNetwork({
      notionPages: [
        {
          pageId: "page_2",
          kippId: 2,
          title: "Idea two",
          status: "raw",
          source: "manual",
          markdown: "Idea two",
        },
        {
          pageId: "page_1",
          kippId: 1,
          title: "Idea one",
          status: "raw",
          source: "telegram",
          markdown: "Idea one",
        },
      ],
    })
    vi.stubGlobal("fetch", harness.fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 2,
        message: {
          message_id: 6,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/generate",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const created = binding.getCreated()
    expect(created.length).toBe(1)
    expect(created[0].params).toMatchObject({ pageId: "page_1", ideaId: "1", source: "telegram" })

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Idea one")
  })

  it("reports when /generate has no idea id and no raw ideas exist", async () => {
    harness = createFakeNetwork({ notionPages: [] })
    vi.stubGlobal("fetch", harness.fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 20,
        message: {
          message_id: 30,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/generate",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(binding.getCreated().length).toBe(0)

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("No raw ideas to generate from.")
  })

  it("responds to unknown commands with help message", async () => {
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 3,
        message: {
          message_id: 7,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "/unknown",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Unknown command")
    expect(state.telegramMessages[0].text).toContain("/generate [idea id]")
  })

  it("advertises /generate [idea id] in the plain-text fallthrough help message", async () => {
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const res = await handleTelegramWebhook(
      telegramRequest({
        update_id: 4,
        message: {
          message_id: 9,
          from: { id: 42, is_bot: false, first_name: "Test" },
          chat: { id: 100, type: "private" },
          text: "just some text",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Unknown command")
    expect(state.telegramMessages[0].text).toContain("/generate [idea id]")
  })
})
