import { describe, expect, it } from "vitest"
import { createToolProvider } from "../providers"
import { parseSubstackArticle } from "../substack/article"
import { runSubstackIdeaToolSession, selectSubstackIdeas } from "../substack/idea-agent"
import { parseRssFeed } from "../triggers/rss"

const ARTICLE_URL = "https://satwikhebbar.substack.com/p/the-reps-we-are-losing"
const MAX_CANDIDATES = 7
const CONTRACT_TIMEOUT_MS = 90_000
const apiKey = process.env.LLM_API_KEY
const enabled = process.env.SUBSTACK_EVAL === "1" && Boolean(apiKey)
const contractIt = enabled ? it : it.skip

describe("Substack idea generation contract", () => {
  contractIt(
    "extracts grounded candidates from a published RSS article",
    async () => {
      const feedResponse = await fetch("https://satwikhebbar.substack.com/feed")
      expect(feedResponse.ok).toBe(true)
      const item = parseRssFeed(await feedResponse.text()).find((candidate) => candidate.link === ARTICLE_URL)
      expect(item).toBeDefined()
      if (!item) return

      const article = parseSubstackArticle({
        title: item.title,
        subtitle: item.subtitle,
        sourceUrl: item.link,
        contentHtml: item.contentHtml,
      })
      expect(article.sections.length).toBeGreaterThan(1)

      const provider = createToolProvider(apiKey ?? "", process.env.LLM_PROVIDER ?? "gemini", process.env.LLM_MODEL, 0)
      const result = await runSubstackIdeaToolSession(provider, article)

      expect(
        result.completed,
        JSON.stringify({
          failureReason: result.failureReason,
          providerTurns: result.providerTurns,
          toolCallCount: result.toolCallCount,
          toolNames: result.toolNames,
          toolExecutions: result.toolExecutions,
        }),
      ).toBe(true)
      expect(result.terminal?.kind).toBe("ideas_ready")
      expect(result.terminal?.ideas.length).toBeGreaterThanOrEqual(1)
      expect(result.terminal?.ideas.length).toBeLessThanOrEqual(MAX_CANDIDATES)
      expect(selectSubstackIdeas(result.terminal?.ideas ?? []).length).toBeGreaterThan(0)
      for (const idea of result.terminal?.ideas ?? []) {
        expect(idea.title.length).toBeGreaterThan(0)
        expect(idea.excerpt.length).toBeGreaterThan(0)
        expect(idea.coreArgument.length).toBeGreaterThan(0)
        expect(idea.viralityScore).toBeGreaterThanOrEqual(0)
        expect(idea.viralityScore).toBeLessThanOrEqual(10)
        expect(idea.scoreJustification.length).toBeGreaterThan(0)
      }
    },
    CONTRACT_TIMEOUT_MS,
  )
})
