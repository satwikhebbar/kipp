import { describe, expect, it, vi } from "vitest"
import { handleCadenceCron } from "../triggers/cadence"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function mockEnv() {
  return {
    GITHUB_PAT: "pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    SUBSTACK_RSS_URL: "https://test.substack.com/feed",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "gemini",
    POSTING_CADENCE_DAYS: "7",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_WEBHOOK_SECRET: "",
    TELEGRAM_ALLOWED_USER_ID: "",
    PIPELINE_WORKFLOW: { create: vi.fn().mockResolvedValue({ id: "wf-1" }) },
  }
}

const RAW_IDEA = `---
id: 1
title: Old raw idea
status: raw
created: 2026-06-01T12:00:00Z
source: manual
---

Need to post about this`

const IN_FLIGHT = `---
id: 2
title: In flight
status: awaiting-feedback
created: 2026-07-10T12:00:00Z
source: manual
---

Waiting for feedback`

const RECENT_ARCHIVE = `---
id: 10
title: Recent post
status: finalized
created: 2026-07-08T12:00:00Z
source: manual
body: Recently posted
---

Final content`

const STALE_ARCHIVE = `---
id: 9
title: Old post
status: finalized
created: 2026-06-20T12:00:00Z
source: manual
body: Old content
---

Final content`

const RECENTLY_FINALIZED = `---
id: 11
title: Recently finalized
status: finalized
created: 2026-06-01T12:00:00Z
finalized: 2026-07-10T12:00:00Z
source: manual
body: Finalized yesterday
---

Final content`

function setupMockedFetch(responses: Array<{ content?: string; sha?: string } | { ok: boolean }>) {
  let idx = 0
  mockFetch.mockImplementation(async (_url: string, _opts?: RequestInit) => {
    const r = responses[idx++]
    if (!r) throw new Error("unexpected fetch")
    if ("ok" in r) return r as Response
    return {
      ok: true,
      json: () => Promise.resolve({ content: b64(r.content ?? ""), sha: r.sha ?? "s1" }),
    }
  })
}

describe("handleCadenceCron", () => {
  it("skips when an idea is awaiting-feedback", async () => {
    setupMockedFetch([
      { content: IN_FLIGHT, sha: "s1" },
      { content: RECENT_ARCHIVE, sha: "s2" },
    ])
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.PIPELINE_WORKFLOW.create).not.toHaveBeenCalled()
  })

  it("skips when archive has a recently finalized idea", async () => {
    setupMockedFetch([
      { content: RAW_IDEA, sha: "s1" },
      { content: RECENT_ARCHIVE, sha: "s2" },
    ])
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.PIPELINE_WORKFLOW.create).not.toHaveBeenCalled()
  })

  it("starts workflow when no finalized idea exists", async () => {
    setupMockedFetch([
      { content: RAW_IDEA, sha: "s1" },
      { content: "", sha: "s2" },
    ])
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(true)
    expect(env.PIPELINE_WORKFLOW.create).toHaveBeenCalledWith({
      params: { ideaId: "1", ideaTitle: "Old raw idea", ideaBody: "Need to post about this" },
    })
  })

  it("starts workflow when latest finalized is stale", async () => {
    setupMockedFetch([
      { content: RAW_IDEA, sha: "s1" },
      { content: STALE_ARCHIVE, sha: "s2" },
    ])
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(true)
    expect(env.PIPELINE_WORKFLOW.create).toHaveBeenCalledTimes(1)
  })

  it("returns started:false when no raw ideas exist", async () => {
    setupMockedFetch([
      { content: "", sha: "s1" },
      { content: STALE_ARCHIVE, sha: "s2" },
    ])
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.PIPELINE_WORKFLOW.create).not.toHaveBeenCalled()
  })

  it("uses finalized date over created for cadence check", async () => {
    setupMockedFetch([
      { content: RAW_IDEA, sha: "s1" },
      { content: RECENTLY_FINALIZED, sha: "s2" },
    ])
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.PIPELINE_WORKFLOW.create).not.toHaveBeenCalled()
  })
})
