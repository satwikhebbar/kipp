/** Telegram entity offsets count UTF-16 code units, matching JavaScript string slices. */
export interface NoteLinkEntity {
  type: string
  offset: number
  length: number
  url?: string
}

/** Accepts only absolute HTTP(S) card destinations without changing their query or fragment. */
export function validNoteUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\//iu.test(value) || /\s/u.test(value)) return false
  try {
    const url = new URL(value)
    return Boolean(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

/** Picks the first link in the original message; masked labels never become destinations. */
export function firstNoteUrl(text: string, entities: NoteLinkEntity[] = []): string | null {
  const spans = entities.filter(
    (e) =>
      ["url", "text_link"].includes(e.type) &&
      Number.isInteger(e.offset) &&
      Number.isInteger(e.length) &&
      e.offset >= 0 &&
      e.length > 0 &&
      e.offset + e.length <= text.length,
  )
  const links: Array<{ offset: number; url: string }> = []
  for (const entity of spans) {
    const url = entity.type === "text_link" ? entity.url : text.slice(entity.offset, entity.offset + entity.length)
    if (validNoteUrl(url)) links.push({ offset: entity.offset, url })
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>]+/giu)) {
    if (spans.some((e) => match.index < e.offset + e.length && match.index + match[0].length > e.offset)) continue
    let url = match[0].replace(/[.,!?:;]+$/u, "")
    // Preserve balanced parentheses in destinations, excluding surrounding prose punctuation.
    while (url.endsWith(")") && (url.match(/\)/gu)?.length ?? 0) > (url.match(/\(/gu)?.length ?? 0))
      url = url.slice(0, -1)
    if (validNoteUrl(url)) links.push({ offset: match.index, url })
  }
  links.sort((a, b) => a.offset - b.offset)
  return links[0]?.url ?? null
}
