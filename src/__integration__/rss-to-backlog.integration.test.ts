import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleRssCron } from "../triggers/rss"
import type { Env } from "../types"
import { createFakeInteractionRouter, createFakeNetwork, createFakeWorkflowBinding } from "./setup"

const RSS_FEED_URL = "https://newsletter.test/feed"

function baseEnv(overrides?: Partial<Env>): Env {
  return {
    GITHUB_PAT: "pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "my-secret",
    TELEGRAM_ALLOWED_USER_ID: "",
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
    LINKEDIN_ACCESS_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    POSTING_CADENCE_DAYS: "7",
    SUBSTACK_RSS_URL: RSS_FEED_URL,
    WAIT_FOR_FEEDBACK_HOURS: "168",
    TOKEN_VAULT: {} as never,
    INTERACTION_ROUTER: createFakeInteractionRouter().namespace,
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as never
}

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
      githubFiles: { "ideas.md": "" },
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
    const ideasMd = state.githubFiles.get("ideas.md")
    expect(ideasMd).toContain("status: raw")
    expect(ideasMd).toContain("source: substack")
    expect(ideasMd).toContain("substackUrl: https://newsletter.test/ai-trends-2026")
    expect(ideasMd).toContain("teaser: AI is evolving fast")
    expect(ideasMd).toContain("LLM agents are the future")
    expect(ideasMd).toContain("Tool use patterns")
    expect(ideasMd).toContain("Safety considerations")

    const created = binding.getCreated()
    expect(created.length).toBe(1)
    expect(created[0].params).toMatchObject({ params: { ideaId: "1" } })
  })

  it("skips items whose substackUrl already exists in ideas.md", async () => {
    const { fetch, getState } = createFakeNetwork({
      githubFiles: {
        "ideas.md": `---
id: 1
title: Existing idea
status: raw
source: substack
substackUrl: https://newsletter.test/ai-trends-2026
---

Existing content`,
      },
      llmResponses: [],
      rssFeedUrl: RSS_FEED_URL,
      rssFeedXml: RSS_ITEM_XML,
    })
    vi.stubGlobal("fetch", fetch)

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    const result = await handleRssCron(env)
    expect(result.started).toBe(false)

    const state = getState()
    const ideasMd = state.githubFiles.get("ideas.md")
    expect(ideasMd).not.toContain("AI is evolving fast")
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
          return { ok: false, status: 500, text: () => Promise.resolve("Server Error") }
        }
        return { ok: true, json: () => Promise.resolve({ content: "cGFzc2Vk", sha: "s1" }) }
      }),
    )

    const env = baseEnv({ PIPELINE_WORKFLOW: binding as never })
    await expect(handleRssCron(env)).rejects.toThrow("RSS fetch error 500")
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
