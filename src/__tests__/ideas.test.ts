import { describe, expect, it } from "vitest"
import type { NotionClient, NotionPage, NotionPagePropertiesInput } from "../integrations/notion"
import { createIdeaManager } from "../linkedin/ideas/manager"

interface StoredPage {
  page: NotionPage
  markdown: string
}

function titleProp(value: string) {
  return { title: [{ type: "text", text: { content: value } }] }
}

function statusProp(value: string) {
  return { status: { name: value } }
}

function selectProp(value: string) {
  return { select: { name: value } }
}

function richTextProp(value: string) {
  return { rich_text: [{ type: "text", text: { content: value } }] }
}

function page(id: string, kippId: number, status: string, source: string, extra: Record<string, unknown> = {}) {
  const properties = {
    Title: titleProp(`Idea ${kippId}`),
    "Kipp ID": { unique_id: { prefix: null, number: kippId } },
    Status: statusProp(status),
    Source: selectProp(source),
  }
  return {
    id,
    created_time: "2026-07-01T12:00:00Z",
    last_edited_time: "2026-07-02T12:00:00Z",
    properties: { ...properties, ...extra },
  } as NotionPage
}

function fakeClient(seed: StoredPage[] = []) {
  const pages = new Map<string, StoredPage>()
  for (const stored of seed) pages.set(stored.page.id, stored)
  let nextKippId = pages.size + 1

  const client: NotionClient = {
    async getPage(pageId) {
      const stored = pages.get(pageId)
      if (!stored) throw new Error(`Notion page ${pageId} not found`)
      return stored.page
    },
    async createPage(properties: NotionPagePropertiesInput, markdown: string) {
      const id = `page_${pages.size + 1}`
      const created = page(id, nextKippId++, properties.status ?? "raw", properties.source ?? "manual", {
        ...(properties.title ? { Title: titleProp(properties.title) } : {}),
        ...(properties.substackUrl ? { "Substack URL": { url: properties.substackUrl } } : {}),
        ...(properties.chatId ? { "Chat ID": richTextProp(properties.chatId) } : {}),
        ...(properties.idempotencyKey ? { "Idempotency Key": richTextProp(properties.idempotencyKey) } : {}),
      })
      pages.set(id, { page: created, markdown })
      return created
    },
    async patchPageProperties(pageId, update) {
      const stored = pages.get(pageId)
      if (!stored) throw new Error(`Notion page ${pageId} not found`)
      const props = { ...stored.page.properties }
      if (update.status) props.Status = statusProp(update.status)
      if (update.title) props.Title = titleProp(update.title)
      if (update.substackUrl) props["Substack URL"] = { url: update.substackUrl }
      if (update.chatId) props["Chat ID"] = richTextProp(update.chatId)
      stored.page = { ...stored.page, properties: props, last_edited_time: "2026-07-03T12:00:00Z" }
    },
    async getPageMarkdown(pageId) {
      const stored = pages.get(pageId)
      if (!stored) throw new Error(`Notion page ${pageId} not found`)
      return stored.markdown
    },
    async patchPageMarkdown(pageId, newStr) {
      const stored = pages.get(pageId)
      if (!stored) throw new Error(`Notion page ${pageId} not found`)
      stored.markdown = newStr
    },
    async queryPages(filter, sorts) {
      let results = [...pages.values()].map((stored) => stored.page)
      if (filter) {
        const property = filter.property as string
        const value = (filter[property] ?? filter.status ?? filter.url ?? filter.rich_text) as { equals?: string }
        results = results.filter((p) => {
          const prop = p.properties[property] as
            | { equals?: string }
            | { status?: { name: string } }
            | { url?: string }
            | { unique_id?: { number: number } }
            | { title?: Array<{ text: { content: string } }> }
            | { rich_text?: Array<{ text: { content: string } }> }
            | undefined
          if (property === "Status") return (prop as { status?: { name: string } })?.status?.name === value.equals
          if (property === "Substack URL") return (prop as { url?: string })?.url === value.equals
          if (property === "Idempotency Key") {
            const rich = (prop as { rich_text?: Array<{ text: { content: string } }> })?.rich_text?.[0]?.text?.content
            return rich === value.equals
          }
          return true
        })
      }
      for (const sort of sorts as Array<{ property?: string; timestamp?: string; direction: string }>) {
        if (sort.property === "Kipp ID") {
          results = results.sort(
            (a, b) =>
              (a.properties["Kipp ID"] as { unique_id: { number: number } }).unique_id.number -
              (b.properties["Kipp ID"] as { unique_id: { number: number } }).unique_id.number,
          )
        } else if (sort.timestamp === "last_edited_time") {
          results = results.sort(
            (a, b) => new Date(b.last_edited_time).getTime() - new Date(a.last_edited_time).getTime(),
          )
        }
      }
      return results
    },
  }

  return { client, pages }
}

