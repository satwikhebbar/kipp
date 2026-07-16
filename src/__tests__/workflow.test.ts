import { describe, expect, it, vi } from "vitest"
import type { Env } from "../types"

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
    ctx!: unknown
  }
  return { WorkflowEntrypoint }
})

const mockCreateGenerator = vi.hoisted(() => vi.fn())
vi.mock("../providers", () => ({
  createGenerator: () => mockCreateGenerator,
}))

import { PipelineWorkflow } from "../workflow"

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function mockEnv(): Env {
  return {
    GITHUB_PAT: "pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    SUBSTACK_RSS_URL: "https://test.substack.com/feed",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "gemini",
    POSTING_CADENCE_DAYS: "7",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_USER_ID: "42",
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
    LINKEDIN_ACCESS_TOKEN: "",
    LINKEDIN_REFRESH_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    PIPELINE_WORKFLOW: {} as never,
  }
}

const STYLE_PROMPT = "Professional tone."

const mockIdeas = `---
id: 1
title: Test idea
status: raw
created: 2026-07-01T12:00:00Z
source: manual
correlation:
  telegramChatId: "42"
---

Body content`

describe("PipelineWorkflow", () => {
  const stepDo = vi.fn()
  const waitForEvent = vi.fn()

  function testRun() {
    stepDo.mockReset()
    stepDo.mockImplementation(async (_name: string, fn: () => unknown) => fn())
    waitForEvent.mockReset()
    mockCreateGenerator.mockReset()
  }

  function makeStep() {
    return { do: stepDo, waitForEvent, sleep: vi.fn(), sleepUntil: vi.fn() }
  }

  function makeEvent() {
    return {
      payload: { ideaId: "1", ideaTitle: "Test idea", ideaBody: "Body content" },
      instanceId: "wf-1",
      timestamp: new Date(),
      workflowName: "",
    }
  }

  it("generates draft, notifies, finalizes on approval", async () => {
    const responses = [
      { text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        if (url?.includes?.("api.telegram.org"))
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? mockIdeas : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )
    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(stepDo).toHaveBeenCalledWith("generate", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify-not-configured", expect.any(Function))
  })

  it("times out when no feedback received, marking idea as expired", async () => {
    const responses = [
      { text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        if (url?.includes?.("api.telegram.org"))
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? mockIdeas : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )
    waitForEvent.mockResolvedValue({ type: "timeout" })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(stepDo).toHaveBeenCalledWith("generate", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("timeout-0", expect.any(Function))
    expect(stepDo).not.toHaveBeenCalledWith("notify-published", expect.any(Function))
    expect(stepDo).not.toHaveBeenCalledWith("archive", expect.any(Function))
    expect(stepDo).not.toHaveBeenCalledWith("linkedin-publish", expect.any(Function))
  })

  it("does not leak LinkedIn token in Telegram error message or console.error on publish failure", async () => {
    const responses = [
      { text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]
    let callIdx = 0
    let telegramText = ""
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url?.includes?.(".linkedin-tokens.json"))
          return { ok: false, status: 404, text: () => Promise.resolve("Not found") }
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        if (url?.includes?.("api.linkedin.com"))
          return {
            ok: false,
            status: 401,
            text: () => Promise.resolve(JSON.stringify({ error: "invalid_token", access_token: "leaked-secret-abc" })),
          }
        if (url?.includes?.("api.telegram.org")) {
          const body = JSON.parse(opts?.body as string) as { text?: string }
          telegramText = body.text ?? ""
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? mockIdeas : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )

    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: {
        ...mockEnv(),
        LINKEDIN_ACCESS_TOKEN: "valid-token",
        LINKEDIN_AUTHOR_URN: "urn:li:person:123",
        LINKEDIN_CLIENT_ID: "client-id",
        LINKEDIN_CLIENT_SECRET: "client-secret",
        LINKEDIN_REFRESH_TOKEN: "refresh-token",
      },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    consoleSpy.mockRestore()

    expect(stepDo).toHaveBeenCalledWith("linkedin-publish", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify-publish-failed", expect.any(Function))
    expect(telegramText).not.toContain("leaked-secret-abc")
    expect(telegramText).not.toContain("valid-token")
    expect(telegramText).toContain("HTTP 401")

    const allErrorOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(allErrorOutput).not.toContain("leaked-secret-abc")
    expect(allErrorOutput).not.toContain("valid-token")
  })

  it("revises on feedback and notifies on second approval without LinkedIn", async () => {
    const responses = [
      { text: "First draft", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: false, feedback: "Weak opening" }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      { text: "Revised draft", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      { text: "Revised with feedback", usage: { inputTokens: 5, outputTokens: 3 } },
    ]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        if (url?.includes?.("api.telegram.org"))
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? mockIdeas : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )
    waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "Make it shorter" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(stepDo).toHaveBeenCalledWith(expect.stringContaining("revise-"), expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify-not-configured", expect.any(Function))
  })
})
