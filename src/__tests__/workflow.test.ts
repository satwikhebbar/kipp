import { describe, expect, it, vi } from "vitest"
import { TranscriptTooLargeError } from "../core/conversation"
import type { Env } from "../core/types"

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
  createToolProvider: () => ({
    generate: async (input: {
      messages: Array<
        | { role: string; text: string }
        | { role: "assistant"; toolCalls: Array<{ input: { response?: string } }> }
        | { role: "tool" }
      >
    }) => {
      const messages = input.messages.flatMap((message) => {
        if (message.role === "tool") return []
        if ("toolCalls" in message) return [{ role: "assistant", content: message.toolCalls[0]?.input.response ?? "" }]
        if ("text" in message) return [{ role: message.role, content: message.text }]
        return []
      })
      let response = await mockCreateGenerator({ messages })
      while (
        typeof response?.text === "string" &&
        response.text.trim().startsWith("[") &&
        response.text.includes('"passed"')
      )
        response = await mockCreateGenerator({ messages })
      if (response?.toolCalls) return response
      return {
        toolCalls: [
          {
            id: crypto.randomUUID(),
            name: "submit_linkedin_response",
            input: { response: response.text },
          },
        ],
        usage: response.usage,
      }
    },
  }),
  resolveModel: mockResolveModel,
}))

const mockAssertStepOutputSize = vi.hoisted(() => vi.fn((v: unknown) => v))
vi.mock("../core/conversation", async () => {
  const actual = await vi.importActual("../core/conversation")
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

import { PipelineWorkflow } from "../linkedin/workflow"

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const STYLE_PROMPT = "Professional tone."

interface HarnessPage {
  id: string
  kippId: number
  title: string
  status: string
  source: string
  markdown: string
  chatId?: string
}

function pageJson(page: HarnessPage) {
  const properties: Record<string, unknown> = {
    "Kipp ID": { unique_id: { prefix: null, number: page.kippId } },
    Status: { status: { name: page.status } },
    Source: { select: { name: page.source } },
    Title: { title: [{ type: "text", text: { content: page.title } }] },
  }
  if (page.chatId) properties["Chat ID"] = { rich_text: [{ type: "text", text: { content: page.chatId } }] }
  return {
    object: "page",
    id: page.id,
    created_time: "2026-07-01T12:00:00Z",
    last_edited_time: "2026-07-02T12:00:00Z",
    properties,
  }
}

/** Builds a fetch mock that routes GitHub prompt reads, Notion page/markdown/PATCH, Telegram, and LinkedIn. */
function buildFetch(pages: HarnessPage[], opts: { linkedinStatus?: number; linkedinBody?: string } = {}) {
  const state = pages.map((page) => ({ ...page }))
  const patches: { pageId: string; body: Record<string, unknown> }[] = []
  const telegramTexts: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const ok = (body: unknown, status = 200) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    if (url.includes("api.notion.com")) {
      const md = url.match(/\/v1\/pages\/([^/]+)\/markdown$/)
      if (md) {
        const page = state.find((p) => p.id === md[1])
        if (!page) return ok({ message: "object_not_found" }, 404)
        return ok({
          object: "page_markdown",
          id: page.id,
          markdown: page.markdown,
          truncated: false,
          unknown_block_ids: [],
        })
      }
      const pageMatch = url.match(/\/v1\/pages\/([^/]+)$/)
      if (pageMatch) {
        const page = state.find((p) => p.id === pageMatch[1])
        if (!page) return ok({ message: "object_not_found" }, 404)
        if (init?.method === "PATCH") {
          const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>
          patches.push({ pageId: page.id, body })
          const status = (body.properties as Record<string, { status?: { name?: string } }>)?.Status?.status?.name
          if (status) page.status = status
          return ok({ object: "page", id: page.id })
        }
        return ok(pageJson(page))
      }
    }
    if (url.includes("api.github.com")) {
      const path = url.split("/contents/")[1] ?? ""
      const content = path === "style-prompt.md" ? STYLE_PROMPT : ""
      return ok({ content: b64(content), sha: "s1", encoding: "base64" })
    }
    if (url.includes("api.telegram.org")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { text?: string }
      telegramTexts.push(body.text ?? "")
      return ok({ ok: true, result: { message_id: 100 } })
    }
    if (url.includes("api.linkedin.com")) {
      return ok(
        opts.linkedinBody ?? { id: "urn:li:draft:123", "x-restli-id": "urn:li:draft:123" },
        opts.linkedinStatus ?? 201,
      )
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  return { fetchMock, patches, telegramTexts }
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
    NOTION_API_KEY: "secret",
    NOTION_IDEAS_DATA_SOURCE_ID: "ds-1",
    NOTION_FREE_TIER: "false",
    TOKEN_VAULT: {
      idFromName: () => "mock-do-id",
      get: () => ({ fetch: () => Promise.resolve(new Response(JSON.stringify({ tokens: null }))) }),
    } as never,
    INTERACTION_ROUTER: {
      idFromName: () => "mock-router-id",
      get: () => ({ fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }))) }),
    } as never,
    IDEA_INGEST: {
      idFromName: () => "mock-ingest-id",
      get: () => ({ fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }))) }),
    } as never,
    TOKEN_ENCRYPTION_KEY_IDS: "test-key",
    ACCESS_TEAM: "test-team",
    ACCESS_AUDIENCE: "test-aud",
    ACCESS_ADMIN_EMAILS: "admin@test.com",
    PIPELINE_WORKFLOW: {} as never,
  }
}

