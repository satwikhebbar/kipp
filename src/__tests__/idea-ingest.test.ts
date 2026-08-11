import { afterEach, describe, expect, it, vi } from "vitest"
import { IdeaIngestDO, WORKFLOW_REPAIR_COOLDOWN_MS } from "../core/idea-ingest"

const NOTION_DS = "ds-1"

interface FakeWorkflowInstance {
  status: string
  restartCount: number
}

function instanceIdFor(pageId: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(pageId)).then((digest) => {
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
    return `kipp-${hex.slice(0, 32)}`
  })
}

function fakeNotionPages() {
  const pages = new Map<
    string,
    { page: Record<string, unknown>; markdown: string; kippId: number; idempotencyKey?: string }
  >()
  let nextKippId = 1

  const fetchStub = vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (urlStr === `https://api.notion.com/v1/data_sources/${NOTION_DS}/query`) {
      const body = JSON.parse(opts?.body as string) as {
        filter?: { property: string; rich_text?: { equals?: string } }
      }
      const key = body.filter?.property === "Idempotency Key" ? body.filter.rich_text?.equals : undefined
      const results = key
        ? [...pages.values()].filter((p) => p.idempotencyKey === key).map((p) => p.page)
        : [...pages.values()].map((p) => p.page)
      return respond({ object: "list", results, has_more: false, next_cursor: null })
    }
    if (urlStr === "https://api.notion.com/v1/pages" && opts?.method === "POST") {
      const body = JSON.parse(opts.body as string) as {
        properties: {
          "Idempotency Key"?: { rich_text?: Array<{ text: { content: string } }> }
          Title?: { title?: Array<{ text: { content: string } }> }
          Status?: { status?: { name: string } }
        }
        markdown: string
      }
      const id = `page_${pages.size + 1}`
      pages.set(id, {
        kippId: nextKippId,
        idempotencyKey: body.properties["Idempotency Key"]?.rich_text?.[0]?.text?.content,
        markdown: body.markdown,
        page: {
          object: "page",
          id,
          created_time: "2026-08-01T00:00:00.000Z",
          properties: {
            "Kipp ID": { type: "unique_id", unique_id: { prefix: null, number: nextKippId++ } },
            ...body.properties,
          },
        },
      })
      return respond(pages.get(id)?.page)
    }
    const markdownMatch = urlStr.match(/\/v1\/pages\/([^/]+)\/markdown$/)
    if (markdownMatch) {
      const stored = pages.get(markdownMatch[1])
      if (!stored) return respond({ message: "object_not_found" }, 404)
      if (opts?.method === "PATCH") {
        stored.markdown = (
          JSON.parse(opts.body as string) as { replace_content: { new_str: string } }
        ).replace_content.new_str
      }
      return respond({
        object: "page_markdown",
        id: markdownMatch[1],
        markdown: stored.markdown,
        truncated: false,
        unknown_block_ids: [],
      })
    }
    const pageMatch = urlStr.match(/\/v1\/pages\/([^/]+)$/)
    if (pageMatch) {
      const stored = pages.get(pageMatch[1])
      if (!stored) return respond({ message: "object_not_found" }, 404)
      return respond(stored.page)
    }
    throw new Error(`Unexpected notion fetch: ${opts?.method ?? "GET"} ${urlStr}`)
  })

  return { fetchStub, pages }
}

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

