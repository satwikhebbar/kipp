import { afterEach, describe, expect, it, vi } from "vitest"
import { handleTelegramWebhook } from "../triggers/telegram-webhook"
import type { Env } from "../types"
import { PipelineWorkflow } from "../workflow"
import { createFakeNetwork } from "./setup"

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
    ctx!: unknown
  }
  return { WorkflowEntrypoint }
})

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
    LINKEDIN_REFRESH_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    SUBSTACK_RSS_URL: "",
    POSTING_CADENCE_DAYS: "7",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  }
}

describe("security-boundaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects requests with invalid webhook secret", async () => {
    vi.stubGlobal("fetch", createFakeNetwork().fetch)
    const env = baseEnv()
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
      }),
      env,
    )
    expect(res.status).toBe(401)
  })

  it("rejects messages from disallowed users", async () => {
    vi.stubGlobal("fetch", createFakeNetwork().fetch)
    const env = baseEnv({ TELEGRAM_ALLOWED_USER_ID: "42" })
    const body = JSON.stringify({
      update_id: 1,
      message: { message_id: 1, from: { id: 99, is_bot: false }, chat: { id: 99, type: "private" }, text: "/add test" },
    })
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env,
    )
    expect(res.status).toBe(403)
  })

  it("rejects callback queries from disallowed users", async () => {
    vi.stubGlobal("fetch", createFakeNetwork().fetch)
    const env = baseEnv({ TELEGRAM_ALLOWED_USER_ID: "42" })
    const body = JSON.stringify({
      update_id: 1,
      callback_query: {
        id: "cq-1",
        from: { id: 99 },
        message: { message_id: 1, chat: { id: 100 } },
        data: "confirm:wf-1",
      },
    })
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env,
    )
    expect(res.status).toBe(403)
  })

  it("rejects revise callback queries from disallowed users", async () => {
    vi.stubGlobal("fetch", createFakeNetwork().fetch)
    const env = baseEnv({ TELEGRAM_ALLOWED_USER_ID: "42" })
    const body = JSON.stringify({
      update_id: 1,
      callback_query: {
        id: "cq-2",
        from: { id: 99 },
        message: { message_id: 1, chat: { id: 100 } },
        data: "revise:wf-1",
      },
    })
    const res = await handleTelegramWebhook(
      new Request("http://localhost", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "my-secret", "Content-Type": "application/json" },
        body,
      }),
      env,
    )
    expect(res.status).toBe(403)
  })

  it("returns 404 for unseeded GitHub files in the fake harness", async () => {
    const { fetch } = createFakeNetwork()
    const res = await fetch("https://api.github.com/repos/o/r/contents/nonexistent.md")
    expect(res.status).toBe(404)
  })

  it("throws on unexpected external fetch", async () => {
    const { fetch } = createFakeNetwork()
    await expect(fetch("https://unexpected-api.example.com/data")).rejects.toThrow("Unexpected fetch")
  })

  it("does not leak LinkedIn token in Telegram error message on publish failure", async () => {
    const telegramTexts: string[] = []

    const stepDo = vi.fn(async (_name: string, fn: () => unknown) => fn())
    const waitForEvent = vi.fn()

    const { fetch: harnessFetch } = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
status: raw
created: 2026-07-01T12:00:00Z
source: manual
correlation:
  telegramChatId: "42"
---

Body content`,
      },
      llmResponses: [
        { choices: [{ message: { content: "My draft" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
        {
          choices: [{ message: { content: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]) } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        },
      ],
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
        if (urlStr.includes("api.linkedin.com")) {
          return {
            ok: false,
            status: 401,
            text: () => Promise.resolve(JSON.stringify({ error: "invalid_token", access_token: "leaked-secret-abc" })),
          }
        }
        if (urlStr.includes("api.telegram.org")) {
          const parsed = JSON.parse(opts?.body as string) as { text?: string; chat_id?: number }
          if (parsed.text) telegramTexts.push(parsed.text)
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        }
        return harnessFetch(url, opts)
      }),
    )

    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: {
        ...baseEnv(),
        LINKEDIN_ACCESS_TOKEN: "valid-token",
        LINKEDIN_AUTHOR_URN: "urn:li:person:123",
      },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(
      {
        payload: { ideaId: "1", ideaBody: "Body content" },
        instanceId: "wf-1",
        timestamp: new Date(),
        workflowName: "",
      },
      { do: stepDo, waitForEvent, sleep: vi.fn(), sleepUntil: vi.fn() },
    )

    const leakedMsg = telegramTexts.find((t) => t.includes("leaked-secret-abc"))
    expect(leakedMsg).toBeUndefined()
    const safeMsg = telegramTexts.find((t) => t.includes("HTTP 401"))
    expect(safeMsg).toBeDefined()
  })
})
