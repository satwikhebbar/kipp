import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { parseSubstackArticle, SubstackArticleParseError } from "../substack/article"

const input = {
  title: "  A &amp; B  ",
  subtitle: " A useful  subtitle ",
  sourceUrl: "https://example.substack.com/p/post?keep=this",
  contentHtml: `<p>Intro &amp; setup.</p><h1>Duplicate title</h1><div><h2>First section</h2><p>Paragraph <a href="https://example.com/private">with a link</a>.</p><h3>Small heading</h3><ul><li>First item<ul><li>Nested item</li></ul></li></ul><blockquote>A pull quote</blockquote><table><tr><th>One</th><td>Two</td></tr></table><figure><img src="https://substackcdn.com/image.png"><figcaption>Ignore caption</figcaption></figure><div class="subscription-widget"><p>Subscribe for free</p></div></div><h2>Second section</h2><p>Last paragraph`,
}

describe("parseSubstackArticle", () => {
  it("projects authored content into a two-level article without markup noise", () => {
    expect(parseSubstackArticle(input)).toEqual({
      title: "A & B",
      subtitle: "A useful subtitle",
      sourceUrl: input.sourceUrl,
      sections: [
        { heading: null, content: "Intro & setup." },
        {
          heading: "First section",
          content:
            "Paragraph with a link.\n\nSmall heading\n\n• First item\n\n• Nested item\n\nA pull quote\n\nOne | Two",
        },
        { heading: "Second section", content: "Last paragraph" },
      ],
    })
  })

  it("does not leak URLs, media, captions, subscription UI, or duplicate nested content", () => {
    const article = parseSubstackArticle(input)
    const content = article.sections.map((section) => section.content).join("\n")
    expect(content).not.toMatch(/https?:|caption|subscribe|image\.png|Duplicate title/i)
    expect(content.match(/Nested item/g)).toHaveLength(1)
  })

  it("regresses against the complete RSS body of a published Substack article", async () => {
    const contentHtml = await readFile("fixtures/substack-rss-content-encoded.html", "utf8")
    const article = parseSubstackArticle({
      title: "The Reps We Are Losing",
      subtitle: "How agentic coding can erode the learning loops that build senior engineers",
      sourceUrl: "https://satwikhebbar.substack.com/p/the-reps-we-are-losing",
      contentHtml,
    })

    expect(article.sections.map((section) => section.heading)).toEqual([
      null,
      "When Your Own Code Looks Foreign",
      "The Debt We Don’t See",
      "The Learning Loop We Broke",
      "Where The Reps Went",
      "The Black Box is Insufficient",
      "Make Understanding Part of “Done”",
      "Follow It Into Production",
      "Retain The Useful Friction",
      "Build Capability, Not Just Output",
    ])

    const content = article.sections.map((section) => section.content).join("\n\n")
    expect(content.length).toBeGreaterThan(11_000)
    expect(content).not.toMatch(/<[^>]+>|Understanding grows with each rep|Subscribe for free/i)
  })

  it.each([
    [{ ...input, title: " " }, "missing-title"],
    [{ ...input, contentHtml: " " }, "missing-content"],
    [{ ...input, contentHtml: "<figure><img src=x></figure>" }, "no-authored-prose"],
  ] as const)("rejects %s with a typed error", (invalid, reason) => {
    expect(() => parseSubstackArticle(invalid)).toThrow(SubstackArticleParseError)
    expect(() => parseSubstackArticle(invalid)).toThrow(reason)
  })
})