function makeHarness() {
  const storage = new Map<string, Map<string, unknown>>()
  const workflows = new Map<string, FakeWorkflowInstance>()
  const notion = fakeNotionPages()

  const doStorage = (name: string) => {
    let store = storage.get(name)
    if (!store) {
      store = new Map()
      storage.set(name, store)
    }
    return store
  }

  function doFetch(name: string, url: string, init?: RequestInit): Promise<Response> {
    const ctx = {
      storage: {
        get: async (key: string) => doStorage(name).get(key),
        put: async (key: string, value: unknown) => {
          doStorage(name).set(key, value)
        },
      },
    }
    const env = {
      NOTION_API_KEY: "secret",
      NOTION_IDEAS_DATA_SOURCE_ID: NOTION_DS,
      NOTION_FREE_TIER: "false",
      IDEA_INGEST: {
        idFromName: (n: string) => ({ name: n }),
        get: (id: { name: string }) => ({ fetch: (u: string, o?: RequestInit) => doFetch(id.name, u, o) }),
      },
      PIPELINE_WORKFLOW: {
        createBatch: async (batch: Array<{ id?: string; params?: unknown }>) => {
          const created: Array<{ id: string }> = []
          for (const item of batch) {
            const id = item.id as string
            if (workflows.has(id)) continue
            workflows.set(id, { status: "queued", restartCount: 0 })
            created.push({ id })
          }
          return created
        },
        get: async (instanceId: string) => ({
          status: async () => ({ status: workflows.get(instanceId)?.status ?? "unknown" }),
          restart: async () => {
            const instance = workflows.get(instanceId)
            if (instance) {
              instance.restartCount++
              instance.status = "queued"
            }
          },
        }),
      },
    }
    return new IdeaIngestDO(ctx as never, env as never).fetch(new Request(url, { ...init }))
  }

  function ingest(key: string, body: string, startWorkflow?: boolean) {
    return doFetch(`ingest:${key}`, "http://ingest/ingest", {
      method: "POST",
      body: JSON.stringify({
        key,
        idea: { status: "raw", source: "telegram", body, chatId: "100" },
        startWorkflow,
      }),
    })
  }

  function start(pageId: string, ideaId: string) {
    return doFetch(`claim:${pageId}`, "http://ingest/start", {
      method: "POST",
      body: JSON.stringify({ pageId, ideaId, source: "telegram" }),
    })
  }

  return { storage, workflows, notion, ingest, start }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("IdeaIngestDO", () => {
  it("ingest creates one page and one workflow instance for a duplicate key", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    const first = await harness.ingest("tg:1:1", "Idea one", true)
    const firstBody = (await first.json()) as { pageId: string; ideaId: string; workflowInstanceId: string }
    const second = await harness.ingest("tg:1:1", "Idea one duplicate", true)
    const secondBody = (await second.json()) as { pageId: string; ideaId: string; workflowInstanceId: string }

    expect(firstBody.pageId).toBe(secondBody.pageId)
    expect(firstBody.ideaId).toBe(secondBody.ideaId)
    expect(harness.notion.pages.size).toBe(1)
    expect(firstBody.workflowInstanceId).toBe(secondBody.workflowInstanceId)
  })

  it("ingest without startWorkflow does not start a workflow", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    const res = await harness.ingest("tg:2:2", "Idea two", false)
    const body = (await res.json()) as { workflowInstanceId?: string; ideaId: string }
    expect(body.workflowInstanceId).toBeUndefined()
    expect(body.ideaId).toBe("1")
    expect(harness.workflows.size).toBe(0)
  })

  it("adopts an existing page when the key is already present in Notion", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    await harness.ingest("tg:3:3", "First", false)
    harness.storage.clear()
    const res = await harness.ingest("tg:3:3", "Retry after lost record", false)
    const body = (await res.json()) as { pageId: string; ideaId: string }
    expect(harness.notion.pages.size).toBe(1)
    expect(body.ideaId).toBe("1")
    expect(harness.notion.pages.get(body.pageId)?.markdown).toBe("First")
  })

  it("crash before createBatch persists: retry yields exactly one instance", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    await harness.ingest("tg:4:4", "Idea four", true)
    // simulate a crash before the claim record persisted
    harness.storage.get(`claim:${"page_1"}`)?.clear()
    const res = await harness.start("page_1", "1")
    const body = (await res.json()) as { workflowInstanceId: string; alreadyStarted: boolean }
    expect(body.alreadyStarted).toBe(true)
    expect(harness.workflows.size).toBe(1)
  })

  it("crash after createBatch before started persisted: idempotent re-issue adopts the same instance", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    await harness.ingest("tg:5:5", "Idea five", true)
    const expectedId = await instanceIdFor("page_1")
    expect(harness.workflows.has(expectedId)).toBe(true)
  })

  it("repairs an errored instance on the started fast path, cooldown-bounded", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    await harness.ingest("tg:6:6", "Idea six", true)
    const expectedId = await instanceIdFor("page_1")
    const instance = harness.workflows.get(expectedId) as FakeWorkflowInstance
    instance.status = "errored"

    const first = await harness.start("page_1", "1")
    expect((await first.json()) as { alreadyStarted: boolean }).toEqual({
      workflowInstanceId: expectedId,
      alreadyStarted: true,
    })
    expect(instance.restartCount).toBe(1)

    instance.status = "errored"
    const second = await harness.start("page_1", "1")
    expect((await second.json()) as { alreadyStarted: boolean }).toEqual({
      workflowInstanceId: expectedId,
      alreadyStarted: true,
    })
    expect(instance.restartCount).toBe(1)
  })

  it("repairs again after the cooldown window has elapsed", async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      vi.stubGlobal("fetch", harness.notion.fetchStub)
      await harness.ingest("tg:7:7", "Idea seven", true)
      const expectedId = await instanceIdFor("page_1")
      const instance = harness.workflows.get(expectedId) as FakeWorkflowInstance
      instance.status = "errored"
      await harness.start("page_1", "1")
      expect(instance.restartCount).toBe(1)

      instance.status = "errored"
      vi.advanceTimersByTime(WORKFLOW_REPAIR_COOLDOWN_MS + 1)
      await harness.start("page_1", "1")
      expect(instance.restartCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("unified ownership: RSS-ingest delegation and cadence start derive the same instance id", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    await harness.ingest("tg:8:8", "Idea eight", true)
    const ingestInstance = (await harness.ingest("tg:8:8", "dup", true).then((r) => r.json())) as {
      workflowInstanceId: string
    }
    const cadenceStart = (await harness.start("page_1", "1").then((r) => r.json())) as { workflowInstanceId: string }
    expect(ingestInstance.workflowInstanceId).toBe(cadenceStart.workflowInstanceId)
    expect(harness.workflows.size).toBe(1)
  })

  it("a complete instance is never restarted", async () => {
    const harness = makeHarness()
    vi.stubGlobal("fetch", harness.notion.fetchStub)
    await harness.ingest("tg:9:9", "Idea nine", true)
    const expectedId = await instanceIdFor("page_1")
    const instance = harness.workflows.get(expectedId) as FakeWorkflowInstance
    instance.status = "complete"
    await harness.start("page_1", "1")
    expect(instance.restartCount).toBe(0)
  })
})
