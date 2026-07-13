import { describe, it, vi } from "vitest"
import { createInterface } from "readline"

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint {
    env!: Record<string, string>
    ctx!: unknown
  }
  return { WorkflowEntrypoint }
})

const mockGenerator = vi.hoisted(() => vi.fn())
vi.mock("../src/providers", () => ({
  createGenerator: () => mockGenerator,
}))

import { PipelineWorkflow } from "../src/workflow"

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

function mockEnv(linkedInToken: string): Record<string, string> {
  return {
    GITHUB_PAT: process.env.GITHUB_PAT || "mock-pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    SUBSTACK_RSS_URL: "https://test.substack.com/feed",
    LLM_API_KEY: "test-key",
    LLM_PROVIDER: "gemini",
    POSTING_CADENCE_DAYS: "7",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_USER_ID: "42",
    LINKEDIN_CLIENT_ID: linkedInToken ? "client_id" : "",
    LINKEDIN_CLIENT_SECRET: linkedInToken ? "client_secret" : "",
    LINKEDIN_ACCESS_TOKEN: linkedInToken,
    LINKEDIN_REFRESH_TOKEN: linkedInToken ? "refresh_token" : "",
    LINKEDIN_AUTHOR_URN: linkedInToken ? "urn:li:author:123" : "",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    PIPELINE_WORKFLOW: "",
  }
}

const STYLE_PROMPT = "Write professional technical content with clear structure."

const mockIdeas = `---
id: 1
title: Local test idea
status: raw
created: ${new Date().toISOString()}
source: manual
correlation:
  telegramChatId: "42"
---

Test body content for local workflow testing.`

interface MockStore {
  ideas: string
  archive: string
  linkedinTokens: string
}

function setupFetch(store: MockStore) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") {
        const body = JSON.parse(opts.body as string) as { content: string }
        const decoded = new TextDecoder().decode(
          Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)),
        )
        if (url.includes("ideas.md")) store.ideas = decoded
        else if (url.includes("archive.md")) store.archive = decoded
        else if (url.includes(".linkedin-tokens.json")) store.linkedinTokens = decoded
        return { ok: true, json: () => Promise.resolve({}) }
      }
      if (url?.includes?.("api.telegram.org")) {
        return { ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }) }
      }
      if (url?.includes?.("api.github.com")) {
        const path = url.split("/contents/")[1]
        let content: string
        if (path === "ideas.md") content = store.ideas
        else if (path === "archive.md") content = store.archive
        else if (path === "style-prompt.md") content = STYLE_PROMPT
        else if (path === ".linkedin-tokens.json") content = store.linkedinTokens
        else content = ""
        return { ok: true, json: () => Promise.resolve({ content: b64(content), sha: "s1" }) }
      }
      if (url?.includes?.("linkedin.com")) {
        return { ok: true, json: () => Promise.resolve({ id: "post-123" }) }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    }),
  )
}

describe("local workflow", () => {
  it("runs the full pipeline interactively", async () => {
    const store: MockStore = { ideas: mockIdeas, archive: "", linkedinTokens: "" }

    const feedbackText = process.env.FEEDBACK_TEXT
    const linkedInConfig = process.env.LINKEDIN

    if (linkedInConfig === "y" || linkedInConfig === "Y") {
      store.linkedinTokens = JSON.stringify({
        access_token: "test-access-token",
        expires_in: 5184000,
        created_at: new Date().toISOString(),
      })
    }

    setupFetch(store)

    let genIdx = 0
    const genResponses: Array<{ text: string; usage: { inputTokens: number; outputTokens: number } }> = [
      { text: "## My Draft\n\nThis is the generated draft content.", usage: { inputTokens: 5, outputTokens: 3 } },
      { text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]), usage: { inputTokens: 5, outputTokens: 3 } },
      { text: "## Revised Draft\n\nShorter version.", usage: { inputTokens: 5, outputTokens: 3 } },
      { text: JSON.stringify([{ check: "Hook", passed: true, feedback: null }]), usage: { inputTokens: 5, outputTokens: 3 } },
    ]
    mockGenerator.mockImplementation(async () => genResponses[genIdx++ % genResponses.length])

    const stepDo = vi.fn().mockImplementation(async (_name: string, fn: () => unknown) => fn())
    const waitForEvent = vi.fn().mockImplementation(async () => {
      let input: string
      if (feedbackText !== undefined) {
        input = feedbackText
      } else {
        input = await ask("\nEnter feedback (__approve__ to approve, or type revision feedback): ")
      }
      process.stdout.write(`  → feedback: "${input}"\n`)
      return { type: "event", payload: { text: input } }
    })
    const makeStep = () => ({ do: stepDo, waitForEvent, sleep: vi.fn(), sleepUntil: vi.fn() })
    const makeEvent = () => ({
      payload: { ideaId: "1", ideaTitle: "Local test idea", ideaBody: "Test body content" },
      instanceId: "wf-local",
      timestamp: new Date(),
      workflowName: "",
    })

    const wf = new PipelineWorkflow({} as never, {} as never)
    Object.assign(wf, {
      env: mockEnv(linkedInConfig === "y" || linkedInConfig === "Y" ? "test-access-token" : ""),
    })

    await wf.run(makeEvent() as never, makeStep() as never)

    process.stdout.write("\n✓ Workflow completed!\n")
    process.stdout.write(`Steps executed: ${stepDo.mock.calls.map((c) => c[0]).join(", ")}\n`)
    process.stdout.write(`\nIdeas file state:\n${store.ideas}\n`)
    if (store.archive) {
      process.stdout.write(`Archive:\n${store.archive}\n`)
    }
  })
})
