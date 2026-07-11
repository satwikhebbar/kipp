import type { GithubClient } from "../integrations/github"
import type { Idea } from "../types"
import { parseIdeas, serializeIdea } from "./parser"

export async function appendToArchive(client: GithubClient, idea: Idea): Promise<void> {
  await client.mutateFile("archive.md", (content) => {
    if (parseIdeas(content).some((e) => e.id === idea.id)) return content
    const archived = { ...idea, status: "finalized" as const }
    return `${content.trim()}\n\n${serializeIdea(archived)}`
  })
}
