import type { Env } from "../core/types"
import { createGitHubClient } from "../integrations/github"
import { parseIdeas } from "../linkedin/backlog/parser"

/** Checks posting cadence and starts a workflow if enough time has passed since the last publish. */
export async function handleCadenceCron(env: Env): Promise<{ started: boolean; ideaId?: string }> {
  const client = createGitHubClient(env)

  const { content: ideasContent } = await client.readFile("ideas.md")
  const ideas = parseIdeas(ideasContent)

  const inFlight = ideas.some((i) => i.status === "awaiting-feedback" || i.status === "awaiting-feedback-expired")
  if (inFlight) return { started: false }

  const { content: archiveContent } = await client.readFile("archive.md")
  const archived = parseIdeas(archiveContent)
  let latestFinalized = 0
  for (const a of archived) {
    const t = new Date(a.finalized ?? a.created).getTime()
    if (t > latestFinalized) latestFinalized = t
  }

  const MS_PER_DAY = 86_400_000
  const DEFAULT_POSTING_CADENCE_DAYS = 7
  const cadenceDays = Number(env.POSTING_CADENCE_DAYS) || DEFAULT_POSTING_CADENCE_DAYS
  const cutoff = Date.now() - cadenceDays * MS_PER_DAY
  if (latestFinalized > cutoff) return { started: false }

  const raw = ideas.filter((i) => i.status === "raw").sort((a, b) => Number(a.id) - Number(b.id))
  if (raw.length === 0) return { started: false }

  const idea = raw[0]
  const instance = await env.PIPELINE_WORKFLOW.create({
    params: { ideaId: idea.id, ideaTitle: idea.title, ideaBody: idea.body },
  })

  return { started: true, ideaId: instance.id }
}
