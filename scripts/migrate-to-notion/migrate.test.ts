import { afterEach, describe, expect, it, vi } from "vitest"
import { createGitHubClient } from "../../src/integrations/github"
import { createNotionClient } from "../../src/integrations/notion"
import { createIdeaManager, type IdeaManager } from "../../src/linkedin/ideas/manager"
import { main, migrateFile, runMigration } from "./migrate"

const NOTION_DS = "ds-1"

function respond(body: unknown, status = 200) {
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Map(),
  }
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const IDEAS_MD = `---
id: 1
title: First idea
status: raw
source: telegram
created: 2026-07-01T12:00:00Z
---

Body one

---
id: 2
title: Second idea
status: finalized
source: substack
substackUrl: https://x.test/p
created: 2026-07-02T12:00:00Z
---

Body two`

const ARCHIVE_MD = `---
id: 7
title: Archived idea
status: finalized
source: manual
created: 2026-06-01T12:00:00Z
---

Archived body`

const DRAFTED_MD = `---
id: 3
title: Drafted idea
status: drafted
source: substack
created: 2026-07-03T09:00:00Z
---

Raw preamble body.

## Draft

This is the LLM draft.

## Critique

- [x] Clarity: Good
- [ ] Hook: Needs work`

interface StoredPage {
  kippId: number
  idempotencyKey?: string
  status: string
  source: string
  markdown: string
}

interface NotionPageStore {
  pages: Map<string, StoredPage>
}

function pageJson(stored: StoredPage) {
  return {
    object: "page",
    id: `page_${stored.kippId}`,
    created_time: "2026-08-01T00:00:00.000Z",
    properties: { "Kipp ID": { type: "unique_id", unique_id: { prefix: null, number: stored.kippId } } },
  }
}

function createNotionStub(store: NotionPageStore, failCreate = false) {
  let nextKippId = store.pages.size + 1
  return vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (urlStr === `https://api.notion.com/v1/data_sources/${NOTION_DS}/query`) {
      const body = JSON.parse(opts?.body as string) as {
        filter?: { property: string; rich_text?: { equals?: string } }
      }
      const key = body.filter?.property === "Idempotency Key" ? body.filter.rich_text?.equals : undefined
      const results = key ? [...store.pages.values()].filter((p) => p.idempotencyKey === key).map(pageJson) : []
      return respond({ object: "list", results, has_more: false, next_cursor: null })
    }
    if (urlStr === "https://api.notion.com/v1/pages" && opts?.method === "POST") {
      if (failCreate) return respond({ message: "validation_error" }, 400)
      const body = JSON.parse(opts.body as string) as {
        properties: {
          Status?: { status?: { name: string } }
          Source?: { select?: { name: string } }
          "Idempotency Key"?: { rich_text?: Array<{ text: { content: string } }> }
        }
        markdown: string
      }
      const kippId = nextKippId++
      const stored: StoredPage = {
        kippId,
        idempotencyKey: body.properties["Idempotency Key"]?.rich_text?.[0]?.text?.content,
        status: body.properties.Status?.status?.name ?? "raw",
        source: body.properties.Source?.select?.name ?? "manual",
        markdown: body.markdown,
      }
      store.pages.set(`page_${kippId}`, stored)
      return respond(pageJson(stored))
    }
    const markdownMatch = urlStr.match(/\/v1\/pages\/([^/]+)\/markdown$/)
    if (markdownMatch) {
      const stored = store.pages.get(markdownMatch[1])
      if (!stored) return respond({ message: "object_not_found" }, 404)
      return respond({
        object: "page_markdown",
        id: markdownMatch[1],
        markdown: stored.markdown,
        truncated: false,
        unknown_block_ids: [],
      })
    }
    throw new Error(`Unexpected notion fetch: ${opts?.method ?? "GET"} ${urlStr}`)
  })
}

function githubStub(githubFiles: Record<string, string>) {
  return vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    const match = urlStr.match(/\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)/)
    if (!match) return respond({ message: "not found" }, 404)
    const path = match[3]
    if (opts?.method === "PUT") return respond({ content: { sha: "new-sha" } })
    if (!(path in githubFiles)) return respond({ message: "Not Found" }, 404)
    return respond({ content: b64(githubFiles[path]), sha: "sha1" })
  })
}

function stubNetwork(notionFetch: ReturnType<typeof createNotionStub>, files: Record<string, string>) {
  const githubFetch = githubStub(files)
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (urlStr.includes("api.notion.com")) return notionFetch(url, opts)
    if (urlStr.includes("api.github.com")) return githubFetch(url, opts)
    throw new Error(`Unexpected fetch ${urlStr}`)
  })
}

function manager(store: NotionPageStore): IdeaManager {
  return createIdeaManager(
    createNotionClient({ NOTION_API_KEY: "secret", NOTION_IDEAS_DATA_SOURCE_ID: NOTION_DS, NOTION_FREE_TIER: "false" }),
  )
}

