import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleCadenceCron } from "../triggers/cadence"

const NOTION_DS = "ds-1"

interface NotionPage {
  id: string
  created_time: string
  last_edited_time: string
  properties: Record<string, unknown>
  markdown: string
}

function statusPage(id: string, kippId: number, status: string, lastEdited = "2026-07-02T12:00:00Z") {
  return {
    id,
    created_time: "2026-07-01T12:00:00Z",
    last_edited_time: lastEdited,
    properties: {
      "Kipp ID": { unique_id: { prefix: null, number: kippId } },
      Status: { status: { name: status } },
      Source: { select: { name: "manual" } },
      Title: { title: [{ type: "text", text: { content: `Idea ${kippId}` } }] },
    },
    markdown: `Body of idea ${kippId}`,
  }
}

function statusOf(page: NotionPage): string {
  return (page.properties.Status as { status: { name: string } }).status.name
}

function kippIdOf(page: NotionPage): number {
  return (page.properties["Kipp ID"] as { unique_id: { number: number } }).unique_id.number
}

function notionFetch(pages: NotionPage[]) {
  return vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    const respond = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      headers: new Map(),
    })
    if (urlStr === `https://api.notion.com/v1/data_sources/${NOTION_DS}/query`) {
      const body = JSON.parse(opts?.body as string) as {
        filter?: {
          property?: string
          status?: { equals?: string }
          or?: Array<{ property?: string; status?: { equals?: string } }>
        }
        sorts?: Array<{ property?: string; timestamp?: string; direction: string }>
      }
      const statuses =
        body.filter?.property === "Status" && body.filter.status?.equals
          ? [body.filter.status.equals]
          : (body.filter?.or ?? [])
              .filter((clause) => clause.property === "Status")
              .map((clause) => clause.status?.equals)
              .filter((value): value is string => Boolean(value))
      let results = statuses.length > 0 ? pages.filter((p) => statuses.includes(statusOf(p))) : [...pages]
      // Mirror the manager's Kipp ID ascending sort only when the production
      // sort configuration is present, so a missing sort in cadence fails tests.
      const sortByKippId = (body.sorts ?? []).some((s) => s.property === "Kipp ID" && s.direction === "ascending")
      if (sortByKippId) results = results.sort((a, b) => kippIdOf(a) - kippIdOf(b))
      return respond({ object: "list", results, has_more: false, next_cursor: null })
    }
    const markdownMatch = urlStr.match(/\/v1\/pages\/([^/]+)\/markdown$/)
    if (markdownMatch) {
      const page = pages.find((p) => p.id === markdownMatch[1])
      if (!page) return respond({ message: "object_not_found" }, 404)
      return respond({
        object: "page_markdown",
        id: page.id,
        markdown: page.markdown,
        truncated: false,
        unknown_block_ids: [],
      })
    }
    const pageMatch = urlStr.match(/\/v1\/pages\/([^/]+)$/)
    if (pageMatch) {
      const page = pages.find((p) => p.id === pageMatch[1])
      if (!page) return respond({ message: "object_not_found" }, 404)
      return respond(page)
    }
    throw new Error(`Unexpected fetch ${urlStr}`)
  })
}

function mockEnv() {
  const startMocks = new Map<string, ReturnType<typeof vi.fn>>()
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
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
    LINKEDIN_ACCESS_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    NOTION_API_KEY: "secret",
    NOTION_IDEAS_DATA_SOURCE_ID: NOTION_DS,
    NOTION_FREE_TIER: "false",
    IDEA_INGEST: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => {
        let fetchMock = startMocks.get(id.name)
        if (!fetchMock) {
          fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ workflowInstanceId: "wf-1", alreadyStarted: false }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
          startMocks.set(id.name, fetchMock)
        }
        return { fetch: fetchMock }
      },
    },
    startMocks,
    PIPELINE_WORKFLOW: { create: vi.fn().mockResolvedValue({ id: "wf-1" }) },
  }
}

const NOW = new Date("2026-07-12T12:00:00.000Z").getTime()

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("handleCadenceCron", () => {
  it("skips when an idea is awaiting-feedback", async () => {
    vi.stubGlobal("fetch", notionFetch([statusPage("p1", 1, "awaiting-feedback")]))
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.startMocks.size).toBe(0)
  })

  it("skips when an idea is awaiting-feedback-expired", async () => {
    vi.stubGlobal("fetch", notionFetch([statusPage("p1", 1, "awaiting-feedback-expired")]))
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.startMocks.size).toBe(0)
  })

  it("skips when a finalized idea was edited recently", async () => {
    vi.stubGlobal("fetch", notionFetch([statusPage("p2", 2, "finalized", "2026-07-10T12:00:00Z")]))
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.startMocks.size).toBe(0)
  })

  it("starts a workflow for the oldest raw idea when cadence is due", async () => {
    vi.stubGlobal(
      "fetch",
      notionFetch([
        statusPage("p2", 2, "raw", "2026-07-02T12:00:00Z"),
        statusPage("p1", 1, "raw", "2026-07-02T12:00:00Z"),
      ]),
    )
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(true)
    expect(result.ideaId).toBe("1")
    expect(result.workflowInstanceId).toBe("wf-1")
    const claimMock = env.startMocks.get("claim:p1")!
    expect(claimMock).toBeDefined()
    const [, init] = claimMock.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ pageId: "p1", ideaId: "1", source: "manual" })
  })

  it("returns started:false when no raw ideas exist", async () => {
    vi.stubGlobal("fetch", notionFetch([]))
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
    expect(env.startMocks.size).toBe(0)
  })

  it("uses last_edited_time of the most recent finalized idea for the cadence check", async () => {
    vi.stubGlobal("fetch", notionFetch([statusPage("p2", 2, "finalized", "2026-07-10T12:00:00Z")]))
    const env = mockEnv()
    const result = await handleCadenceCron(env as never)
    expect(result.started).toBe(false)
  })
})
