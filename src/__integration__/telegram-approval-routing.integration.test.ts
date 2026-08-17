import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { INTERACTION_KIND } from "../core/types"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { createBaseEnv, createFakeInteractionRouter, createFakeNetwork, createFakeWorkflowBinding } from "./setup"

const baseEnv = createBaseEnv

function telegramCallbackRequest(body: Record<string, unknown>) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function telegramMessageRequest(body: Record<string, unknown>) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("telegram-approval-routing", () => {
  let harness: ReturnType<typeof createFakeNetwork>
  let binding: ReturnType<typeof createFakeWorkflowBinding>

  beforeEach(() => {
    harness = createFakeNetwork()
    binding = createFakeWorkflowBinding()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("routes confirm callback to workflow sendEvent", async () => {
    vi.stubGlobal("fetch", harness.fetch)
    const router = createFakeInteractionRouter()
    router.register(100, {
      interactionId: "approve-1",
      version: 1,
      workflowId: "wf-abc",
      kind: INTERACTION_KIND.APPROVE,
      callbackToken: "approve-token",
    })
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never, INTERACTION_ROUTER: router.namespace })

    const res = await handleTelegramWebhook(
      telegramCallbackRequest({
        update_id: 1,
        callback_query: {
          id: "cq-1",
          from: { id: 42 },
          message: { message_id: 10, chat: { id: 100 } },
          data: "approve-token",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const events = binding.getReceivedEvents()
    expect(events.length).toBe(1)
    expect(events[0].instanceId).toBe("wf-abc")
    expect(events[0].event).toMatchObject({ type: "telegram-reply", payload: { text: "__approve__" } })
  })

  it("routes revise callback without mutating GitHub routing fields", async () => {
    harness = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-xyz
---

Body text`,
      },
    })
    vi.stubGlobal("fetch", harness.fetch)
    const router = createFakeInteractionRouter()
    router.register(100, {
      interactionId: "revise-1",
      version: 1,
      workflowId: "wf-xyz",
      kind: INTERACTION_KIND.REVISE,
      callbackToken: "revise-token",
    })
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never, INTERACTION_ROUTER: router.namespace })

    const res = await handleTelegramWebhook(
      telegramCallbackRequest({
        update_id: 1,
        callback_query: {
          id: "cq-2",
          from: { id: 42 },
          message: { message_id: 11, chat: { id: 100 } },
          data: "revise-token",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const events = binding.getReceivedEvents()
    expect(events).toHaveLength(1)
    expect(events[0].instanceId).toBe("wf-xyz")
    expect(events[0].event).toMatchObject({ type: "telegram-reply", payload: { text: "__revise__" } })
  })

  it("routes pending revision text to the correct workflow", async () => {
    harness = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-one
  pendingRevision: 100
---

Idea one
---
id: 2
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-two
  pendingRevision: 200
---

Idea two`,
      },
    })
    vi.stubGlobal("fetch", harness.fetch)
    const router = createFakeInteractionRouter()
    router.register(100, {
      interactionId: "feedback-1",
      version: 1,
      workflowId: "wf-one",
      kind: INTERACTION_KIND.REVISION_FEEDBACK,
    })
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never, INTERACTION_ROUTER: router.namespace })

    const res = await handleTelegramWebhook(
      telegramMessageRequest({
        update_id: 3,
        message: {
          message_id: 20,
          from: { id: 42, is_bot: false },
          chat: { id: 100, type: "private" },
          text: "Make it shorter",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const events = binding.getReceivedEvents()
    expect(events.length).toBe(1)
    expect(events[0].instanceId).toBe("wf-one")
    expect(events[0].event).toMatchObject({
      type: "telegram-reply",
      payload: { userId: 42, text: "Make it shorter" },
    })

    const state = harness.getState()
    expect(state.githubFiles.get("ideas.md")).toContain("pendingRevision: 100")
  })

  it("does not route text from a non-pending chat", async () => {
    harness = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-one
  pendingRevision: 100
---

Body`,
      },
    })
    vi.stubGlobal("fetch", harness.fetch)
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })

    const res = await handleTelegramWebhook(
      telegramMessageRequest({
        update_id: 4,
        message: {
          message_id: 21,
          from: { id: 42, is_bot: false },
          chat: { id: 999, type: "private" },
          text: "Hi there",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(binding.getReceivedEvents().length).toBe(0)

    const state = harness.getState()
    expect(state.githubFiles.get("ideas.md")).toContain("pendingRevision: 100")
  })

  it("routes /add while a revision is pending as a new idea, not revision feedback", async () => {
    harness = createFakeNetwork()
    vi.stubGlobal("fetch", harness.fetch)
    const env = baseEnv({ TELEGRAM_ALLOWED_USER_ID: "42", PIPELINE_WORKFLOW: binding as never })

    const res = await handleTelegramWebhook(
      telegramMessageRequest({
        update_id: 5,
        message: {
          message_id: 22,
          from: { id: 42, is_bot: false },
          chat: { id: 100, type: "private" },
          text: "/add A new idea",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const state = harness.getState()
    const pages = [...state.notionPages.values()]
    expect(pages).toHaveLength(1)
    expect(pages[0].markdown).toBe("A new idea")
    expect(pages[0].source).toBe("telegram")

    expect(binding.getReceivedEvents().length).toBe(0)
  })

  it("routes reply-to-bot-message to the correct workflow", async () => {
    harness = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-abc
  botMessageId: 50
---

Body`,
      },
    })
    vi.stubGlobal("fetch", harness.fetch)
    const router = createFakeInteractionRouter()
    router.register(100, {
      interactionId: "reply-1",
      version: 1,
      workflowId: "wf-abc",
      kind: INTERACTION_KIND.REVISION_FEEDBACK,
      botMessageId: 50,
    })
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never, INTERACTION_ROUTER: router.namespace })

    const res = await handleTelegramWebhook(
      telegramMessageRequest({
        update_id: 5,
        message: {
          message_id: 22,
          from: { id: 42, is_bot: false },
          chat: { id: 100, type: "private" },
          text: "Looks good",
          reply_to_message: {
            message_id: 50,
            from: { id: 123, is_bot: true },
          },
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const events = binding.getReceivedEvents()
    expect(events.length).toBe(1)
    expect(events[0].instanceId).toBe("wf-abc")
    expect(events[0].event).toMatchObject({
      type: "telegram-reply",
      payload: { userId: 42, text: "Looks good" },
    })
  })
})
