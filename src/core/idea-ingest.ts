import { createNotionClient } from "../integrations/notion"
import { createIdeaManager, type IdeaInput } from "../linkedin/ideas/manager"
import type { Env, Source } from "./types"

const RECORD_KEY = "record"

/** Minimum interval between restart() calls for a persistently errored workflow instance. */
export const WORKFLOW_REPAIR_COOLDOWN_MS = 3_600_000 // ponytail: 1 hour

const HEX_BYTE_LENGTH = 2
const INSTANCE_ID_HASH_CHARS = 32
const HEX_RADIX = 16

export interface IngestResult {
  pageId: string
  ideaId: string
  workflowInstanceId?: string
  alreadyStarted?: boolean
}

export interface StartResult {
  workflowInstanceId: string
  alreadyStarted: boolean
}

interface IngestRecord {
  key: string
  pageId: string
  ideaId: string
}

interface ClaimRecord {
  status: "unstarted" | "started"
  instanceId?: string
  lastRestartAt?: number
}

/**
 * Durable Object binding that owns idea creation and workflow starts.
 *
 * - `ingest:{key}` objects adopt-or-create the Notion page for an external
 *   idempotency key, persisting the key -> pageId mapping as the commit point.
 * - `claim:{pageId}` objects are the single ownership record for a page's
 *   workflow: a deterministic pageId-based instance id plus a crash-safe
 *   unstarted/started state machine with cooldown-bounded repair.
 */
export class IdeaIngestDO implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return new Response("invalid body", { status: 400 })
    }
    if (url.pathname === "/ingest") return this.ingest(body)
    if (url.pathname === "/start") return this.start(body)
    return new Response("Not found", { status: 404 })
  }

  private async ingest(body: Record<string, unknown>): Promise<Response> {
    const { key, idea, startWorkflow } = body as {
      key: string
      idea: IdeaInput
      startWorkflow?: boolean
    }
    if (!key || !idea?.body) return new Response("invalid ingest", { status: 400 })

    const manager = createIdeaManager(createNotionClient(this.env))
    // Serialize read-create-persist so concurrent ingest:{key} requests cannot
    // both see an empty record and create duplicate Notion pages. createIdea
    // awaits outbound Notion calls, which would otherwise open the input gate.
    const { pageId, ideaId } = await this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.ctx.storage.get<IngestRecord>(RECORD_KEY)
      if (record?.pageId && record.ideaId) return { pageId: record.pageId, ideaId: record.ideaId }
      const created = await manager.createIdea({ ...idea, idempotencyKey: key })
      await this.ctx.storage.put<IngestRecord>(RECORD_KEY, { key, pageId: created.pageId, ideaId: created.id })
      return { pageId: created.pageId, ideaId: created.id }
    })

    let workflowInstanceId: string | undefined
    let alreadyStarted: boolean | undefined
    if (startWorkflow) {
      const result = await this.delegateStart(pageId, ideaId, idea.source)
      workflowInstanceId = result.workflowInstanceId
      alreadyStarted = result.alreadyStarted
    }
    return Response.json({ pageId, ideaId, workflowInstanceId, alreadyStarted })
  }

  private async start(body: Record<string, unknown>): Promise<Response> {
    const { pageId, ideaId, source } = body as { pageId: string; ideaId: string; source: Source }
    if (!pageId || !ideaId) return new Response("invalid start", { status: 400 })

    const instanceId = await claimInstanceId(pageId)
    const record = await this.ctx.storage.get<ClaimRecord>(RECORD_KEY)

    if (!record || record.status === "unstarted") {
      const created = await this.env.PIPELINE_WORKFLOW.createBatch([
        { id: instanceId, params: { pageId, ideaId, source } },
      ])
      if (created.length > 0) {
        await this.ctx.storage.put<ClaimRecord>(RECORD_KEY, { status: "started", instanceId })
        return Response.json({ workflowInstanceId: instanceId, alreadyStarted: false })
      }
      const instance = await this.env.PIPELINE_WORKFLOW.get(instanceId)
      const status = await instance.status()
      if (status.status === "errored" || status.status === "terminated") {
        await instance.restart()
        await this.ctx.storage.put<ClaimRecord>(RECORD_KEY, {
          status: "started",
          instanceId,
          lastRestartAt: Date.now(),
        })
      } else {
        await this.ctx.storage.put<ClaimRecord>(RECORD_KEY, { status: "started", instanceId })
      }
      return Response.json({ workflowInstanceId: instanceId, alreadyStarted: true })
    }

    const instance = await this.env.PIPELINE_WORKFLOW.get(instanceId)
    const status = await instance.status()
    const now = Date.now()
    if (
      (status.status === "errored" || status.status === "terminated") &&
      now - (record.lastRestartAt ?? 0) > WORKFLOW_REPAIR_COOLDOWN_MS
    ) {
      await instance.restart()
      await this.ctx.storage.put<ClaimRecord>(RECORD_KEY, { ...record, lastRestartAt: now })
    }
    return Response.json({ workflowInstanceId: instanceId, alreadyStarted: true })
  }

  private async delegateStart(pageId: string, ideaId: string, source: Source): Promise<StartResult> {
    const id = this.env.IDEA_INGEST.idFromName(`claim:${pageId}`)
    const stub = this.env.IDEA_INGEST.get(id)
    // The DO stub.fetch URL host is unused; only the pathname routes inside the object.
    const res = await stub.fetch("http://ingest/start", {
      method: "POST",
      body: JSON.stringify({ pageId, ideaId, source }),
    })
    if (!res.ok) throw new Error(`IdeaIngest claim start failed (HTTP ${res.status})`)
    return (await res.json()) as StartResult
  }
}

/** Derives the deterministic Cloudflare Workflow instance id for a Notion page id. */
export async function claimInstanceId(pageId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pageId))
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_LENGTH, "0"),
  ).join("")
  return `kipp-${hex.slice(0, INSTANCE_ID_HASH_CHARS)}`
}

/** Creates the client for the IdeaIngest Durable Object namespace. */
export function createIdeaIngest(env: Env): {
  ingest(input: { key: string; idea: IdeaInput; startWorkflow?: boolean }): Promise<IngestResult>
  start(input: { pageId: string; ideaId: string; source: Source }): Promise<StartResult>
} {
  async function ingest(input: { key: string; idea: IdeaInput; startWorkflow?: boolean }): Promise<IngestResult> {
    const id = env.IDEA_INGEST.idFromName(`ingest:${input.key}`)
    const stub = env.IDEA_INGEST.get(id)
    // The DO stub.fetch URL host is unused; only the pathname routes inside the object.
    const res = await stub.fetch("http://ingest/ingest", {
      method: "POST",
      body: JSON.stringify(input),
    })
    if (!res.ok) throw new Error(`IdeaIngest ingest failed (HTTP ${res.status})`)
    return (await res.json()) as IngestResult
  }

  async function start(input: { pageId: string; ideaId: string; source: Source }): Promise<StartResult> {
    const id = env.IDEA_INGEST.idFromName(`claim:${input.pageId}`)
    const stub = env.IDEA_INGEST.get(id)
    const res = await stub.fetch("http://ingest/start", {
      method: "POST",
      body: JSON.stringify(input),
    })
    if (!res.ok) throw new Error(`IdeaIngest start failed (HTTP ${res.status})`)
    return (await res.json()) as StartResult
  }

  return { ingest, start }
}