function githubClient() {
  return createGitHubClient({ GITHUB_PAT: "pat", DATA_REPO_OWNER: "o", DATA_REPO_NAME: "r" })
}

const CONFIG = {
  GITHUB_PAT: "pat",
  DATA_REPO_OWNER: "o",
  DATA_REPO_NAME: "r",
  NOTION_API_KEY: "secret",
  NOTION_IDEAS_DATA_SOURCE_ID: NOTION_DS,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("migrateFile", () => {
  it("maps a legacy file to the correct idempotency key prefix", async () => {
    const store: NotionPageStore = { pages: new Map() }
    const notionFetch = createNotionStub(store)
    stubNetwork(notionFetch, { "ideas.md": IDEAS_MD, "archive.md": ARCHIVE_MD })

    const report = await migrateFile(manager(store), githubClient(), "archive.md")
    expect(report.created).toBe(1)
    const stored = [...store.pages.values()][0]
    expect(stored.idempotencyKey).toBe("legacy:archive:7")
    expect(stored.markdown).toBe("Archived body")
    expect(stored.status).toBe("finalized")
  })

  it("excludes draft and critique sections from the migrated page markdown", async () => {
    const store: NotionPageStore = { pages: new Map() }
    const notionFetch = createNotionStub(store)
    stubNetwork(notionFetch, { "ideas.md": DRAFTED_MD, "archive.md": "" })

    const report = await migrateFile(manager(store), githubClient(), "ideas.md")
    expect(report.created).toBe(1)
    const stored = [...store.pages.values()][0]
    expect(stored.markdown).toBe("Raw preamble body.")
    expect(stored.markdown).not.toContain("## Draft")
    expect(stored.markdown).not.toContain("## Critique")
    expect(stored.markdown).not.toContain("This is the LLM draft.")
    expect(stored.markdown).not.toContain("Clarity: Good")
  })
})

describe("runMigration", () => {
  it("creates Notion pages keyed by legacy idempotency keys", async () => {
    const store: NotionPageStore = { pages: new Map() }
    const notionFetch = createNotionStub(store)
    stubNetwork(notionFetch, { "ideas.md": IDEAS_MD, "archive.md": ARCHIVE_MD })

    const report = await runMigration(CONFIG)
    expect(report.created).toBe(3)
    expect(report.skipped).toBe(0)
    expect(report.failures).toEqual([])
    const keys = [...store.pages.values()].map((p) => p.idempotencyKey).sort()
    expect(keys).toEqual(["legacy:archive:7", "legacy:backlog:1", "legacy:backlog:2"])
    const first = [...store.pages.values()].find((p) => p.idempotencyKey === "legacy:backlog:1")
    expect(first?.markdown).toBe("Body one")
  })

  it("rerunning after a partial failure creates only the missing pages", async () => {
    const store: NotionPageStore = { pages: new Map() }
    const notionFetch = createNotionStub(store)
    stubNetwork(notionFetch, { "ideas.md": IDEAS_MD, "archive.md": ARCHIVE_MD })

    const first = await runMigration(CONFIG)
    expect(first.created).toBe(3)

    const second = await runMigration(CONFIG)
    expect(second.created).toBe(0)
    expect(second.skipped).toBe(3)
    expect(store.pages.size).toBe(3)
  })

  it("reports failures without stopping the migration", async () => {
    const store: NotionPageStore = { pages: new Map() }
    const notionFetch = createNotionStub(store, true)
    stubNetwork(notionFetch, { "ideas.md": IDEAS_MD, "archive.md": "" })

    const report = await runMigration(CONFIG)
    expect(report.created).toBe(0)
    expect(report.skipped).toBe(0)
    expect(report.failures).toHaveLength(2)
    expect(report.failures.every((f) => f.key.startsWith("legacy:backlog:"))).toBe(true)
  })
})

describe("migrate CLI", () => {
  it("exits non-zero when the migration report has failures", async () => {
    const store: NotionPageStore = { pages: new Map() }
    const notionFetch = createNotionStub(store, true)
    stubNetwork(notionFetch, { "ideas.md": IDEAS_MD, "archive.md": ARCHIVE_MD })

    const savedEnv = { ...process.env }
    const savedExitCode = process.exitCode
    process.exitCode = undefined
    Object.assign(process.env, CONFIG)
    let exitCode: number | undefined
    try {
      await main()
      exitCode = process.exitCode
    } finally {
      process.env = savedEnv
      process.exitCode = savedExitCode
    }
    expect(exitCode).toBe(1)
  })

  it("fails fast when a required environment variable is missing", async () => {
    const savedEnv = { ...process.env }
    const savedExitCode = process.exitCode
    process.exitCode = undefined
    delete process.env.GITHUB_PAT
    try {
      await expect(main()).rejects.toThrow("Missing required environment variable")
    } finally {
      process.env = savedEnv
      process.exitCode = savedExitCode
    }
  })
})
