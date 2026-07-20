import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import type { Env } from "../types"
import { createFakeNetwork, createFakeWorkflowBinding } from "./setup"

function baseEnv(overrides?: Partial<Env>): Env {
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
    LINKEDIN_AUTHOR_URN: "",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    POSTING_CADENCE_DAYS: "7",
    SUBSTACK_RSS_URL: "",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    TOKEN_VAULT: {} as never,
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as never
}

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
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })

    const res = await handleTelegramWebhook(
      telegramCallbackRequest({
        update_id: 1,
        callback_query: {
          id: "cq-1",
          from: { id: 42 },
          message: { message_id: 10, chat: { id: 100 } },
          data: "confirm:wf-abc",
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

  it("sets pendingRevision on revise callback", async () => {
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
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })

    const res = await handleTelegramWebhook(
      telegramCallbackRequest({
        update_id: 1,
        callback_query: {
          id: "cq-2",
          from: { id: 42 },
          message: { message_id: 11, chat: { id: 100 } },
          data: "revise:wf-xyz",
        },
      }),
      env,
    )
    expect(res.status).toBe(200)

    const state = harness.getState()
    const ideasMd = state.githubFiles.get("ideas.md")
    expect(ideasMd).toContain("pendingRevision: 100")
    const revisionPrompt = state.telegramMessages.find((m) => m.text?.includes("Type your revision"))
    expect(revisionPrompt).toBeDefined()
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
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })

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
    const ideasMd = state.githubFiles.get("ideas.md")
    expect(ideasMd).not.toContain("pendingRevision: 100")
    expect(ideasMd).toContain("pendingRevision: 200")
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

  it("routes /add while pendingRevision is active as a new idea, not revision feedback", async () => {
    harness = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
status: awaiting-feedback
correlation:
  workflowInstanceId: wf-one
  pendingRevision: 100
---
Body text`,
      },
    })
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
    const ideasMd = state.githubFiles.get("ideas.md")
    expect(ideasMd).toContain("A new idea")
    expect(ideasMd).toContain("pendingRevision: 100")

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
    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })

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