const BASE_PAGE: HarnessPage = {
  id: "page_1",
  kippId: 1,
  title: "Test idea",
  status: "raw",
  source: "manual",
  markdown: "Body content",
  chatId: "42",
}

function patchedStatuses(patches: { body: Record<string, unknown> }[]): string[] {
  return patches.map((p) => {
    const props = p.body.properties as { Status?: { status?: { name?: string } } } | undefined
    return props?.Status?.status?.name ?? ""
  })
}

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
      payload: { pageId: "page_1", ideaId: "1", source: "manual" },
      instanceId: "wf-1",
      timestamp: new Date(),
      workflowName: "",
    }
  }

  it("generates draft, notifies, finalizes on approval", async () => {
    const responses = [{ text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } }]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(stepDo).toHaveBeenCalledWith("generate", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify-not-configured", expect.any(Function))
  })

  it("times out when no feedback received, marking idea as expired", async () => {
    const responses = [{ text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } }]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock, patches } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent.mockResolvedValue({ type: "timeout" })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(stepDo).toHaveBeenCalledWith("generate", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("timeout-0", expect.any(Function))
    expect(stepDo).not.toHaveBeenCalledWith("notify-published", expect.any(Function))
    expect(stepDo).not.toHaveBeenCalledWith("archive", expect.any(Function))
    expect(stepDo).not.toHaveBeenCalledWith("linkedin-publish", expect.any(Function))
    expect(patchedStatuses(patches)).toContain("awaiting-feedback-expired")
  })

  it("does not leak LinkedIn token in Telegram error message or console.error on publish failure", async () => {
    const responses = [{ text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } }]
    let callIdx = 0
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock, telegramTexts } = buildFetch([BASE_PAGE], {
      linkedinStatus: 401,
      linkedinBody: JSON.stringify({ error: "invalid_token", access_token: "leaked-secret-abc" }),
    })
    vi.stubGlobal("fetch", fetchMock)

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
        DEPLOYMENT_ENV: "development",
      },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    consoleSpy.mockRestore()

    expect(stepDo).toHaveBeenCalledWith("linkedin-publish", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify-publish-failed", expect.any(Function))
    const telegramText = telegramTexts[telegramTexts.length - 1]
    expect(telegramText).not.toContain("leaked-secret-abc")
    expect(telegramText).not.toContain("valid-token")
    expect(telegramText).toContain("HTTP 401")

    const allErrorOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(allErrorOutput).not.toContain("leaked-secret-abc")
    expect(allErrorOutput).not.toContain("valid-token")
  })

  it("reports a token vault failure safely when approving", async () => {
    const responses = [{ text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } }]
    let callIdx = 0
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock, telegramTexts } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: {
        ...mockEnv(),
        LINKEDIN_AUTHOR_URN: "urn:li:person:123",
        TOKEN_VAULT: {
          idFromName: () => "mock-do-id",
          get: () => ({ fetch: () => Promise.resolve(new Response("unavailable", { status: 500 })) }),
        } as never,
      },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    consoleSpy.mockRestore()

    expect(stepDo).not.toHaveBeenCalledWith("linkedin-publish", expect.any(Function))
    expect(stepDo).toHaveBeenCalledWith("notify-publish-failed", expect.any(Function))
    expect(telegramTexts[telegramTexts.length - 1]).toBe("❌ LinkedIn publish failed. Please try approving again.")
  })

  it("revises on feedback and notifies on second approval without LinkedIn", async () => {
    const responses = [
      { text: "First draft", usage: { inputTokens: 5, outputTokens: 3 } },
      { text: "Revised draft", usage: { inputTokens: 5, outputTokens: 3 } },
    ]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
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
      { text: "Revised with feedback", usage: { inputTokens: 5, outputTokens: 3 } },
    ]
    let callIdx = 0
    const genCalls: { messages: { role: string; content: string }[] }[] = []

    testRun()
    mockCreateGenerator.mockImplementation(async (opts) => {
      genCalls.push(opts as { messages: { role: string; content: string }[] })
      return responses[callIdx++]
    })
    const { fetchMock } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "Make it more academic" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const reviseMessages = genCalls[1].messages
    expect(reviseMessages[0]).toEqual({
      role: "system",
      content: expect.stringContaining(`Style instructions:\n${STYLE_PROMPT}`),
    })
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
    const { fetchMock } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "first feedback" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "second feedback" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const secondReviseMessages = genCalls[2].messages
    expect(secondReviseMessages.some((m) => m.role === "user" && m.content === "first feedback")).toBe(true)
    expect(secondReviseMessages.some((m) => m.role === "assistant" && m.content === "Revised one")).toBe(true)
    expect(secondReviseMessages.some((m) => m.role === "user" && m.content === "second feedback")).toBe(true)
  })

  it("Revise More (__revise__) adds no synthetic transcript message; the next real reply changes history", async () => {
    const responses = [
      { text: "Initial draft", usage: { inputTokens: 5, outputTokens: 3 } },
      { text: "Revised after real reply", usage: { inputTokens: 5, outputTokens: 3 } },
    ]
    let callIdx = 0
    const genCalls: { messages: { role: string; content: string }[] }[] = []

    testRun()
    mockCreateGenerator.mockImplementation(async (opts) => {
      genCalls.push(opts as { messages: { role: string; content: string }[] })
      return responses[callIdx++]
    })
    const { fetchMock } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "__revise__" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "actually make it shorter" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(genCalls).toHaveLength(2)
    const firstReviseMessages = genCalls[1].messages
    expect(firstReviseMessages.some((m) => m.content === "__revise__")).toBe(false)
    const lastAssistantBeforeInstruction = [...firstReviseMessages].reverse().find((m) => m.role === "assistant")
    expect(lastAssistantBeforeInstruction?.content).toBe("Initial draft")
    expect(firstReviseMessages.some((m) => m.role === "user" && m.content === "actually make it shorter")).toBe(true)
  })

  it("throws TranscriptTooLargeError before any Notion update when the generate transcript is oversized", async () => {
    testRun()
    mockCreateGenerator.mockResolvedValueOnce({
      text: "big draft",
      usage: { inputTokens: 5, outputTokens: 3 },
    })
    mockAssertStepOutputSize.mockImplementation(() => {
      throw new TranscriptTooLargeError("too big", 950 * 1024, 900 * 1024)
    })
    const { fetchMock, patches } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await expect(
      (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep()),
    ).rejects.toThrow("too big")
    expect(patches).toHaveLength(0)
  })

  it("includes cost line in initial Telegram notification", async () => {
    const responses = [{ text: "My draft content", usage: { inputTokens: 100000, outputTokens: 50000 } }]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock, telegramTexts } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const notifyMsg = telegramTexts.find((t) => t.startsWith("*Draft for idea"))
    expect(notifyMsg).toBeDefined()
    expect(notifyMsg).toContain("Est. cost:")
    expect(notifyMsg).toContain("100000 in")
    expect(notifyMsg).toContain("50000 out")
    expect(notifyMsg).toContain("deepseek-v4-flash")
  })

  it("cumulative cost across revisions appears in revised notification", async () => {
    const responses = [
      { text: "First draft", usage: { inputTokens: 100, outputTokens: 50 } },
      { text: "Revised draft", usage: { inputTokens: 200, outputTokens: 80 } },
    ]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock, telegramTexts } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "Make it punchier" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const notifyMsg = telegramTexts.find((t) => t.startsWith("*Revised draft for idea"))
    expect(notifyMsg).toBeDefined()
    expect(notifyMsg).toContain("Est. cost:")
    expect(notifyMsg).toContain("300 in")
    expect(notifyMsg).toContain("130 out")
  })

  it("marks idea expired without Telegram when no chatId is resolved", async () => {
    const responses = [{ text: "Draft", usage: { inputTokens: 100, outputTokens: 50 } }]
    let callIdx = 0
    const noChatPage = { ...BASE_PAGE, chatId: undefined }

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    waitForEvent.mockResolvedValue({ type: "timeout" })
    const { fetchMock, patches, telegramTexts } = buildFetch([noChatPage])
    vi.stubGlobal("fetch", fetchMock)

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: { ...mockEnv(), TELEGRAM_ALLOWED_USER_ID: "" } })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    expect(telegramTexts).toHaveLength(0)
    expect(patchedStatuses(patches)).toContain("awaiting-feedback-expired")
  })

  it("includes cost line in publish notification when one token dimension is zero", async () => {
    const responses = [{ text: "Draft content", usage: { inputTokens: 0, outputTokens: 50 } }]
    let callIdx = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    const { fetchMock, telegramTexts } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
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
        DEPLOYMENT_ENV: "development",
      },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep())

    const publishMsg = telegramTexts.find((t) => t.startsWith("✅"))
    expect(publishMsg).toBeDefined()
    expect(publishMsg).toContain("Est. cost:")
    expect(publishMsg).toContain("0 in")
    expect(publishMsg).toContain("50 out")
    expect(publishMsg).toContain("deepseek-v4-flash")
  })

  it("does not resend a draft when interaction registration is retried", async () => {
    const completedSteps = new Map<string, unknown>()
    const sendStep = vi.fn(async (name: string, fn: () => Promise<unknown>) => {
      if (completedSteps.has(name)) return completedSteps.get(name)
      const result = await fn()
      completedSteps.set(name, result)
      return result
    })
    const retryingStep = {
      do: sendStep,
      waitForEvent: vi.fn().mockResolvedValue({ type: "timeout" }),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
    }
    const responses = [{ text: "Draft content", usage: { inputTokens: 5, outputTokens: 3 } }]
    let callIndex = 0
    let registrationAttempts = 0

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIndex++])
    const { fetchMock, telegramTexts } = buildFetch([BASE_PAGE])
    vi.stubGlobal("fetch", fetchMock)
    const router = {
      idFromName: () => "router-id",
      get: () => ({
        fetch: async () => {
          registrationAttempts++
          return registrationAttempts === 1 ? new Response("failure", { status: 500 }) : Response.json({ ok: true })
        },
      }),
    }
    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: { ...mockEnv(), INTERACTION_ROUTER: router as never } })

    await expect(
      (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), retryingStep),
    ).rejects.toThrow("Interaction router /register failed")
    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), retryingStep)

    expect(telegramTexts.filter((t) => t.startsWith("*Draft")).length).toBe(1)
    expect(sendStep).toHaveBeenCalledWith("register-notify-interactions", expect.any(Function))
  })

  it("notifies the operator with safe wording and rethrows when the generate step hits a GitHub 401", async () => {
    const responses = [{ text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } }]
    let callIdx = 0
    const telegramBodies: { chat_id?: string | number; text?: string }[] = []
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url?.includes?.("api.telegram.org")) {
          const body = JSON.parse(opts?.body as string) as { chat_id?: string | number; text?: string }
          telegramBodies.push(body)
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        }
        const path = url.split("/contents/")[1]
        if (path === "ideas.md")
          return { ok: false, status: 401, text: () => Promise.resolve('{"message":"Bad credentials"}') }
        const content = path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    await expect(
      (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), makeStep()),
    ).rejects.toThrow("401")
    consoleSpy.mockRestore()

    expect(telegramBodies).toHaveLength(1)
    expect(telegramBodies[0].chat_id).toBe("42")
    expect(telegramBodies[0].text).toContain("Storage access was denied (HTTP 401)")
    expect(telegramBodies[0].text).not.toContain("Bad credentials")
  })

  it("prefers the payload chatId over the operator fallback when notifying", async () => {
    const responses = [{ text: "My draft content", usage: { inputTokens: 5, outputTokens: 3 } }]
    let callIdx = 0
    let notifiedChatId = ""
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    testRun()
    mockCreateGenerator.mockImplementation(async () => responses[callIdx++])
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url?.includes?.("api.telegram.org")) {
          const body = JSON.parse(opts?.body as string) as { chat_id?: string | number }
          notifiedChatId = String(body.chat_id)
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        }
        const path = url.split("/contents/")[1]
        if (path === "ideas.md") return { ok: false, status: 401, text: () => Promise.resolve("denied") }
        const content = path === "style-prompt.md" ? STYLE_PROMPT : ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }),
    )

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: mockEnv() })

    const event = makeEvent() as { payload: { chatId?: string } }
    event.payload.chatId = "777"
    await expect(
      (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(event, makeStep()),
    ).rejects.toThrow("401")
    consoleSpy.mockRestore()

    expect(notifiedChatId).toBe("777")
  })
})