describe("createIdeaManager", () => {
  it("lists all ideas as metadata-only summaries", async () => {
    const { client } = fakeClient([
      { page: page("p1", 1, "raw", "telegram"), markdown: "Body one" },
      { page: page("p2", 2, "finalized", "manual"), markdown: "Body two" },
    ])
    const manager = createIdeaManager(client)
    const ideas = await manager.listIdeas()
    expect(ideas.map((i) => i.id)).toEqual(["1", "2"])
    expect(ideas[0]).not.toHaveProperty("body")
  })

  it("getIdea hydrates the page body", async () => {
    const { client } = fakeClient([{ page: page("p1", 1, "raw", "telegram"), markdown: "# Body one" }])
    const manager = createIdeaManager(client)
    const idea = await manager.getIdea("p1")
    expect(idea.body).toBe("# Body one")
    expect(idea.pageId).toBe("p1")
    expect(idea.id).toBe("1")
  })

  it("getIdeasByStatus filters by status", async () => {
    const { client } = fakeClient([
      { page: page("p1", 1, "raw", "telegram"), markdown: "one" },
      { page: page("p2", 2, "finalized", "manual"), markdown: "two" },
    ])
    const manager = createIdeaManager(client)
    const raw = await manager.getIdeasByStatus("raw")
    expect(raw).toHaveLength(1)
    expect(raw[0].id).toBe("1")
  })

  it("getNextIdea returns the lowest raw idea with hydrated body", async () => {
    const { client } = fakeClient([
      { page: page("p2", 2, "raw", "manual"), markdown: "Second" },
      { page: page("p1", 1, "raw", "telegram"), markdown: "First" },
    ])
    const manager = createIdeaManager(client)
    const idea = await manager.getNextIdea()
    expect(idea?.id).toBe("1")
    expect(idea?.body).toBe("First")
  })

  it("getNextIdea returns null when no raw ideas exist", async () => {
    const { client } = fakeClient([{ page: page("p2", 2, "finalized", "manual"), markdown: "two" }])
    const manager = createIdeaManager(client)
    expect(await manager.getNextIdea()).toBeNull()
  })

  it("createIdea creates a page and returns the assigned Kipp ID", async () => {
    const { client, pages } = fakeClient()
    const manager = createIdeaManager(client)
    const idea = await manager.createIdea({
      title: "New idea",
      status: "raw",
      source: "telegram",
      body: "New body",
      chatId: "123",
    })
    expect(idea.id).toBe("1")
    expect(idea.pageId).toBeDefined()
    expect(pages.get(idea.pageId)?.markdown).toBe("New body")
  })

  it("createIdea with an existing idempotency key returns the existing page", async () => {
    const { client } = fakeClient([
      { page: page("p1", 1, "raw", "telegram", { "Idempotency Key": richTextProp("tg:1:1") }), markdown: "Existing" },
    ])
    const manager = createIdeaManager(client)
    const idea = await manager.createIdea({
      status: "raw",
      source: "telegram",
      body: "Duplicate",
      idempotencyKey: "tg:1:1",
    })
    expect(idea.pageId).toBe("p1")
    expect(idea.body).toBe("Existing")
  })

  it("updateIdea patches properties and body", async () => {
    const { client, pages } = fakeClient([{ page: page("p1", 1, "raw", "telegram"), markdown: "old" }])
    const manager = createIdeaManager(client)
    await manager.updateIdea("p1", { status: "awaiting-feedback", body: "new" })
    expect((pages.get("p1")!.page.properties.Status as { status: { name: string } }).status.name).toBe(
      "awaiting-feedback",
    )
    expect(pages.get("p1")!.markdown).toBe("new")
  })

  it("moveToArchive sets status to finalized", async () => {
    const { client, pages } = fakeClient([{ page: page("p1", 1, "raw", "telegram"), markdown: "old" }])
    const manager = createIdeaManager(client)
    await manager.moveToArchive({ pageId: "p1", id: "1", status: "raw", created: "", source: "telegram", body: "old" })
    expect((pages.get("p1")!.page.properties.Status as { status: { name: string } }).status.name).toBe("finalized")
  })

  it("findBySubstackUrl returns the matching idea", async () => {
    const { client } = fakeClient([
      { page: page("p1", 1, "raw", "substack", { "Substack URL": { url: "https://x.test/p" } }), markdown: "one" },
    ])
    const manager = createIdeaManager(client)
    const idea = await manager.findBySubstackUrl("https://x.test/p")
    expect(idea?.pageId).toBe("p1")
    expect(await manager.findBySubstackUrl("https://missing.test/p")).toBeNull()
  })

  it("findByIdempotencyKey returns the matching idea", async () => {
    const { client } = fakeClient([
      { page: page("p1", 1, "raw", "telegram", { "Idempotency Key": richTextProp("rss:g:0") }), markdown: "one" },
    ])
    const manager = createIdeaManager(client)
    expect((await manager.findByIdempotencyKey("rss:g:0"))?.pageId).toBe("p1")
    expect(await manager.findByIdempotencyKey("rss:other:0")).toBeNull()
  })

  it("getLatestFinalizedTimestamp returns the most recently edited finalized page time", async () => {
    const { client } = fakeClient([
      { page: page("p1", 1, "finalized", "manual"), markdown: "one" },
      { page: page("p2", 2, "finalized", "manual"), markdown: "two" },
    ])
    const manager = createIdeaManager(client)
    const ts = await manager.getLatestFinalizedTimestamp()
    expect(ts).toBe(new Date("2026-07-02T12:00:00Z").getTime())
  })

  it("getLatestFinalizedTimestamp returns 0 when nothing is finalized", async () => {
    const { client } = fakeClient([{ page: page("p1", 1, "raw", "manual"), markdown: "one" }])
    const manager = createIdeaManager(client)
    expect(await manager.getLatestFinalizedTimestamp()).toBe(0)
  })
})
