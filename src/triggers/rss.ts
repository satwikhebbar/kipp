import { nextId } from "../backlog/id-generator"
import { parseIdeas, serializeIdeas } from "../backlog/parser"
import { createGitHubClient, type GithubClient } from "../integrations/github"
import { createGenerator, type GenerateFn, messages, parseLLMJson } from "../providers"
import type { Env, Idea } from "../types"

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

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

async function llmExtractIdeas(gen: GenerateFn, item: RssItem): Promise<ExtractedIdeas> {
  const text = stripHtml(item.contentHtml).slice(0, 6000)
  const prompt = `Newsletter: "${item.title}"\nURL: ${item.link}\n\nContent:\n${text}`
  const res = await gen(messages(SYSTEM_PROMPT, prompt))
  const parsed = parseLLMJson<ExtractedIdeas>(res.text)
  if (!parsed.teaser || !Array.isArray(parsed.subIdeas)) {
    throw new Error("LLM returned malformed idea extraction")
  }
  return parsed
}

function buildIdeas(item: RssItem, extracted: ExtractedIdeas, existing: Idea[]): { main: Idea; side: Idea[] } {
  const now = new Date().toISOString()
  let id = nextId(existing)
  const main: Idea = {
    id: String(id),
    title: item.title,
    status: "raw",
    created: now,
    source: "substack",
    substackUrl: item.link,
    teaser: extracted.teaser,
    body: extracted.teaser,
  }
  const side: Idea[] = []
  for (const sub of extracted.subIdeas.slice(0, 4)) {
    id++
    side.push({
      id: String(id),
      title: sub.slice(0, 80),
      status: "raw",
      created: now,
      source: "substack",
      substackUrl: item.link,
      body: sub,
    })
  }
  return { main, side }
}

async function writeIdeas(client: GithubClient, ideas: Idea[]): Promise<void> {
  await client.mutateFile("ideas.md", (content) => {
    const existing = parseIdeas(content)
    existing.push(...ideas)
    return serializeIdeas(existing)
  })
}

export async function handleRssCron(env: Env): Promise<{ started: boolean; ideaId?: string }> {
  const client = createGitHubClient(env)

  const items = await fetchRssItems(env.SUBSTACK_RSS_URL)
  if (items.length === 0) return { started: false }

  const existing = parseIdeas((await client.readFile("ideas.md")).content)
  const knownLinks = new Set(existing.map((i) => i.substackUrl).filter(Boolean))
  const newItem = items.find((item) => !knownLinks.has(item.link))
  if (!newItem) return { started: false }

  const gen = createGenerator(
    env.LLM_API_KEY,
    env.LLM_PROVIDER || "gemini",
    env.LLM_MODEL,
    Number(env.LLM_MAX_RETRIES ?? 3),
  )
  const extracted = await llmExtractIdeas(gen, newItem)

  const { main, side } = buildIdeas(newItem, extracted, existing)
  await writeIdeas(client, [main, ...side])

  const instance = await env.PIPELINE_WORKFLOW.create({
    params: { ideaId: main.id, ideaTitle: main.title, ideaBody: main.body },
  })

  return { started: true, ideaId: instance.id }
}

async function fetchRssItems(url: string): Promise<RssItem[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`RSS fetch error ${res.status} for ${url}`)
  return parseRssFeed(await res.text())
}
