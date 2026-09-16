import { parseHTML } from "linkedom/worker"

export interface SubstackArticleInput {
  title: string
  subtitle?: string
  sourceUrl: string
  contentHtml: string
}

export interface SubstackArticleSection {
  heading: string | null
  content: string
}

export interface SubstackArticle {
  title: string
  subtitle?: string
  sourceUrl: string
  sections: SubstackArticleSection[]
}

export class SubstackArticleParseError extends Error {
  constructor(public readonly reason: "missing-title" | "missing-content" | "no-authored-prose") {
    super(`Unable to parse Substack article: ${reason}`)
    this.name = "SubstackArticleParseError"
  }
}

const REMOVED_SELECTOR = [
  "img",
  "picture",
  "figure",
  "figcaption",
  "svg",
  "script",
  "style",
  "noscript",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "video",
  "audio",
  ".subscription-widget-wrap-editor",
  ".subscription-widget",
  ".subscribe-widget",
  ".paywall",
].join(", ")

const BLOCK_TAGS = new Set(["p", "blockquote", "pre", "h3", "h4", "h5", "h6"])
const LIST_TAGS = new Set(["ul", "ol"])
const ELEMENT_NODE = 1
const TEXT_NODE = 3
const DECIMAL_RADIX = 10
const HEXADECIMAL_RADIX = 16
const HEX_PREFIX_LENGTH = 1
const MAX_UNICODE_CODE_POINT = 0x10ffff
const DOCUMENT_OPENING_HTML = "<!doctype html><html><body>"
const DOCUMENT_CLOSING_HTML = "</body></html>"

type DomNode = {
  childNodes?: Iterable<unknown>
  nodeType?: number
  textContent?: string | null
  localName?: string | null
}

type DomElement = DomNode & {
  querySelectorAll?(selector: string): Iterable<DomElement>
  remove?(): void
}

type DomDocument = {
  body: DomNode
  querySelectorAll(selector: string): Iterable<DomElement>
}

type SectionDraft = { heading: string | null; blocks: string[] }

