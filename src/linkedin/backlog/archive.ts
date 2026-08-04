import type { Idea } from "../../core/types"
import type { GithubClient } from "../../integrations/github"
import { parseIdeas, serializeIdea, serializeIdeas } from "./parser"

export const ARCHIVE_RETENTION_MS = 2_592_000_000 // ponytail: precomputed 30 * 24 * 60 * 60 * 1000

/** Archives a finalized idea to the archive file. */
export async function appendToArchive(client: GithubClient, idea: Idea): Promise<void> {
  await client.mutateFile("archive.md", (content) => {
    const archived = { ...idea, status: "finalized" as const, finalized: new Date().toISOString() }
    const existing = parseIdeas(content)
    if (existing.some((e) => e.id === archived.id)) return content
    return `${content.trim()}\n\n${serializeIdea(archived)}`
  })
}

/** Removes archived entries older than the retention period. */
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
