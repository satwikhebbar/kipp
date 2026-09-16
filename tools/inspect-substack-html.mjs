import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const DEFAULT_FEED_URL = "https://satwikhebbar.substack.com/feed"
const DEFAULT_OUTPUT_DIRECTORY = "tmp/substack-html-inspection"

/** Reads a named command-line option and returns its following value. */
function option(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

/** Removes the CDATA wrapper from an RSS field when present. */
function unwrapCdata(value) {
  const match = value.trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)
  return match ? match[1] : value.trim()
}

/** Extracts the first matching RSS tag body from an item XML fragment. */
function itemField(itemXml, tag) {
  const match = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))
  return match ? unwrapCdata(match[1]) : ""
}

/** Normalizes a post URL enough to compare feed links with a supplied URL. */
function normalizedUrl(value) {
  const url = new URL(value)
  url.hash = ""
  url.search = ""
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.toString()
}

/** Finds one RSS item with a rich content:encoded field. */
function findItem(feedXml, requestedPostUrl) {
  const items = [...feedXml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const xml = match[1]
    return {
      title: itemField(xml, "title"),
      subtitle: itemField(xml, "subtitle") || itemField(xml, "itunes:subtitle") || itemField(xml, "description"),
      subtitleSource: itemField(xml, "subtitle") || itemField(xml, "itunes:subtitle") ? "explicit subtitle field" : "description",
      link: itemField(xml, "link"),
      contentHtml: itemField(xml, "content:encoded"),
    }
  })
  const candidates = items.filter((item) => item.link && item.contentHtml)
  if (!candidates.length) throw new Error("The feed did not contain an item with content:encoded HTML")
  if (!requestedPostUrl) return candidates[0]
  const wanted = normalizedUrl(requestedPostUrl)
  const item = candidates.find((candidate) => normalizedUrl(candidate.link) === wanted)
  if (!item) throw new Error(`No rich RSS item matched ${requestedPostUrl}`)
  return item
}

/** Derives the observed public Substack API endpoint from a canonical post URL. */
function apiUrlForPost(postUrl) {
  const url = new URL(postUrl)
  const match = url.pathname.match(/^\/p\/([^/]+)\/?$/)
  if (!match) throw new Error(`Expected a Substack post URL with a /p/{slug} path, received ${postUrl}`)
  return new URL(`/api/v1/posts/${encodeURIComponent(match[1])}`, url.origin).toString()
}

/** Returns lightweight block counts without modifying the captured HTML. */
function structureSummary(html) {
  const count = (tag) => (html.match(new RegExp(`<${tag}(?:\\s|>)`, "gi")) ?? []).length
  return {
    h1: count("h1"),
    h2: count("h2"),
    h3: count("h3"),
    paragraphs: count("p"),
    listItems: count("li"),
    blockQuotes: count("blockquote"),
    figures: count("figure"),
    captions: count("figcaption"),
    tables: count("table"),
  }
}

/** Ignores markup-only whitespace to distinguish formatting from structural differences. */
function normalizedHtml(html) {
  return html.replace(/>\s+</g, "><").trim()
}

/** Decodes the common entity forms Substack may serialize differently between transports. */
function decodeHtmlEntities(html) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: "\u00a0", quot: '"' }
  return html.replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi, (entity, numeric, name) => {
    if (numeric) {
      const value = Number.parseInt(numeric, numeric[0].toLowerCase() === "x" ? 16 : 10)
      const isValidCodePoint = value >= 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
      return isValidCodePoint ? String.fromCodePoint(value) : entity
    }
    return named[name.toLowerCase()] ?? entity
  })
}

/** Produces a short, safe context around the first character difference. */
function firstDifference(left, right) {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[index] === right[index]) index++
  if (index === length && left.length === right.length) return null
  const start = Math.max(0, index - 80)
  const end = index + 160
  return {
    index,
    rss: left.slice(start, end),
    api: right.slice(start, end),
  }
}

/** Fetches a public resource and returns its body after checking the response status. */
async function fetchText(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`)
  return response.text()
}

/** Captures one RSS body and its corresponding public API body for inspection. */
async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    console.log("Usage: node tools/inspect-substack-html.mjs [--post URL] [--feed URL] [--out DIRECTORY]")
    return
  }

  const feedUrl = option(args, "--feed") ?? DEFAULT_FEED_URL
  const requestedPostUrl = option(args, "--post")
  const outputDirectory = resolve(option(args, "--out") ?? DEFAULT_OUTPUT_DIRECTORY)
  const item = findItem(await fetchText(feedUrl), requestedPostUrl)
  const apiUrl = apiUrlForPost(item.link)
  const api = JSON.parse(await fetchText(apiUrl))
  if (typeof api.body_html !== "string" || !api.body_html.trim()) throw new Error(`API returned no body_html: ${apiUrl}`)

  await mkdir(outputDirectory, { recursive: true })
  const rssFile = resolve(outputDirectory, "rss-content-encoded.html")
  const apiFile = resolve(outputDirectory, "api-body-html.html")
  await Promise.all([writeFile(rssFile, item.contentHtml), writeFile(apiFile, api.body_html)])

  const exactMatch = item.contentHtml === api.body_html
  const normalizedMatch = normalizedHtml(item.contentHtml) === normalizedHtml(api.body_html)
  const entityNormalizedMatch = decodeHtmlEntities(normalizedHtml(item.contentHtml)) === decodeHtmlEntities(normalizedHtml(api.body_html))
  console.log(`Post: ${item.link}`)
  console.log(`API:  ${apiUrl}`)
  console.log(`RSS title: ${item.title || "(absent)"}`)
  console.log(`RSS subtitle (${item.subtitle ? item.subtitleSource : "absent"}): ${item.subtitle || "(absent)"}`)
  console.log(`API title: ${typeof api.title === "string" && api.title ? api.title : "(absent)"}`)
  console.log(`API subtitle: ${typeof api.subtitle === "string" && api.subtitle ? api.subtitle : "(absent)"}`)
  console.log(`RSS HTML: ${rssFile} (${item.contentHtml.length} characters)`)
  console.log(`API HTML: ${apiFile} (${api.body_html.length} characters)`)
  console.log(`Exact match: ${exactMatch ? "yes" : "no"}`)
  console.log(`Match ignoring markup-only whitespace: ${normalizedMatch ? "yes" : "no"}`)
  console.log(`Match also normalizing HTML entities: ${entityNormalizedMatch ? "yes" : "no"}`)
  console.log("RSS structure:", structureSummary(item.contentHtml))
  console.log("API structure:", structureSummary(api.body_html))
  if (!exactMatch && !entityNormalizedMatch)
    console.log("First normalized difference:", firstDifference(decodeHtmlEntities(normalizedHtml(item.contentHtml)), decodeHtmlEntities(normalizedHtml(api.body_html))))
}

await main()
