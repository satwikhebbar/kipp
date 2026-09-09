import { describe, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { PipelineWorkflow } from "../linkedin/workflow"
import { createFakeInteractionRouter, createFakeNetwork, createFakeStep, type FakeNotionPage } from "./setup"

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
    DEPLOYMENT_ENV: "development",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    POSTING_CADENCE_DAYS: "7",
    SUBSTACK_RSS_URL: "",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    NOTION_API_KEY: "secret",
    NOTION_IDEAS_DATA_SOURCE_ID: "ds-1",
    NOTION_FREE_TIER: "false",
    TOKEN_VAULT: mockDoNamespace(),
    INTERACTION_ROUTER: createFakeInteractionRouter().namespace,
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as never
}

const RAW_PAGE: FakeNotionPage = {
  pageId: "page_1",
  kippId: 1,
  title: "Test idea",
  status: "raw",
  source: "manual",
  markdown: "Body content",
  chatId: "42",
}

function linkedInToolResponse(response: string, post: string, id: string) {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: "submit_linkedin_response",
                arguments: JSON.stringify({ response, post }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  }
}

const CONVERSATIONAL_RESPONSE =
  'Here is the post reframed around your preferred hook.\n\nOPENING HOOK (chosen)\n"quote"\n\nIMAGE IDEAS\n1. A train shot\n\nTHE POST\nMy draft content'
const DRAFT_RESPONSE = linkedInToolResponse(CONVERSATIONAL_RESPONSE, "My draft content", "draft")
const REVISE_RESPONSE = linkedInToolResponse(
  "Revised per your feedback.\n\nIMAGE IDEAS\nUpdated shots\n\nTHE POST\nRevised draft",
  "Revised draft",
  "revision",
)

function makeStep() {
  return createFakeStep()
}

function makeEvent() {
  return {
    payload: { pageId: "page_1", ideaId: "1", source: "manual" },
    instanceId: "wf-1",
    timestamp: new Date(),
    workflowName: "",
  }
}

