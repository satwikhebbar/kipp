import { createIdeaIngest } from "../core/idea-ingest"
import type { Env } from "../core/types"
import { createNotionClient } from "../integrations/notion"
import { createTelegramClient, TELEGRAM_NOTIFY_TIMEOUT_MS } from "../integrations/telegram"
import { createIdeaManager } from "../linkedin/ideas/manager"
import { createToolProvider } from "../providers"
import { isTransientHttpStatus } from "../runtime/http"
import { parseSubstackArticle } from "../substack/article"
import { assembleSubstackIdeaBody, runSubstackIdeaToolSession, selectSubstackIdeas } from "../substack/idea-agent"

export interface RssItem {
  title: string
  subtitle?: string
  link: string
  guid: string
  pubDate: string
  contentHtml: string
}

const DEFAULT_RSS_RETRIES = 3
const RSS_FETCH_MAX_RETRIES = 3
const RSS_FETCH_BACKOFF_MS = 1_000
// Bump this namespace when the RSS idea-generation contract changes so stale
// IdeaIngestDO records cannot point a fresh run at deleted Notion pages.
const RSS_IDEMPOTENCY_NAMESPACE = "rss:v2"

/** Safe metadata for an RSS request that exhausted its bounded retry policy. */
export class RssFetchError extends Error {
  constructor(
    public readonly status: number,
    public readonly attempts: number,
    public readonly transient: boolean,
  ) {
    super(`RSS fetch error ${status} after ${attempts} attempt${attempts === 1 ? "" : "s"}`)
    this.name = "RssFetchError"
  }
}

/** Parses RSS XML into article metadata, its optional subtitle, and content:encoded HTML. */
export function parseRssFeed(xml: string): RssItem[] {
  const items: RssItem[] = []
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi
  for (;;) {
    const match = itemPattern.exec(xml)
    if (!match) break
    const block = match[1]
    const extract = (tag: string) => {
      const matched = block.match(new RegExp(`<${tag}[^>]*>(.*?)<\\/${tag}>`, "is"))
      if (!matched) return ""
      return matched[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim()
    }
    const subtitle = extract("description")
    items.push({
      title: extract("title"),
      ...(subtitle ? { subtitle } : {}),
      link: extract("link"),
      guid: extract("guid"),
      pubDate: extract("pubDate"),
      contentHtml: extract("content:encoded"),
    })
  }
  return items
}

/** Stable non-empty identity for an RSS item: its GUID when present, else its canonical link. */
export function itemIdentity(item: Pick<RssItem, "guid" | "link">): string {
  return item.guid ? `guid:${item.guid}` : `link:${item.link}`
}

/** Checks the RSS feed for one unseen article and saves its raw, source-grounded idea candidates. */
export async function handleRssCron(env: Env): Promise<{ started: boolean; ideaId?: string }> {
  const manager = createIdeaManager(createNotionClient(env))
  const ingest = createIdeaIngest(env)
  const items = await fetchRssItems(env.SUBSTACK_RSS_URL)
  if (items.length === 0) return { started: false }

  const knownLinks = new Set(
    (await manager.listIdeas()).map((idea) => idea.substackUrl).filter((url): url is string => Boolean(url)),
  )
  const newItem = items.find((item) => !knownLinks.has(item.link)) ?? null
  if (!newItem) return { started: false }

  const article = parseSubstackArticle({
    title: newItem.title,
    subtitle: newItem.subtitle,
    sourceUrl: newItem.link,
    contentHtml: newItem.contentHtml,
  })
  const provider = createToolProvider(
    env.LLM_API_KEY,
    env.LLM_PROVIDER || "gemini",
    env.LLM_MODEL,
    Number(env.LLM_MAX_RETRIES ?? DEFAULT_RSS_RETRIES),
  )
  const session = await runSubstackIdeaToolSession(provider, article)
  if (!session.terminal)
    throw new Error(`Substack idea extraction did not submit candidates: ${session.failureReason ?? "unknown"}`)

  const ideasToSave = selectSubstackIdeas(session.terminal.ideas)
  if (ideasToSave.length === 0) return { started: false }

  const identity = itemIdentity(newItem)
  const saved = []
  for (const [index, candidate] of ideasToSave.entries()) {
    saved.push(
      await ingest.ingest({
        key: `${RSS_IDEMPOTENCY_NAMESPACE}:${identity}:${index}`,
        idea: {
          title: candidate.title,
          status: "raw",
          source: "substack",
          substackUrl: newItem.link,
          body: assembleSubstackIdeaBody(candidate),
        },
        startWorkflow: false,
      }),
    )
  }
  await notifyIdeasAdded(
    env,
    newItem.title,
    ideasToSave.map((idea) => idea.title),
  )
  return { started: true, ideaId: saved[0]?.ideaId }
}

/** Sends a best-effort concise summary after all raw ideas are safely stored. */
async function notifyIdeasAdded(env: Env, articleTitle: string, ideaTitles: string[]): Promise<void> {
  const chatId = env.TELEGRAM_ALLOWED_USER_ID.trim()
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return
  const titles = ideaTitles.map((title) => `• ${title}`).join("\n")
  const message = `Added ${ideaTitles.length} raw Substack idea${ideaTitles.length === 1 ? "" : "s"} from ${articleTitle}:\n${titles}`
  await createTelegramClient(env.TELEGRAM_BOT_TOKEN)
    .sendMessage(chatId, message, { signal: AbortSignal.timeout(TELEGRAM_NOTIFY_TIMEOUT_MS) })
    .catch(() => {})
}

/** Fetches and parses an RSS feed from a URL, retrying transient failures (429/5xx). */
async function fetchRssItems(url: string): Promise<RssItem[]> {
  let lastStatus = 0
  let attempts = 0
  let lastFailureWasNetworkError = false
  for (let attempt = 0; attempt <= RSS_FETCH_MAX_RETRIES; attempt++) {
    attempts++
    try {
      const res = await fetch(url)
      if (res.ok) return parseRssFeed(await res.text())
      lastStatus = res.status
      lastFailureWasNetworkError = false
    } catch {
      lastStatus = 0
      lastFailureWasNetworkError = true
    }
    if (!(lastFailureWasNetworkError || isTransientHttpStatus(lastStatus)) || attempt === RSS_FETCH_MAX_RETRIES) break
    await new Promise((resolve) => setTimeout(resolve, RSS_FETCH_BACKOFF_MS * 2 ** attempt))
  }
  throw new RssFetchError(lastStatus, attempts, lastFailureWasNetworkError || isTransientHttpStatus(lastStatus))
}
