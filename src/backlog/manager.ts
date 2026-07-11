import type { GithubClient } from "../integrations/github"
import type { Idea, IdeaStatus } from "../types"
import { appendToArchive } from "./archive"
import { parseIdeas, serializeIdeas } from "./parser"

export function createBacklogManager(client: GithubClient) {
  async function readIdeas(): Promise<Idea[]> {
    const file = await client.readFile("ideas.md")
    return parseIdeas(file.content)
  }

  async function writeIdeas(ideas: Idea[]): Promise<void> {
    const content = serializeIdeas(ideas)
    await client.mutateFile("ideas.md", () => content)
  }

  async function getNextIdea(): Promise<Idea | null> {
    const ideas = await readIdeas()
    const raw = ideas.filter((i) => i.status === "raw")
    if (raw.length === 0) return null
    return raw.sort((a, b) => Number(a.id) - Number(b.id))[0]
  }

  async function getIdeasByStatus(status: IdeaStatus): Promise<Idea[]> {
    const ideas = await readIdeas()
    return ideas.filter((i) => i.status === status)
  }

  async function updateIdea(ideaId: string, update: Partial<Idea>): Promise<void> {
    await client.mutateFile("ideas.md", (content) => {
      const ideas = parseIdeas(content)
      const idx = ideas.findIndex((i) => i.id === ideaId)
      if (idx === -1) throw new Error(`Idea ${ideaId} not found`)
      ideas[idx] = { ...ideas[idx], ...update }
      return serializeIdeas(ideas)
    })
  }

  async function moveToArchive(idea: Idea): Promise<void> {
    try {
      await updateIdea(idea.id, { status: "finalized" })
    } catch {
      // ponytail: already removed, proceed with archive append
    }
    await appendToArchive(client, idea)
    await client.mutateFile("ideas.md", (content) => {
      const ideas = parseIdeas(content)
      return serializeIdeas(ideas.filter((i) => i.id !== idea.id))
    })
  }

  return { getNextIdea, getIdeasByStatus, updateIdea, moveToArchive, readIdeas, writeIdeas }
}
