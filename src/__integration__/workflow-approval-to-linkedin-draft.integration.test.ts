import { describe, expect, it, vi } from "vitest"
import type { Env } from "../types"
import { PipelineWorkflow } from "../workflow"
import { createFakeNetwork, createFakeStep } from "./setup"

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Env
    ctx!: unknown
  }
  return { WorkflowEntrypoint }
})

function mockDoNamespace() {
  return {
    idFromName: () => ({}) as never,
    get: () => ({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ tokens: null }), { status: 200 })),
    }),
  } as never
}

function baseEnv(overrides?: Partial<Env>): Env {
  return {
    GITHUB_PAT: "pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "my-secret",
    TELEGRAM_ALLOWED_USER_ID: "42",
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
    LINKEDIN_ACCESS_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    POSTING_CADENCE_DAYS: "7",
    SUBSTACK_RSS_URL: "",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    TOKEN_VAULT: mockDoNamespace(),
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as never
}

const RAW_IDEA = `---
id: 1
title: Test idea
status: raw
created: 2026-07-01T12:00:00Z
source: manual
correlation:
  telegramChatId: "42"
---

Body content`

const DRAFT_RESPONSE = {
  choices: [{ message: { content: "My draft content" } }],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
}
const CRITIQUE_PASS = {
  choices: [{ message: { content: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]) } }],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
}
const REVISE_RESPONSE = {
  choices: [{ message: { content: "Revised draft" } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
}

function makeStep() {
  return createFakeStep()
}

function makeEvent() {
  return {
    payload: { ideaId: "1", ideaTitle: "Test idea", ideaBody: "Body content" },
    instanceId: "wf-1",
    timestamp: new Date(),
    workflowName: "",
  }
}

describe("workflow-approval-to-linkedin-draft", () => {
  it("generates draft, notifies, publishes to LinkedIn, and archives on approval", async () => {
    const { fetch, getState } = createFakeNetwork({
      githubFiles: { "ideas.md": RAW_IDEA, "archive.md": "" },
      llmResponses: [DRAFT_RESPONSE, CRITIQUE_PASS],
    })
    vi.stubGlobal("fetch", fetch)

    const step = makeStep()
    step.waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: { ...baseEnv(), LINKEDIN_ACCESS_TOKEN: "my-token", LINKEDIN_AUTHOR_URN: "urn:li:person:123" },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), {
      do: step.do,
      waitForEvent: step.waitForEvent,
      sleep: step.sleep,
      sleepUntil: step.sleepUntil,
    })

    expect(step.getCalledSteps()).toContain("generate")
    expect(step.getCalledSteps()).toContain("notify")
    expect(step.getCalledSteps()).toContain("linkedin-publish")
    expect(step.getCalledSteps()).toContain("archive")
    expect(step.getCalledSteps()).toContain("notify-published")

    const state = getState()
    expect(state.linkedinDrafts).toHaveLength(1)
    expect(state.linkedinDrafts[0].text).toBe("My draft content")
    expect(state.linkedinDrafts[0].authorUrn).toBe("urn:li:person:123")

    expect(state.linkedinUrls).toHaveLength(1)
    expect(state.linkedinUrls[0]).toContain("/v2/ugcPosts")

    const archive = state.githubFiles.get("archive.md")
    expect(archive).toContain("id: 1")
    expect(archive).toContain("status: finalized")
    expect(archive).toContain("workflowInstanceId: wf-1")
    expect(state.githubFiles.get("ideas.md")).not.toContain("id: 1")
  })

  it("notifies but does not publish when no LinkedIn token is available", async () => {
    const { fetch, getState } = createFakeNetwork({
      githubFiles: { "ideas.md": RAW_IDEA },
      llmResponses: [DRAFT_RESPONSE, CRITIQUE_PASS],
    })
    vi.stubGlobal("fetch", fetch)

    const step = makeStep()
    step.waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: { ...baseEnv(), LINKEDIN_ACCESS_TOKEN: "", LINKEDIN_AUTHOR_URN: "" },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), {
      do: step.do,
      waitForEvent: step.waitForEvent,
      sleep: step.sleep,
      sleepUntil: step.sleepUntil,
    })

    expect(step.getCalledSteps()).toContain("notify-not-configured")
    expect(step.getCalledSteps()).not.toContain("linkedin-publish")
    expect(step.getCalledSteps()).not.toContain("archive")
    expect(getState().linkedinDrafts).toHaveLength(0)
  })

  it("revises on feedback then publishes on subsequent approval", async () => {
    const { fetch, getState } = createFakeNetwork({
      githubFiles: { "ideas.md": RAW_IDEA, "archive.md": "" },
      llmResponses: [DRAFT_RESPONSE, CRITIQUE_PASS, REVISE_RESPONSE],
    })
    vi.stubGlobal("fetch", fetch)

    const step = makeStep()
    step.waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "Make it shorter" } })
      .mockResolvedValueOnce({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: { ...baseEnv(), LINKEDIN_ACCESS_TOKEN: "my-token", LINKEDIN_AUTHOR_URN: "urn:li:person:123" },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), {
      do: step.do,
      waitForEvent: step.waitForEvent,
      sleep: step.sleep,
      sleepUntil: step.sleepUntil,
    })

    expect(step.getCalledSteps()).toContain("revise-0")
    expect(step.getCalledSteps()).toContain("notify-revised-0")
    expect(step.getCalledSteps()).toContain("linkedin-publish")
    expect(step.getCalledSteps()).toContain("archive")
    expect(step.getCalledSteps()).toContain("notify-published")

    const state = getState()
    expect(state.linkedinDrafts).toHaveLength(1)
    expect(state.linkedinDrafts[0].text).toBe("Revised draft")
  })

  it("marks idea as expired when feedback times out after revision", async () => {
    const { fetch, getState } = createFakeNetwork({
      githubFiles: { "ideas.md": RAW_IDEA },
      llmResponses: [DRAFT_RESPONSE, CRITIQUE_PASS, REVISE_RESPONSE],
    })
    vi.stubGlobal("fetch", fetch)

    const step = makeStep()
    step.waitForEvent
      .mockResolvedValueOnce({ type: "event", payload: { text: "Shorten" } })
      .mockResolvedValueOnce({ type: "timeout" })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: { ...baseEnv(), LINKEDIN_ACCESS_TOKEN: "", LINKEDIN_AUTHOR_URN: "" } })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), {
      do: step.do,
      waitForEvent: step.waitForEvent,
      sleep: step.sleep,
      sleepUntil: step.sleepUntil,
    })

    expect(step.getCalledSteps()).toContain("timeout-1")
    expect(step.getCalledSteps()).not.toContain("linkedin-publish")
    expect(step.getCalledSteps()).not.toContain("archive")

    const ideasMd = getState().githubFiles.get("ideas.md")
    expect(ideasMd).toContain("status: awaiting-feedback-expired")
  })

  it("does not leak LinkedIn token in Telegram error on publish failure", async () => {
    const telegramTexts: string[] = []

    const { fetch: harnessFetch } = createFakeNetwork({
      githubFiles: { "ideas.md": RAW_IDEA },
      llmResponses: [DRAFT_RESPONSE, CRITIQUE_PASS],
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
          const parsed = JSON.parse(opts?.body as string) as { text?: string }
          if (parsed.text) telegramTexts.push(parsed.text)
          return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
        }
        return harnessFetch(url, opts)
      }),
    )

    const step = makeStep()
    step.waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: { ...baseEnv(), LINKEDIN_ACCESS_TOKEN: "valid-token", LINKEDIN_AUTHOR_URN: "urn:li:person:123" },
    })

    await (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), {
      do: step.do,
      waitForEvent: step.waitForEvent,
      sleep: step.sleep,
      sleepUntil: step.sleepUntil,
    })

    const leakedMsg = telegramTexts.find((t) => t.includes("leaked-secret-abc"))
    expect(leakedMsg).toBeUndefined()
    const httpMsg = telegramTexts.find((t) => t.includes("HTTP 401"))
    expect(httpMsg).toBeDefined()
  })
})
