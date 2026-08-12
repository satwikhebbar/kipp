import type { Idea, IdeaStatus, IdeaSummary, Source } from "../../core/types"
import { type NotionClient, type NotionPagePropertiesInput, pageToIdea, pageToSummary } from "../../integrations/notion"

export interface IdeaInput {
  title?: string
  status?: IdeaStatus
  source: Source
  body: string
  substackUrl?: string
  chatId?: string
  idempotencyKey?: string
}

export interface IdeaUpdate {
  title?: string
  status?: IdeaStatus
  substackUrl?: string
  chatId?: string
  body?: string
}

export interface IdeaManager {
  listIdeas(): Promise<IdeaSummary[]>
  getIdea(pageId: string): Promise<Idea>
  getIdeasByStatuses(statuses: IdeaStatus[]): Promise<IdeaSummary[]>
  getNextIdea(): Promise<Idea | null>
  createIdea(input: IdeaInput): Promise<Idea>
  updateIdea(pageId: string, update: IdeaUpdate): Promise<void>
  moveToArchive(idea: Idea): Promise<void>
  findBySubstackUrl(url: string): Promise<IdeaSummary | null>
  findByIdempotencyKey(key: string): Promise<IdeaSummary | null>
  getLatestFinalizedTimestamp(): Promise<number>
}

const KIPP_ID_ASCENDING = [{ property: "Kipp ID", direction: "ascending" }]
const LAST_EDITED_DESCENDING = [{ timestamp: "last_edited_time", direction: "descending" }]

/** Creates an idea manager over a Notion client for CRUD on the Ideas data source. */
export function createIdeaManager(client: NotionClient): IdeaManager {
  async function listIdeas(): Promise<IdeaSummary[]> {
    const pages = await client.queryPages(null, KIPP_ID_ASCENDING)
    return pages.map(pageToSummary)
  }

  async function getIdea(pageId: string): Promise<Idea> {
    const page = await client.getPage(pageId)
    const body = await client.getPageMarkdown(pageId)
    return pageToIdea(page, body)
  }

  async function getIdeasByStatuses(statuses: IdeaStatus[]): Promise<IdeaSummary[]> {
    if (statuses.length === 0) return []
    const pages = await client.queryPages(
      { or: statuses.map((status) => ({ property: "Status", status: { equals: status } })) },
      KIPP_ID_ASCENDING,
    )
    return pages.map(pageToSummary)
  }

  async function getNextIdea(): Promise<Idea | null> {
    const pages = await client.queryPages({ property: "Status", status: { equals: "raw" } }, KIPP_ID_ASCENDING)
    if (pages.length === 0) return null
    return getIdea(pageToSummary(pages[0]).pageId)
  }

  async function createIdea(input: IdeaInput): Promise<Idea> {
    if (input.idempotencyKey) {
      const existing = await findByIdempotencyKey(input.idempotencyKey)
      if (existing) return getIdea(existing.pageId)
    }
    const properties: NotionPagePropertiesInput = {
      title: input.title,
      status: input.status ?? "raw",
      source: input.source,
      substackUrl: input.substackUrl,
      chatId: input.chatId,
      idempotencyKey: input.idempotencyKey,
    }
    const page = await client.createPage(properties, input.body)
    return pageToIdea(page, input.body)
  }

  async function updateIdea(pageId: string, update: IdeaUpdate): Promise<void> {
    if (
      update.title !== undefined ||
      update.status !== undefined ||
      update.substackUrl !== undefined ||
      update.chatId !== undefined
    ) {
      await client.patchPageProperties(pageId, {
        title: update.title,
        status: update.status,
        substackUrl: update.substackUrl,
        chatId: update.chatId,
      })
    }
    if (update.body !== undefined) await client.patchPageMarkdown(pageId, update.body)
  }

  async function moveToArchive(idea: Idea): Promise<void> {
    await client.patchPageProperties(idea.pageId, { status: "finalized" })
  }

  async function findBySubstackUrl(url: string): Promise<IdeaSummary | null> {
    const pages = await client.queryPages({ property: "Substack URL", url: { equals: url } }, [], 1)
    return pages.length > 0 ? pageToSummary(pages[0]) : null
  }

  async function findByIdempotencyKey(key: string): Promise<IdeaSummary | null> {
    const pages = await client.queryPages({ property: "Idempotency Key", rich_text: { equals: key } }, [], 1)
    return pages.length > 0 ? pageToSummary(pages[0]) : null
  }

  async function getLatestFinalizedTimestamp(): Promise<number> {
    const pages = await client.queryPages(
      { property: "Status", status: { equals: "finalized" } },
      LAST_EDITED_DESCENDING,
      1,
    )
    if (pages.length === 0) return 0
    const ts = new Date(pages[0].last_edited_time).getTime()
    return Number.isNaN(ts) ? 0 : ts
  }

  return {
    listIdeas,
    getIdea,
    getIdeasByStatuses,
    getNextIdea,
    createIdea,
    updateIdea,
    moveToArchive,
    findBySubstackUrl,
    findByIdempotencyKey,
    getLatestFinalizedTimestamp,
  }
}
