import type { Idea, IdeaStatus, IdeaSummary, Source } from "../core/types"
import { isTransientHttpStatus } from "../runtime/http"

const NOTION_API = "https://api.notion.com"
const NOTION_VERSION = "2026-03-11"

/** Minimum spacing between Notion requests when the free-tier throttle is enabled. */
export const NOTION_RATE_LIMIT_DELAY_MS = 350
const MAX_QUERY_PAGES = 100
const QUERY_PAGE_SIZE = 100
const MAX_RETRIES = 3
const RETRY_BACKOFF_BASE_MS = 500
const RETRY_BACKOFF_MAX_MS = 16_000
const MS_PER_SECOND = 1_000
const BACKOFF_JITTER_MAX_MS = 1_000
const ERROR_DETAIL_MAX_CHARS = 300
const HTTP_OK = 200

export class NotionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "NotionError"
  }
}

export interface NotionPagePropertiesInput {
  title?: string
  status?: IdeaStatus
  source?: Source
  substackUrl?: string
  substackBody?: string
  chatId?: string
  idempotencyKey?: string
}

export interface NotionPage {
  id: string
  created_time: string
  last_edited_time: string
  properties: Record<string, NotionProperty>
}

export interface NotionProperty {
  type?: string
  unique_id?: { prefix: string | null; number: number }
  status?: { name: string }
  select?: { name: string }
  title?: Array<{ type: string; text: { content: string } }>
  url?: string
  rich_text?: Array<{ type: string; text: { content: string } }>
}

export interface NotionClient {
  getPage(pageId: string): Promise<NotionPage>
  createPage(properties: NotionPagePropertiesInput, markdown: string): Promise<NotionPage>
  patchPageProperties(pageId: string, update: NotionPagePropertiesInput): Promise<void>
  getPageMarkdown(pageId: string): Promise<string>
  patchPageMarkdown(pageId: string, newStr: string): Promise<void>
  queryPages(
    filter: Record<string, unknown> | null,
    sorts: Record<string, unknown>[],
    limit?: number,
  ): Promise<NotionPage[]>
}

