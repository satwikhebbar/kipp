import { describe, expect, it, vi } from "vitest"
import { TranscriptTooLargeError } from "../conversation"
import type { Env } from "../types"

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
    ctx!: unknown
  }
  return { WorkflowEntrypoint }
})

const mockCreateGenerator = vi.hoisted(() => vi.fn())
const mockResolveModel = vi.hoisted(() => vi.fn((_p: string, m?: string) => m ?? "deepseek-v4-flash"))
vi.mock("../providers", () => ({
  createGenerator: () => mockCreateGenerator,
  resolveModel: mockResolveModel,
}))

const mockAssertStepOutputSize = vi.hoisted(() => vi.fn((v: unknown) => v))
vi.mock("../conversation", async () => {
  const actual = await vi.importActual("../conversation")
  return {
    ...actual,
    appendAssistant: (msgs: unknown[], content: string) => [...(msgs as unknown[]), { role: "assistant", content }],
    appendHumanFeedback: (msgs: unknown[], feedback: string) => [
      ...(msgs as unknown[]),
      { role: "user", content: feedback },
    ],
    assertStepOutputSize: mockAssertStepOutputSize,
  }
})

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
    LINKEDIN_AUTHOR_URN: "",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    TOKEN_VAULT: {
      idFromName: () => "mock-do-id",
      get: () => ({ fetch: () => Promise.resolve(new Response(JSON.stringify({ tokens: null }))) }),
    } as never,
    TOKEN_ENCRYPTION_KEY_IDS: "test-key",
    ACCESS_TEAM: "test-team",
    ACCESS_AUDIENCE: "test-aud",
    ACCESS_ADMIN_EMAILS: "admin@test.com",
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
    mockAssertStepOutputSize.mockReset()
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
        ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true",
        LINKEDIN_ACCESS_TOKEN: "valid-token",
        LINKEDIN_AUTHOR_URN: "urn:li:person:123",
        LINKEDIN_CLIENT_ID: "client-id",
        LINKEDIN_CLIENT_SECRET: "client-secret",
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

  it("revision generator receives style, initial request, earlier drafts, and Telegram feedback in order", async () => {
    const responses = [
      { text: "First draft", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      { text: "Revised with feedback", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]
    let callIdx = 0
    const genCalls: { messages: { role: string; content: string }[] }[] = []

    testRun()
    mockCreateGenerator.mockImplementation(async (opts) => {
      genCalls.push(opts as { messages: { role: string; content: string }[] })
      return responses[callIdx++]
    })
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
      .mockResolvedValueOnce({ type: "event", payload: { text: "Make it more academic" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    // genCalls: [draft, critique, revise, critique]
    const reviseMessages = genCalls[2].messages
    expect(reviseMessages[0]).toEqual({ role: "system", content: STYLE_PROMPT })
    expect(reviseMessages[1].role).toBe("user")
    expect(reviseMessages[1].content).toContain("Test idea")
    expect(reviseMessages[1].content).toContain("Body content")
    const draftMsgs = reviseMessages.filter((m) => m.role === "assistant")
    expect(draftMsgs[0].content).toBe("First draft")
    const feedbackMsgs = reviseMessages.filter((m) => m.role === "user" && m.content === "Make it more academic")
    expect(feedbackMsgs).toHaveLength(1)
    const feedbackIdx = reviseMessages.findIndex((m) => m.content === "Make it more academic")
    expect(reviseMessages[feedbackIdx - 1].role).toBe("assistant")
  })

  it("second revision also receives the first feedback and first revised draft", async () => {
    const responses = [
      { text: "Initial draft", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      { text: "Revised one", usage: { inputTokens: 5, outputTokens: 3 } },
      { text: "Revised two", usage: { inputTokens: 5, outputTokens: 3 } },
    ]
    let callIdx = 0
    const genCalls: { messages: { role: string; content: string }[] }[] = []

    testRun()
    mockCreateGenerator.mockImplementation(async (opts) => {
      genCalls.push(opts as { messages: { role: string; content: string }[] })
      return responses[callIdx++]
    })
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
      .mockResolvedValueOnce({ type: "event", payload: { text: "first feedback" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "second feedback" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    // genCalls: [draft, critique, revise1, revise2]
    const secondReviseMessages = genCalls[3].messages
    expect(secondReviseMessages.some((m) => m.role === "user" && m.content === "first feedback")).toBe(true)
    expect(secondReviseMessages.some((m) => m.role === "assistant" && m.content === "Revised one")).toBe(true)
    expect(secondReviseMessages.some((m) => m.role === "user" && m.content === "second feedback")).toBe(true)
  })

  it("Revise More (__revise__) adds no synthetic transcript message; only a later real reply changes history", async () => {
    const responses = [
      { text: "Initial draft", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      { text: "Revised after __revise__", usage: { inputTokens: 5, outputTokens: 3 } },
      { text: "Revised after real reply", usage: { inputTokens: 5, outputTokens: 3 } },
    ]
    let callIdx = 0
    const genCalls: { messages: { role: string; content: string }[] }[] = []

    testRun()
    mockCreateGenerator.mockImplementation(async (opts) => {
      genCalls.push(opts as { messages: { role: string; content: string }[] })
      return responses[callIdx++]
    })
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
      .mockResolvedValueOnce({ type: "event", payload: { text: "__revise__" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "actually make it shorter" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    // genCalls: [draft, critique, revise after __revise__, revise after real reply]
    const firstReviseMessages = genCalls[2].messages
    expect(firstReviseMessages.some((m) => m.content === "__revise__")).toBe(false)
    const lastAssistantBeforeInstruction = [...firstReviseMessages].reverse().find((m) => m.role === "assistant")
    expect(lastAssistantBeforeInstruction?.content).toBe("Initial draft")

    const secondReviseMessages = genCalls[3].messages
    expect(secondReviseMessages.some((m) => m.role === "user" && m.content === "actually make it shorter")).toBe(true)
    expect(secondReviseMessages.some((m) => m.content === "__revise__")).toBe(false)
  })

  it("throws TranscriptTooLargeError before any ideas.md update when the generate transcript is oversized", async () => {
    testRun()
    const putCalls: { url: string; opts?: RequestInit }[] = []
    mockCreateGenerator
      .mockResolvedValueOnce({ text: "big draft", usage: { inputTokens: 5, outputTokens: 3 } })
      .mockResolvedValueOnce({
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 3 },
      })
    mockAssertStepOutputSize.mockImplementation(() => {
      throw new TranscriptTooLargeError("too big", 950 * 1024, 900 * 1024)
    })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (opts?.method === "PUT") putCalls.push({ url, opts })
        if (url?.includes?.("api.telegram.org"))
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? mockIdeas : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await expect(
      (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep()),
    ).rejects.toThrow("too big")
    expect(putCalls.some((c) => c.url.includes("ideas.md"))).toBe(false)
  })

  it("includes cost line in initial Telegram notification", async () => {
    const responses = [
      { text: "My draft content", usage: { inputTokens: 100000, outputTokens: 50000 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 500, outputTokens: 200 },
      },
    ]
    let callIdx = 0
    const telegramTexts: string[] = []

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        if (url?.includes?.("api.telegram.org")) {
          const body = JSON.parse(opts?.body as string) as { text?: string }
          telegramTexts.push(body.text ?? "")
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? mockIdeas : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )
    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const notifyMsg = telegramTexts.find((t) => t.startsWith("*Draft for idea"))
    expect(notifyMsg).toBeDefined()
    expect(notifyMsg).toContain("Est. cost:")
    expect(notifyMsg).toContain("100500 in")
    expect(notifyMsg).toContain("50200 out")
    expect(notifyMsg).toContain("deepseek-v4-flash")
  })

  it("cumulative cost across revisions persists and appears in revised notification", async () => {
    const responses = [
      { text: "First draft", usage: { inputTokens: 100, outputTokens: 50 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: false, feedback: "Weak opening" }]),
        usage: { inputTokens: 30, outputTokens: 10 },
      },
      { text: "Revised draft", usage: { inputTokens: 200, outputTokens: 80 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 40, outputTokens: 15 },
      },
      // feedback loop revise-0: revise agent called once
      { text: "Feedback revised", usage: { inputTokens: 50, outputTokens: 25 } },
    ]
    let callIdx = 0
    const telegramTexts: string[] = []
    const fileStore: Record<string, string> = {
      "ideas.md": mockIdeas,
      "style-prompt.md": STYLE_PROMPT,
    }

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url?.includes?.("api.telegram.org")) {
          const body = JSON.parse(opts?.body as string) as { text?: string }
          telegramTexts.push(body.text ?? "")
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        }
        const path = url.split("/contents/")[1] ?? ""
        if (opts?.method === "PUT" && path in fileStore) {
          const reqBody = JSON.parse(opts?.body as string) as { content?: string }
          fileStore[path] = atob(reqBody.content ?? "")
          return { ok: true, json: () => Promise.resolve({}) }
        }
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        const content = fileStore[path] ?? ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )
    waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "Make it punchier" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const finalIdeaContent = fileStore["ideas.md"]
    expect(finalIdeaContent).toContain("costInputTokens: 420")
    expect(finalIdeaContent).toContain("costOutputTokens: 180")

    const notifyMsg = telegramTexts.find((t) => t.startsWith("*Revised draft for idea"))
    expect(notifyMsg).toBeDefined()
    expect(notifyMsg).toContain("Est. cost:")
    expect(notifyMsg).toContain("420 in")
    expect(notifyMsg).toContain("180 out")
  })

  it("cost fields persist through archive", async () => {
    const archiveMockIdeas = `---
id: 1
title: Test idea
status: raw
created: 2026-07-01T12:00:00Z
source: manual
correlation:
  telegramChatId: "42"
costInputTokens: "15"
costOutputTokens: "7"
costModel: deepseek-v4-flash
costUsd: "0.0000021"
---

Body content`
    const responses = [
      { text: "My draft", usage: { inputTokens: 10, outputTokens: 5 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]
    let callIdx = 0
    let archivePutContent = ""

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url?.includes?.("api.telegram.org"))
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        if (opts?.method === "PUT" && url.includes("contents/archive.md")) {
          const reqBody = JSON.parse(opts?.body as string) as { content?: string }
          archivePutContent = atob(reqBody.content ?? "")
          return { ok: true, json: () => Promise.resolve({}) }
        }
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? archiveMockIdeas : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )
    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: {
        ...mockEnv(),
        ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true",
        LINKEDIN_ACCESS_TOKEN: "valid-token",
        LINKEDIN_AUTHOR_URN: "urn:li:person:123",
        LINKEDIN_CLIENT_ID: "client-id",
        LINKEDIN_CLIENT_SECRET: "client-secret",
      },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(archivePutContent).toContain("costInputTokens: 15")
    expect(archivePutContent).toContain("costOutputTokens: 7")
  })

  it("accumulates cost on idea without telegramChatId", async () => {
    const noChatIdea = `---
id: 1
title: No chat
status: raw
created: 2026-07-01T12:00:00Z
source: manual
---

Body`
    const responses = [
      { text: "Draft", usage: { inputTokens: 100, outputTokens: 50 } },
      {
        text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]),
        usage: { inputTokens: 50, outputTokens: 20 },
      },
    ]
    let callIdx = 0
    const ideaPutBodies: string[] = []

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    waitForEvent.mockResolvedValue({ type: "timeout" })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (opts?.method === "PUT" && url.includes("contents/ideas.md")) {
          const reqBody = JSON.parse(opts?.body as string) as { content?: string }
          ideaPutBodies.push(atob(reqBody.content ?? ""))
          return { ok: true, json: () => Promise.resolve({}) }
        }
        if (opts?.method === "PUT") return { ok: true, json: () => Promise.resolve({}) }
        const path = url.split("/contents/")[1]
        const content = path === "ideas.md" ? noChatIdea : path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: { ...mockEnv(), TELEGRAM_BOT_TOKEN: "" } })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const costPut = ideaPutBodies.find((b) => b.includes("costInputTokens"))
    expect(costPut).toBeDefined()
    expect(costPut).toContain("costInputTokens: 150")
    expect(costPut).toContain("costOutputTokens: 70")
  })
})
