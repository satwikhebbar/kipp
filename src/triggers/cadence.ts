import { createIdeaIngest } from "../core/idea-ingest"
import type { Env } from "../core/types"
import { createNotionClient } from "../integrations/notion"
import { createIdeaManager } from "../linkedin/ideas/manager"

const MS_PER_DAY = 86_400_000
const DEFAULT_POSTING_CADENCE_DAYS = 7

/** Checks posting cadence and starts a workflow if enough time has passed since the last publish. */
export async function handleCadenceCron(env: Env): Promise<{
  started: boolean
  ideaId?: string
  workflowInstanceId?: string
}> {
  const manager = createIdeaManager(createNotionClient(env))
  const ingest = createIdeaIngest(env)

  const awaiting = await manager.getIdeasByStatuses(["awaiting-feedback", "awaiting-feedback-expired"])
  if (awaiting.length > 0) return { started: false }

  const latestFinalized = await manager.getLatestFinalizedTimestamp()
  const cadenceDays = Number(env.POSTING_CADENCE_DAYS) || DEFAULT_POSTING_CADENCE_DAYS
  const cutoff = Date.now() - cadenceDays * MS_PER_DAY
  if (latestFinalized > cutoff) return { started: false }

  const [idea] = await manager.getIdeasByStatuses(["raw"])
  if (!idea) return { started: false }

  const result = await ingest.start({ pageId: idea.pageId, ideaId: idea.id, source: idea.source })
  return { started: true, ideaId: idea.id, workflowInstanceId: result.workflowInstanceId }
}
