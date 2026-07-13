import type { GithubClient } from "../integrations/github"
import type { Idea } from "../types"
import { serializeIdea } from "./parser"

export async function appendToArchive(client: GithubClient, idea: Idea): Promise<void> {
  await client.mutateFile("archive.md", (content) => {
    const archived = { ...idea, status: "finalized" as const, finalized: new Date().toISOString() }
    return `${content.trim()}\n\n${serializeIdea(archived)}`
  })
}