/** Creates a Notion API client for the Ideas data source. */
export function createNotionClient(env: {
  NOTION_API_KEY: string
  NOTION_IDEAS_DATA_SOURCE_ID: string
  NOTION_FREE_TIER?: string
}): NotionClient {
  const throttled = createRateLimiter(env.NOTION_FREE_TIER !== "false")
  const dataSourceId = env.NOTION_IDEAS_DATA_SOURCE_ID

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  }

  async function request(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await throttled()
      const res = await fetch(url, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      })
      if (res.ok || !isTransientHttpStatus(res.status) || attempt >= MAX_RETRIES) return res
      const retryAfterMs = Number(res.headers.get("Retry-After")) * MS_PER_SECOND
      const delay =
        Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt + Math.random() * BACKOFF_JITTER_MAX_MS, RETRY_BACKOFF_MAX_MS)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  async function readBody<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const detail = await res.text()
      throw new NotionError(
        res.status,
        `Notion request failed (HTTP ${res.status}): ${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}`,
      )
    }
    return (await res.json()) as T
  }

  async function getPage(pageId: string): Promise<NotionPage> {
    const res = await request(`${NOTION_API}/v1/pages/${pageId}`)
    const page = await readBody<NotionPage>(res)
    return page
  }

  async function createPage(properties: NotionPagePropertiesInput, markdown: string): Promise<NotionPage> {
    const res = await request(`${NOTION_API}/v1/pages`, {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: buildProperties(properties),
        markdown,
      }),
    })
    return readBody<NotionPage>(res)
  }

  async function patchPageProperties(pageId: string, update: NotionPagePropertiesInput): Promise<void> {
    const res = await request(`${NOTION_API}/v1/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: buildProperties(update) }),
    })
    await readBody<NotionPage>(res)
  }

  async function getPageMarkdown(pageId: string): Promise<string> {
    const res = await request(`${NOTION_API}/v1/pages/${pageId}/markdown`)
    const body = await readBody<NotionMarkdown>(res)
    if (body.truncated || (body.unknown_block_ids ?? []).length > 0) {
      throw new NotionError(
        HTTP_OK,
        `Notion page ${pageId} markdown is incomplete (truncated: ${body.truncated}, unknown blocks: ${(body.unknown_block_ids ?? []).length})`,
      )
    }
    return body.markdown
  }

  async function patchPageMarkdown(pageId: string, newStr: string): Promise<void> {
    const res = await request(`${NOTION_API}/v1/pages/${pageId}/markdown`, {
      method: "PATCH",
      body: JSON.stringify({
        type: "replace_content",
        replace_content: { new_str: newStr, allow_deleting_content: false },
      }),
    })
    await readBody<NotionMarkdown>(res)
  }

  async function queryPages(
    filter: Record<string, unknown> | null,
    sorts: Record<string, unknown>[],
    limit?: number,
  ): Promise<NotionPage[]> {
    const results: NotionPage[] = []
    let cursor: string | null = null
    for (let page = 0; ; page++) {
      const body: Record<string, unknown> = { page_size: Math.min(QUERY_PAGE_SIZE, limit ?? QUERY_PAGE_SIZE), sorts }
      if (filter) body.filter = filter
      if (cursor) body.start_cursor = cursor
      const res = await request(`${NOTION_API}/v1/data_sources/${dataSourceId}/query`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      const list = await readBody<NotionListResponse>(res)
      if (list.request_status?.type === "incomplete") {
        throw new NotionError(HTTP_OK, "Notion query result limit reached (request_status incomplete)")
      }
      results.push(...list.results)
      if (limit !== undefined && results.length >= limit) break
      if (!list.has_more || !list.next_cursor) break
      if (page + 1 >= MAX_QUERY_PAGES) {
        throw new NotionError(HTTP_OK, `Notion query exceeded ${MAX_QUERY_PAGES} pages; result set is incomplete`)
      }
      cursor = list.next_cursor
    }
    return limit !== undefined ? results.slice(0, limit) : results
  }

  return { getPage, createPage, patchPageProperties, getPageMarkdown, patchPageMarkdown, queryPages }
}

interface NotionMarkdown {
  object: "page_markdown"
  id: string
  markdown: string
  truncated: boolean
  unknown_block_ids?: string[]
}

interface NotionListResponse {
  object: "list"
  results: NotionPage[]
  has_more: boolean
  next_cursor: string | null
  request_status?: { type: string }
}

/** Builds the Notion properties payload, omitting empty fields and the read-only Kipp ID. */
function buildProperties(input: NotionPagePropertiesInput): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  if (input.title) props.Title = { title: [{ type: "text", text: { content: input.title } }] }
  if (input.status) props.Status = { status: { name: input.status } }
  if (input.source) props.Source = { select: { name: input.source } }
  if (input.substackUrl) props["Substack URL"] = { url: input.substackUrl }
  if (input.substackBody)
    props["Substack Body"] = { rich_text: [{ type: "text", text: { content: input.substackBody } }] }
  if (input.chatId) props["Chat ID"] = { rich_text: [{ type: "text", text: { content: input.chatId } }] }
  if (input.idempotencyKey)
    props["Idempotency Key"] = { rich_text: [{ type: "text", text: { content: input.idempotencyKey } }] }
  return props
}

/** Returns a throttle that reserves spaced request slots when enabled, serializing concurrent callers. */
function createRateLimiter(enabled: boolean): () => Promise<void> {
  let nextSlotAt = 0
  return async () => {
    if (!enabled) return
    const now = Date.now()
    const slot = Math.max(now, nextSlotAt)
    nextSlotAt = slot + NOTION_RATE_LIMIT_DELAY_MS
    const wait = slot - now
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

/** Reads the auto-assigned Kipp ID number from a page's Kipp ID property. */
function readKippId(props: Record<string, NotionProperty>): number | undefined {
  return props["Kipp ID"]?.unique_id?.number
}

/** Reads the Status property value. */
function readStatus(props: Record<string, NotionProperty>): IdeaStatus | undefined {
  return props.Status?.status?.name as IdeaStatus | undefined
}

/** Reads the Source select value. */
function readSource(props: Record<string, NotionProperty>): Source | undefined {
  return props.Source?.select?.name as Source | undefined
}

/** Reads the first Title rich-text segment. */
function readTitle(props: Record<string, NotionProperty>): string | undefined {
  return props.Title?.title?.[0]?.text?.content
}

/** Reads the Substack URL property value. */
function readSubstackUrl(props: Record<string, NotionProperty>): string | undefined {
  return props["Substack URL"]?.url
}

/** Reads the Substack reference body rich-text segment. */
function readSubstackBody(props: Record<string, NotionProperty>): string | undefined {
  return props["Substack Body"]?.rich_text?.[0]?.text?.content
}

/** Reads the first Idempotency Key rich-text segment. */
function readIdempotencyKey(props: Record<string, NotionProperty>): string | undefined {
  return props["Idempotency Key"]?.rich_text?.[0]?.text?.content
}

/** Reads the Chat ID property value. */
function readChatId(props: Record<string, NotionProperty>): string | undefined {
  return props["Chat ID"]?.rich_text?.[0]?.text?.content
}

/** Maps a Notion page to the metadata-only IdeaSummary shape. */
export function pageToSummary(page: NotionPage): IdeaSummary {
  const props = page.properties
  const chatId = readChatId(props)
  return {
    pageId: page.id,
    id: String(readKippId(props) ?? ""),
    title: readTitle(props),
    status: readStatus(props) ?? "raw",
    created: page.created_time,
    source: readSource(props) ?? "manual",
    substackUrl: readSubstackUrl(props),
    substackBody: readSubstackBody(props),
    idempotencyKey: readIdempotencyKey(props),
    correlation: chatId ? { telegramChatId: chatId } : undefined,
  }
}

/** Maps a Notion page and its markdown body to the hydrated Idea shape. */
export function pageToIdea(page: NotionPage, body: string): Idea {
  const summary = pageToSummary(page)
  return { ...summary, body }
}
