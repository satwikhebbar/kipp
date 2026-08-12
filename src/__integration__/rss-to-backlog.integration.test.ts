import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleRssCron } from "../triggers/rss"
import { createBaseEnv, createFakeNetwork, createFakeWorkflowBinding } from "./setup"

const RSS_FEED_URL = "https://newsletter.test/feed"

const baseEnv = (overrides?: Parameters<typeof createBaseEnv>[0]) =>
  createBaseEnv({ SUBSTACK_RSS_URL: RSS_FEED_URL, ...overrides })

const RSS_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>AI Trends 2026</title>
      <link>https://newsletter.test/ai-trends-2026</link>
      <guid>ai-trends-2026</guid>
      <pubDate>Mon, 14 Jul 2026 00:00:00 GMT</pubDate>
      <description>Latest trends in AI for 2026 including LLM advances and agentic workflows.</description>
      <content:encoded><![CDATA[<p>This year AI has seen dramatic advances in reasoning, tool use, and autonomous agents.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`

describe("rss-to-backlog", () => {
  let binding: ReturnType<typeof createFakeWorkflowBinding>

  beforeEach(() => {
    binding = createFakeWorkflowBinding()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("adds ideas for a new RSS item and starts a workflow", async () => {
    const { fetch, getState } = createFakeNetwork({
      llmResponses: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  teaser: "AI is evolving fast",
                  subIdeas: ["LLM agents are the future", "Tool use patterns", "Safety considerations"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        },
      ],
      rssFeedUrl: RSS_FEED_URL,
      rssFeedXml: RSS_ITEM_XML,
    })
    vi.stubGlobal("fetch", fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const result = await handleRssCron(env)
    expect(result.started).toBe(true)

    const state = getState()
    const pages = [...state.notionPages.values()]
    const main = pages.find((p) => p.kippId === 1)!
    expect(main.status).toBe("raw")
    expect(main.source).toBe("substack")
    expect(main.substackUrl).toBe("https://newsletter.test/ai-trends-2026")
    expect(main.substackBody).toBe(
      "This year AI has seen dramatic advances in reasoning, tool use, and autonomous agents.",
    )
    expect(main.markdown).toBe("AI is evolving fast")
    const sideMarkdown = pages.filter((p) => p.kippId > 1).map((p) => p.markdown)
    expect(sideMarkdown).toContain("LLM agents are the future")
    expect(sideMarkdown).toContain("Tool use patterns")
    expect(sideMarkdown).toContain("Safety considerations")

    const created = binding.getCreated()
    expect(created.length).toBe(1)
    expect(created[0].params).toMatchObject({ pageId: main.pageId, ideaId: "1", source: "substack" })
  })

  it("skips items whose substackUrl already exists in Notion", async () => {
    const { fetch, getState } = createFakeNetwork({
      notionPages: [
        {
          pageId: "page_1",
          kippId: 1,
          title: "Existing idea",
          status: "raw",
          source: "substack",
          markdown: "Existing content",
          substackUrl: "https://newsletter.test/ai-trends-2026",
        },
      ],
      llmResponses: [],
      rssFeedUrl: RSS_FEED_URL,
      rssFeedXml: RSS_ITEM_XML,
    })
    vi.stubGlobal("fetch", fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const result = await handleRssCron(env)
    expect(result.started).toBe(false)

    const state = getState()
    expect([...state.notionPages.values()]).toHaveLength(1)
    expect(binding.getCreated().length).toBe(0)
  })

  it("does nothing for an empty RSS feed", async () => {
    const { fetch } = createFakeNetwork({
      githubFiles: { "ideas.md": "" },
      llmResponses: [],
      rssFeedUrl: RSS_FEED_URL,
      rssFeedXml: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel></channel>
</rss>`,
    })
    vi.stubGlobal("fetch", fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const result = await handleRssCron(env)
    expect(result.started).toBe(false)
    expect(binding.getCreated().length).toBe(0)
  })

  it("propagates RSS fetch errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
        if (urlStr.includes(RSS_FEED_URL)) {
          return { ok: false, status: 403, text: () => Promise.resolve("Forbidden") }
        }
        return { ok: true, json: () => Promise.resolve({ content: "cGFzc2Vk", sha: "s1" }) }
      }),
    )

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    await expect(handleRssCron(env)).rejects.toThrow("RSS fetch error 403")
  })

  it("propagates malformed LLM response as an error", async () => {
    const { fetch } = createFakeNetwork({
      githubFiles: { "ideas.md": "" },
      llmResponses: [
        {
          choices: [{ message: { content: "not valid json at all" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      ],
      rssFeedUrl: RSS_FEED_URL,
      rssFeedXml: RSS_ITEM_XML,
    })
    vi.stubGlobal("fetch", fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    await expect(handleRssCron(env)).rejects.toThrow()
  })
})