/** Normalizes HTML-decoded text into a single readable whitespace-separated string. */
function normalize(value: string | null | undefined): string {
  return decodeEntities(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Decodes common named and numeric HTML entities that may survive RSS parsing. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (entity, numeric, named) => {
    if (numeric) {
      const radix = numeric[0].toLowerCase() === "x" ? HEXADECIMAL_RADIX : DECIMAL_RADIX
      const codePoint = Number.parseInt(numeric.slice(radix === HEXADECIMAL_RADIX ? HEX_PREFIX_LENGTH : 0), radix)
      return Number.isSafeInteger(codePoint) && codePoint <= MAX_UNICODE_CODE_POINT
        ? String.fromCodePoint(codePoint)
        : entity
    }
    return (
      ({ amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' } as Record<string, string>)[
        named.toLowerCase()
      ] ?? entity
    )
  })
}

/** Returns an element's lowercase local name, or an empty string for non-elements. */
function elementName(node: { localName?: string | null }): string {
  return node.localName?.toLowerCase() ?? ""
}

/** Reads a list item's text while leaving nested list entries for separate traversal. */
function directText(node: { childNodes: Iterable<unknown> }): string {
  const parts: string[] = []
  for (const child of node.childNodes) {
    const candidate = child as {
      nodeType?: number
      data?: string
      childNodes?: Iterable<unknown>
      localName?: string | null
    }
    if (candidate.nodeType === TEXT_NODE) parts.push(candidate.data ?? "")
    else if (candidate.nodeType === ELEMENT_NODE && candidate.childNodes && !LIST_TAGS.has(elementName(candidate)))
      parts.push(directText(candidate as never))
  }
  return normalize(parts.join(" "))
}

/** Parses the RSS HTML as a document fragment with a body container. */
function parseArticleDocument(contentHtml: string): DomDocument {
  const { document } = parseHTML(`${DOCUMENT_OPENING_HTML}${contentHtml}${DOCUMENT_CLOSING_HTML}`)
  return document as unknown as DomDocument
}

/** Removes media and known Substack interface elements before authored-text extraction. */
function removeNoise(document: DomDocument): void {
  for (const node of document.querySelectorAll(REMOVED_SELECTOR)) node.remove?.()
}

/** Accumulates paragraphs into sections while preserving their source order. */
class SectionCollector {
  private readonly sections: SectionDraft[] = []
  private current: SectionDraft = { heading: null, blocks: [] }

  add(text: string): void {
    const normalized = normalize(text)
    if (normalized) this.current.blocks.push(normalized)
  }

  startSection(heading: string): void {
    if (this.current.blocks.length) this.sections.push(this.current)
    this.current = { heading, blocks: [] }
  }

  finish(): SubstackArticleSection[] {
    if (this.current.blocks.length) this.sections.push(this.current)
    return this.sections.map(({ heading, blocks }) => ({ heading, content: blocks.join("\n\n") }))
  }
}

/** Visits an element and projects its supported semantic content into the collector. */
function visitElement(element: DomElement, collector: SectionCollector): void {
  const tag = elementName(element)
  if (tag === "h1") return
  if (tag === "h2") {
    const heading = normalize(element.textContent)
    if (heading) collector.startSection(heading)
    return
  }
  if (BLOCK_TAGS.has(tag)) {
    collector.add(element.textContent ?? "")
    return
  }
  if (LIST_TAGS.has(tag)) {
    collectListItems(element, collector)
    return
  }
  if (tag === "table") {
    collectTableRows(element, collector)
    return
  }
  walkNodes(element, collector)
}

/** Walks semantic elements in source order, ignoring whitespace-only text nodes. */
function walkNodes(node: DomNode, collector: SectionCollector): void {
  for (const child of node.childNodes ?? []) {
    const element = child as DomElement
    if (element.nodeType === ELEMENT_NODE) visitElement(element, collector)
  }
}

/** Adds each list item once, then descends to preserve nested lists as separate bullets. */
function collectListItems(list: DomElement, collector: SectionCollector): void {
  for (const child of list.childNodes ?? []) {
    const item = child as DomElement
    if (item.nodeType !== ELEMENT_NODE || elementName(item) !== "li") continue
    collector.add(`• ${directText(item as never)}`)
    walkNodes(item, collector)
  }
}

/** Adds each table row as a pipe-separated line of readable cell text. */
function collectTableRows(table: DomElement, collector: SectionCollector): void {
  for (const row of table.querySelectorAll?.("tr") ?? []) {
    const cells = [...(row.querySelectorAll?.("th, td") ?? [])]
    collector.add(
      cells
        .map((cell) => normalize(cell.textContent))
        .filter(Boolean)
        .join(" | "),
    )
  }
}

/** Extracts authored prose into optional-introduction and H2-delimited sections. */
function extractSections(document: DomDocument): SubstackArticleSection[] {
  const collector = new SectionCollector()
  walkNodes(document.body, collector)
  return collector.finish()
}

/** Validates and normalizes the input fields required before HTML extraction begins. */
function validateInput(input: SubstackArticleInput): string {
  const title = normalize(input.title)
  if (!title) throw new SubstackArticleParseError("missing-title")
  if (!normalize(input.contentHtml)) throw new SubstackArticleParseError("missing-content")
  return title
}

/** Projects RSS article HTML into the small, authored-text-only model used by the later agent tool. */
export function parseSubstackArticle(input: SubstackArticleInput): SubstackArticle {
  const title = validateInput(input)
  const document = parseArticleDocument(input.contentHtml)
  removeNoise(document)
  const sections = extractSections(document)
  if (!sections.length) throw new SubstackArticleParseError("no-authored-prose")
  const subtitle = normalize(input.subtitle)
  return { title, ...(subtitle ? { subtitle } : {}), sourceUrl: input.sourceUrl, sections }
}
