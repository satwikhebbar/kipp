import type { Idea, IdeaStatus, Source } from "../types"

const FM_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

type FM = Record<string, string | Record<string, string>>

function parseYaml(lines: string): FM {
  const fm: FM = {}
  let currentKey: string | null = null
  for (const line of lines.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const indent = line.match(/^(\s+)/)?.[1]?.length ?? 0
    if (indent === 0) {
      const m = trimmed.match(/^(\w+):\s*(.*)/)
      if (m) {
        currentKey = m[1]
        fm[currentKey] = m[2].replace(/^"(.*)"$/, "$1")
      }
    } else if (currentKey && typeof fm[currentKey] === "string") {
      const m = trimmed.match(/^(\w+):\s*(.*)/)
      if (m) {
        const inner: Record<string, string> = {}
        inner[m[1]] = m[2].replace(/^"(.*)"$/, "$1")
        fm[currentKey] = inner
      }
    } else if (currentKey && typeof fm[currentKey] === "object") {
      const m = trimmed.match(/^(\w+):\s*(.*)/)
      if (m) {
        ;(fm[currentKey] as Record<string, string>)[m[1]] = m[2].replace(/^"(.*)"$/, "$1")
      }
    }
  }
  return fm
}

function serializeYaml(fm: FM): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === "string") {
      lines.push(`${k}: ${v}`)
    } else if (v && typeof v === "object") {
      lines.push(`${k}:`)
      for (const [sk, sv] of Object.entries(v)) {
        lines.push(`  ${sk}: ${sv}`)
      }
    }
  }
  return lines.join("\n")
}

function extractSections(body: string): { preamble: string; draft?: string; critique?: string } {
  let draft: string | undefined
  let critique: string | undefined

  const cleaned = body.replace(/(?:^|\n)## (Draft|Critique)\n\n([\s\S]*?)(?=\n## |$)/g, (_, section, content) => {
    if (section === "Draft") draft = content.trim()
    if (section === "Critique") critique = content.trim()
    return ""
  })

  return { preamble: cleaned.trim(), draft, critique }
}

export function parseIdea(text: string): Idea {
  const m = text.match(FM_RE)
  if (!m) throw new Error("Missing frontmatter")
  const fm = parseYaml(m[1])
  const body = m[2].trim()

  const { preamble, draft, critique } = extractSections(body)

  const idea: Idea = {
    id: String(fm.id ?? ""),
    title: fm.title ? String(fm.title) : undefined,
    status: (fm.status as IdeaStatus) ?? "raw",
    created: String(fm.created ?? ""),
    source: (fm.source as Source) ?? "manual",
    body: preamble,
    draft,
    critique,
  }

  const c = fm.correlation as Record<string, string> | undefined
  if (c && Object.keys(c).length > 0) {
    idea.correlation = {
      telegramChatId: c.telegramChatId,
      botMessageId: c.botMessageId ? Number(c.botMessageId) : undefined,
      workflowInstanceId: c.workflowInstanceId,
      pendingRevision: c.pendingRevision,
    }
  }

  if (fm.substackUrl) idea.substackUrl = String(fm.substackUrl)
  if (fm.teaser) idea.teaser = String(fm.teaser)
  if (fm.reviewCount) idea.reviewCount = Number(fm.reviewCount)
  if (fm.finalized) idea.finalized = String(fm.finalized)

  return idea
}

function buildBody(idea: Idea): string {
  const parts = [idea.body]
  if (idea.draft) parts.push(`\n\n## Draft\n\n${idea.draft}`)
  if (idea.critique) parts.push(`\n\n## Critique\n\n${idea.critique}`)
  return parts.join("")
}

export function serializeIdea(idea: Idea): string {
  const fm: FM = {
    id: idea.id,
    status: idea.status,
    created: idea.created,
    source: idea.source,
  }
  if (idea.title) fm.title = idea.title
  if (idea.substackUrl) fm.substackUrl = idea.substackUrl
  if (idea.teaser) fm.teaser = idea.teaser
  if (idea.reviewCount) fm.reviewCount = String(idea.reviewCount)
  if (idea.finalized) fm.finalized = idea.finalized

  if (idea.correlation) {
    const c: Record<string, string> = {}
    if (idea.correlation.telegramChatId) c.telegramChatId = idea.correlation.telegramChatId
    if (idea.correlation.botMessageId) c.botMessageId = String(idea.correlation.botMessageId)
    if (idea.correlation.workflowInstanceId) c.workflowInstanceId = idea.correlation.workflowInstanceId
    if (idea.correlation.pendingRevision) c.pendingRevision = idea.correlation.pendingRevision
    if (Object.keys(c).length > 0) fm.correlation = c
  }

  return `---\n${serializeYaml(fm)}\n---\n\n${buildBody(idea)}\n`
}

export function parseIdeas(text: string): Idea[] {
  const ideas: Idea[] = []
  const lines = text.split("\n")
  let i = 0

  while (i < lines.length) {
    if (lines[i].trim() !== "---") {
      i++
      continue
    }
    const ideaStart = i

    i++ // past opening ---
    while (i < lines.length && lines[i].trim() !== "---") i++
    if (i >= lines.length) break
    i++ // past closing ---

    while (i < lines.length && lines[i].trim() !== "---") i++

    ideas.push(parseIdea(lines.slice(ideaStart, i).join("\n")))
  }

  return ideas
}

export function serializeIdeas(ideas: Idea[]): string {
  return ideas.map(serializeIdea).join("\n")
}
