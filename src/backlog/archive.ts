import type { GithubClient } from "../integrations/github"
import type { Idea } from "../types"

export async function appendToArchive(client: GithubClient, idea: Idea): Promise<void> {
  await client.mutateFile("archive.md", (content) => {
    if (content.includes(`id: ${idea.id}`)) return content
    return `${content.trim()}\n\n---\nid: ${idea.id}\nstatus: finalized\n---\n\n${idea.body}\n`
  })
}
