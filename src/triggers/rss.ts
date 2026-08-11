import { createIdeaIngest } from "../core/idea-ingest"
import type { Env } from "../core/types"
import { createNotionClient } from "../integrations/notion"
import type { IdeaInput } from "../linkedin/ideas/manager"
import { createIdeaManager } from "../linkedin/ideas/manager"
import { createGenerator, type GenerateFn, messages, parseLLMJson } from "../providers"
import { isTransientHttpStatus } from "../runtime/http"

interface RssItem {
  title: string
  link: string
  guid: string
  pubDate: string
  contentHtml: string
}

interface ExtractedIdeas {
  teaser: string
  subIdeas: string[]
}

const SYSTEM_PROMPT = `You extract LinkedIn post ideas from newsletter content.
Return ONLY a JSON object with:
- "teaser": a one-line hook for a LinkedIn post (max 200 chars)
- "subIdeas": an array of 2-4 LinkedIn post ideas based on this content (each max 300 chars)`

/** Parses RSS XML into structured items. */
export function parseRssFeed(xml: string): RssItem[] {
  const items: RssItem[] = []
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi
  for (;;) {
    const match = itemPattern.exec(xml)
    if (!match) break
    const block = match[1]
    const extract = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(.*?)<\\/${tag}>`, "is"))
      if (!m) return ""
      return m[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim()
    }
    items.push({
      title: extract("title"),
      link: extract("link"),
      guid: extract("guid"),
      pubDate: extract("pubDate"),
      contentHtml: extract("content:encoded") || extract("description"),
    })
  }
  return items
}

/** Strips HTML tags and decodes common HTML entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

const RSS_CONTENT_TRUNCATE_LENGTH = 6000
const MAX_SECTION_IDEAS = 4
const MAX_TITLE_LENGTH = 80
const DEFAULT_RSS_RETRIES = 3
const RSS_FETCH_MAX_RETRIES = 3
const RSS_FETCH_BACKOFF_MS = 1_000

/** Uses LLM to extract a teaser and sub-ideas from an RSS item's content. */
async function llmExtractIdeas(gen: GenerateFn, item: RssItem): Promise<ExtractedIdeas> {
  const text = stripHtml(item.contentHtml).slice(0, RSS_CONTENT_TRUNCATE_LENGTH)
  const prompt = `Newsletter: "${item.title}"\nURL: ${item.link}\n\nContent:\n${text}`
  const res = await gen(messages(SYSTEM_PROMPT, prompt))
  const parsed = parseLLMJson<ExtractedIdeas>(res.text)
  if (!parsed.teaser || !Array.isArray(parsed.subIdeas)) {
    throw new Error("LLM returned malformed idea extraction")
  }
  return parsed
}

/** Builds main and side idea inputs from an RSS item and extracted content. */
function buildIdeaInputs(item: RssItem, extracted: ExtractedIdeas): { main: IdeaInput; side: IdeaInput[] } {
  const main: IdeaInput = {
    title: item.title,
    status: "raw",
    source: "substack",
    substackUrl: item.link,
    body: extracted.teaser,
  }
  const side: IdeaInput[] = []
  for (const sub of extracted.subIdeas.slice(0, MAX_SECTION_IDEAS)) {
    side.push({
      title: sub.slice(0, MAX_TITLE_LENGTH),
      status: "raw",
      source: "substack",
      substackUrl: item.link,
      body: sub,
    })
  }
  return { main, side }
}

/** Checks the RSS feed for new items and ingests the first unseen item into Notion. */
export async function handleRssCron(env: Env): Promise<{ started: boolean; ideaId?: string }> {
  const manager = createIdeaManager(createNotionClient(env))
  const ingest = createIdeaIngest(env)

  const items = await fetchRssItems(env.SUBSTACK_RSS_URL)
  if (items.length === 0) return { started: false }

  let newItem: RssItem | null = null
  for (const item of items) {
    if (!(await manager.findBySubstackUrl(item.link))) {
      newItem = item
      break
    }
  }
  if (!newItem) return { started: false }

  const gen = createGenerator(
    env.LLM_API_KEY,
    env.LLM_PROVIDER || "gemini",
    env.LLM_MODEL,
    Number(env.LLM_MAX_RETRIES ?? DEFAULT_RSS_RETRIES),
  )
  const extracted = await llmExtractIdeas(gen, newItem)

  const { main, side } = buildIdeaInputs(newItem, extracted)
  const mainResult = await ingest.ingest({ key: `rss:${newItem.guid}:0`, idea: main, startWorkflow: true })
  for (let i = 0; i < side.length; i++) {
    await ingest.ingest({ key: `rss:${newItem.guid}:${i + 1}`, idea: side[i], startWorkflow: false })
  }

  return { started: true, ideaId: mainResult.workflowInstanceId ?? mainResult.ideaId }
}

/** Fetches and parses an RSS feed from a URL, retrying transient failures (429/5xx). */
async function fetchRssItems(url: string): Promise<RssItem[]> {
  let lastStatus = 0
  for (let attempt = 0; attempt <= RSS_FETCH_MAX_RETRIES; attempt++) {
    const res = await fetch(url)
    if (res.ok) return parseRssFeed(await res.text())
    lastStatus = res.status
    if (!isTransientHttpStatus(res.status) || attempt === RSS_FETCH_MAX_RETRIES) break
    await new Promise((r) => setTimeout(r, RSS_FETCH_BACKOFF_MS * 2 ** attempt))
  }
  throw new Error(`RSS fetch error ${lastStatus} for ${url}`)
}