describe("workflow-approval-to-linkedin-draft", () => {
  it("generates draft, notifies, publishes to LinkedIn, and archives on approval", async () => {
    const { fetch, getState } = createFakeNetwork({
      notionPages: [RAW_PAGE],
      llmResponses: [DRAFT_RESPONSE],
    })
    vi.stubGlobal("fetch", fetch)

    const step = makeStep()
    step.waitForEvent.mockResolvedValue({ type: "event", payload: { text: "__approve__" } })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: { ...baseEnv(), LINKEDIN_ACCESS_TOKEN: "my-token", LINKEDIN_AUTHOR_URN: "urn:li:person:123" },
    })

    const outcome = await (
      wf as unknown as {
        run: (e: unknown, s: unknown) => Promise<{ outcome: string; linkedInDraftUrn?: string }>
      }
    ).run(makeEvent(), {
      do: step.do,
      waitForEvent: step.waitForEvent,
      sleep: step.sleep,
      sleepUntil: step.sleepUntil,
    })

    expect(outcome).toEqual({ outcome: "published", linkedInDraftUrn: "urn:li:ugcPost:fake" })

    expect(step.getCalledSteps()).toContain("generate")
    expect(step.getCalledSteps()).toContain("notify")
    expect(step.getCalledSteps()).toContain("linkedin-publish-0-0")
    expect(step.getCalledSteps()).toContain("archive")
    expect(step.getCalledSteps()).toContain("notify-published")
    expect(step.getCalledSteps()).toContain("workflow-complete")

    const state = getState()
    expect(state.linkedinDrafts).toHaveLength(1)
    expect(state.linkedinDrafts[0].text).toBe("My draft content")
    expect(state.linkedinDrafts[0].text).not.toContain("OPENING HOOK")
    expect(state.linkedinDrafts[0].text).not.toContain("IMAGE IDEAS")
    expect(state.linkedinDrafts[0].text).not.toContain("Here is the post reframed")
    expect(state.linkedinDrafts[0].authorUrn).toBe("urn:li:person:123")

    const draftMsg = state.telegramMessages.find((msg) => msg.text.startsWith("*Draft for idea"))
    expect(draftMsg).toBeDefined()
    expect(draftMsg?.text).toContain("OPENING HOOK")
    expect(draftMsg?.text).toContain("IMAGE IDEAS")
    expect(draftMsg?.text).toContain("Will be posted as a LinkedIn draft:")
    expect(draftMsg?.text).toContain("My draft content")

    expect(state.linkedinUrls).toHaveLength(1)
    expect(state.linkedinUrls[0]).toContain("/v2/ugcPosts")

    expect(state.notionPages.get("page_1")?.status).toBe("finalized")
  })

  it("prompts to reconnect but does not publish when no LinkedIn token is available", async () => {
    const { fetch, getState } = createFakeNetwork({
      notionPages: [RAW_PAGE],
      llmResponses: [DRAFT_RESPONSE],
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

    expect(step.getCalledSteps()).toContain("linkedin-publish-0-0")
    expect(step.getCalledSteps()).toContain("linkedin-reconnect-0-0-notify")
    expect(step.getCalledSteps()).toContain("linkedin-reconnect-0-0-register")
    expect(step.getCalledSteps()).not.toContain("archive")
    expect(step.getCalledSteps()).not.toContain("notify-published")
    expect(getState().linkedinDrafts).toHaveLength(0)
  })

  it("revises on feedback then publishes on subsequent approval", async () => {
    const { fetch, getState } = createFakeNetwork({
      notionPages: [RAW_PAGE],
      llmResponses: [DRAFT_RESPONSE, REVISE_RESPONSE],
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
    expect(step.getCalledSteps()).toContain("linkedin-publish-1-0")
    expect(step.getCalledSteps()).toContain("archive")
    expect(step.getCalledSteps()).toContain("notify-published")

    const state = getState()
    expect(state.linkedinDrafts).toHaveLength(1)
    expect(state.linkedinDrafts[0].text).toBe("Revised draft")
    expect(state.linkedinDrafts[0].text).not.toContain("Revised per your feedback")
    expect(state.linkedinDrafts[0].text).not.toContain("IMAGE IDEAS")
  })

  it("marks idea as expired when feedback times out after revision", async () => {
    const { fetch, getState } = createFakeNetwork({
      notionPages: [RAW_PAGE],
      llmResponses: [DRAFT_RESPONSE, REVISE_RESPONSE],
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
    expect(step.getCalledSteps().some((name) => name.startsWith("linkedin-publish"))).toBe(false)
    expect(step.getCalledSteps()).not.toContain("archive")

    expect(getState().notionPages.get("page_1")?.status).toBe("awaiting-feedback-expired")
  })

  it("denies a hallucinated publishing tool before approval or any LinkedIn mutation", async () => {
    const deniedResponse = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "publish",
                type: "function",
                function: { name: "publish_linkedin_draft", arguments: JSON.stringify({ draft: "Unsafe" }) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }
    const { fetch, getState } = createFakeNetwork({
      notionPages: [RAW_PAGE],
      llmResponses: [deniedResponse, deniedResponse, deniedResponse],
    })
    vi.stubGlobal("fetch", fetch)
    const step = makeStep()
    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: { ...baseEnv(), LINKEDIN_ACCESS_TOKEN: "valid-token", LINKEDIN_AUTHOR_URN: "urn:li:person:123" },
    })

    await expect(
      (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), {
        do: step.do,
        waitForEvent: step.waitForEvent,
        sleep: step.sleep,
        sleepUntil: step.sleepUntil,
      }),
    ).rejects.toThrow("provider-turn-limit")

    expect(step.getCalledSteps()).not.toContain("notify")
    expect(step.getCalledSteps().some((name) => name.startsWith("linkedin-publish"))).toBe(false)
    expect(step.getCalledSteps()).not.toContain("archive")
    expect(getState().linkedinDrafts).toHaveLength(0)
    expect(getState().notionPages.get("page_1")?.status).toBe("raw")
  })

  it("fails safely on a native provider error without creating an approvable draft", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { fetch: harnessFetch, getState } = createFakeNetwork({
      notionPages: [RAW_PAGE],
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
        if (urlStr.includes("api.deepseek.com"))
          return {
            ok: false,
            status: 503,
            text: () => Promise.resolve("provider body must stay private"),
          }
        return harnessFetch(url, opts)
      }),
    )
    const step = makeStep()
    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, { env: { ...baseEnv(), LLM_MAX_RETRIES: "0" } })

    await expect(
      (wf as unknown as { run: (e: unknown, s: unknown) => Promise<void> }).run(makeEvent(), {
        do: step.do,
        waitForEvent: step.waitForEvent,
        sleep: step.sleep,
        sleepUntil: step.sleepUntil,
      }),
    ).rejects.toThrow("DeepSeek tool request failed (503)")

    const errorOutput = consoleSpy.mock.calls.flat().join("\n")
    consoleSpy.mockRestore()
    expect(errorOutput).not.toContain("provider body must stay private")
    expect(step.getCalledSteps()).not.toContain("notify")
    expect(step.getCalledSteps().some((name) => name.startsWith("linkedin-publish"))).toBe(false)
    expect(getState().linkedinDrafts).toHaveLength(0)
    expect(getState().notionPages.get("page_1")?.status).toBe("raw")
  })

  it("does not leak LinkedIn token in Telegram error on publish failure", async () => {
    const telegramTexts: string[] = []

    const { fetch: harnessFetch } = createFakeNetwork({
      notionPages: [RAW_PAGE],
      llmResponses: [DRAFT_RESPONSE],
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
    const tokenMsg = telegramTexts.find((t) => t.includes("valid-token"))
    expect(tokenMsg).toBeUndefined()
    const reconnectMsg = telegramTexts.find((t) => t.includes("LinkedIn authorization is missing or expired."))
    expect(reconnectMsg).toBeDefined()
  })
})
