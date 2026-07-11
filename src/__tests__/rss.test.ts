import { describe, expect, it } from "vitest"
import { parseRssFeed } from "../triggers/rss"

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Test Newsletter</title>
  <item>
    <title><![CDATA[First Post]]></title>
    <link>https://test.substack.com/p/first</link>
    <guid>first-guid</guid>
    <pubDate>Mon, 10 Jul 2026 09:00:00 GMT</pubDate>
    <description>A plain description</description>
  </item>
  <item>
    <title><![CDATA[Second Post with Content]]></title>
    <link>https://test.substack.com/p/second</link>
    <guid>second-guid</guid>
    <pubDate>Tue, 11 Jul 2026 09:00:00 GMT</pubDate>
    <content:encoded><![CDATA[<p>Detailed article content here</p>]]></content:encoded>
  </item>
</channel>
</rss>`

describe("parseRssFeed", () => {
  it("extracts items from RSS XML", () => {
    const items = parseRssFeed(SAMPLE_RSS)
    expect(items).toHaveLength(2)
  })

  it("parses item fields correctly", () => {
    const [first] = parseRssFeed(SAMPLE_RSS)
    expect(first.title).toBe("First Post")
    expect(first.link).toBe("https://test.substack.com/p/first")
    expect(first.guid).toBe("first-guid")
    expect(first.pubDate).toContain("2026")
  })

  it("prefers content:encoded over description", () => {
    const items = parseRssFeed(SAMPLE_RSS)
    expect(items[1].contentHtml).toBe("<p>Detailed article content here</p>")
  })

  it("falls back to description when content:encoded is missing", () => {
    const items = parseRssFeed(SAMPLE_RSS)
    expect(items[0].contentHtml).toBe("A plain description")
  })

  it("returns empty array for feed with no items", () => {
    const empty = parseRssFeed("<rss><channel><title>Empty</title></channel></rss>")
    expect(empty).toHaveLength(0)
  })
})
