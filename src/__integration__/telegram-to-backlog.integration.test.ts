import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import { createFakeInteractionRouter, createFakeNetwork, createFakeWorkflowBinding } from "./setup"

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
    INTERACTION_ROUTER: createFakeInteractionRouter().namespace,
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as never
}

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
    harness = createFakeNetwork({ githubFiles: { "ideas.md": "" } })
    binding = createFakeWorkflowBinding()
    vi.stubGlobal("fetch", harness.fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("handles /add by creating a raw idea in GitHub", async () => {
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
    const ideasMd = state.githubFiles.get("ideas.md")
    expect(ideasMd).toContain("id: 1")
    expect(ideasMd).toContain("status: raw")
    expect(ideasMd).toContain("source: telegram")
    expect(ideasMd).toContain("My post idea here")

    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Saved as idea")
  })

  it("handles /add with trailing whitespace only", async () => {
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
    const ideasMd = state.githubFiles.get("ideas.md")
    expect(ideasMd).toContain("id: 1")
    expect(ideasMd).toContain("status: raw")
  })

  it("handles /generate by creating a workflow for the oldest raw idea", async () => {
    harness = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 2
status: raw
created: 2026-07-02T12:00:00Z
source: manual
---

Idea two
---
id: 1
status: raw
created: 2026-07-01T12:00:00Z
source: telegram
---

Idea one`,
      },
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
    expect(created[0].params).toMatchObject({ params: { ideaId: "1", ideaBody: "Idea one" } })

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("Started workflow")
  })

  it("handles /generate with no raw ideas by returning a message", async () => {
    harness = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
status: awaiting-feedback
created: 2026-07-01T12:00:00Z
source: manual
---

Already in progress`,
      },
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
    expect(binding.getCreated().length).toBe(0)

    const state = harness.getState()
    expect(state.telegramMessages.length).toBe(1)
    expect(state.telegramMessages[0].text).toContain("No raw ideas")
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
  })
})
