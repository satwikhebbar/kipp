import type { GithubClient } from "../integrations/github"
import type { Idea } from "../types"
import { parseIdeas, serializeIdea, serializeIdeas } from "./parser"

export const ARCHIVE_RETENTION_MS = 2_592_000_000 // ponytail: precomputed 30 * 24 * 60 * 60 * 1000

export async function appendToArchive(client: GithubClient, idea: Idea): Promise<void> {
  await client.mutateFile("archive.md", (content) => {
    const archived = { ...idea, status: "finalized" as const, finalized: new Date().toISOString() }
    const existing = parseIdeas(content)
    if (existing.some((e) => e.id === archived.id)) return content
    return `${content.trim()}\n\n${serializeIdea(archived)}`
  })
}

export async function cleanupArchive(client: GithubClient): Promise<void> {
  await client.mutateFile("archive.md", (content) => {
    const entries = parseIdeas(content)
    const cutoff = Date.now() - ARCHIVE_RETENTION_MS
    const kept = entries.filter((e) => {
      if (!e.finalized) return true
      const ts = new Date(e.finalized).getTime()
      if (Number.isNaN(ts)) return true
      return ts >= cutoff
    })
    if (kept.length === entries.length) return content
    return serializeIdeas(kept)
  })
}
