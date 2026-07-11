import type { GithubClient } from "../integrations/github"
import type { Idea } from "../types"
import { serializeIdea } from "./parser"

export async function appendToArchive(client: GithubClient, idea: Idea): Promise<void> {
  await client.mutateFile("archive.md", (content) => {
    if (content.includes(`id: ${idea.id}`)) return content
    const archived = { ...idea, status: "finalized" as const }
    return `${content.trim()}\n\n${serializeIdea(archived)}`
  })
}
