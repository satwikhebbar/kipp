import { type Env, INTERACTION_KIND, type WorkflowInteraction, type WorkflowInteractionKind } from "./types"

interface Registration {
  interactionId: string
  version: number
  workflowId: string
  kind: WorkflowInteractionKind
  callbackToken?: string
  botMessageId?: number
  expiresAt: number
  interactionGroup?: string
}

interface ResolvedInteraction extends WorkflowInteraction {
  workflowId: string
}

type InteractionRow = {
  interaction_id: string
  version: number
  workflow_id: string
  kind: WorkflowInteractionKind
  expires_at: number
  consumed_update_id: number | null
}

export const CONSUMED_INTERACTION_RETENTION_MS = 3_600_000 // ponytail: 1 hour
const PLAIN_TEXT_INTERACTION_KINDS = [
  INTERACTION_KIND.REVISION_FEEDBACK,
  INTERACTION_KIND.CALENDAR_CLARIFICATION,
  INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
  INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
] as const

/** Returns a JSON response with the given status code. */
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

/**
 * Short-lived, per-chat routing index. The namespace derives one logical
 * object from each chat id; Cloudflare lazily creates or rehydrates it, rather
 * than allocating one for every workflow execution. It stores no message text.
 */
export class InteractionRouterDO implements DurableObject {
  private readonly ctx: DurableObjectState

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx
    // Safe on every cold start; the schema itself remains in this chat's SQLite storage.
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS interactions (
      interaction_id TEXT PRIMARY KEY, version INTEGER NOT NULL, workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL, callback_token TEXT UNIQUE, bot_message_id INTEGER,
      expires_at INTEGER NOT NULL, consumed_update_id INTEGER, consumed_at INTEGER, interaction_group TEXT
    )`)
    try {
      this.ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN interaction_group TEXT")
    } catch {
      // Existing Durable Object databases already have this optional column.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return new Response("invalid body", { status: 400 })
    }
    if (url.pathname === "/register") return this.register(body)
    if (url.pathname === "/resolve") return this.resolve(body)
    return new Response("Not found", { status: 404 })
  }

  private register(body: Record<string, unknown>): Response {
    const r = body as unknown as Registration
    if (!r.interactionId || !r.workflowId || !r.kind || !Number.isFinite(r.expiresAt))
      return new Response("invalid registration", { status: 400 })
    this.removeExpiredOrOldConsumedInteractions()
    if (r.kind === INTERACTION_KIND.REVISION_FEEDBACK) this.removeActiveRevisionFeedback()
    if (r.interactionGroup) this.removeOlderGroupInteractions(r.interactionGroup, r.version)
    this.saveRegistration(r)
    return json({ ok: true })
  }

  private saveRegistration(registration: Registration): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO interactions (interaction_id, version, workflow_id, kind, callback_token, bot_message_id, expires_at, consumed_update_id, interaction_group) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
      registration.interactionId,
      registration.version,
      registration.workflowId,
      registration.kind,
      registration.callbackToken ?? null,
      registration.botMessageId ?? null,
      registration.expiresAt,
      registration.interactionGroup ?? null,
    )
  }

  private removeExpiredOrOldConsumedInteractions(now = Date.now()): void {
    this.ctx.storage.sql.exec("DELETE FROM interactions WHERE expires_at <= ?", now)
    this.ctx.storage.sql.exec(
      "DELETE FROM interactions WHERE consumed_at IS NOT NULL AND consumed_at <= ?",
      now - CONSUMED_INTERACTION_RETENTION_MS,
    )
  }

  private removeActiveRevisionFeedback(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM interactions WHERE kind = ? AND consumed_update_id IS NULL",
      INTERACTION_KIND.REVISION_FEEDBACK,
    )
  }

  private removeOlderGroupInteractions(interactionGroup: string, version: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM interactions WHERE interaction_group = ? AND version < ? AND consumed_update_id IS NULL",
      interactionGroup,
      version,
    )
  }

  private findInteraction(input: { token?: string; replyTo?: number; plainText?: string }): InteractionRow | undefined {
    const rows = input.token
      ? this.ctx.storage.sql.exec("SELECT * FROM interactions WHERE callback_token = ?", input.token).toArray()
      : input.replyTo !== undefined
        ? this.ctx.storage.sql
            .exec(
              "SELECT * FROM interactions WHERE bot_message_id = ? ORDER BY CASE kind WHEN ? THEN 0 ELSE 1 END, rowid DESC LIMIT 1",
              input.replyTo,
              INTERACTION_KIND.REVISION_FEEDBACK,
            )
            .toArray()
        : input.plainText !== undefined
          ? this.ctx.storage.sql
              .exec(
                "SELECT * FROM interactions WHERE kind IN (?, ?, ?, ?) AND consumed_update_id IS NULL ORDER BY rowid DESC LIMIT 1",
                ...PLAIN_TEXT_INTERACTION_KINDS,
              )
              .toArray()
          : []
    return rows[0] as InteractionRow | undefined
  }

  private claimInteraction(interactionId: string, telegramUpdateId: number, now = Date.now()): void {
    this.ctx.storage.sql.exec(
      "UPDATE interactions SET consumed_update_id = ?, consumed_at = ? WHERE interaction_id = ?",
      telegramUpdateId,
      now,
      interactionId,
    )
  }

  private resolve(body: Record<string, unknown>): Response {
    const updateId = body.telegramUpdateId
    if (!Number.isInteger(updateId)) return new Response("invalid update", { status: 400 })
    const numericUpdateId = updateId as number
    const token = typeof body.callbackToken === "string" ? body.callbackToken : undefined
    const replyTo = typeof body.replyToMessageId === "number" ? body.replyToMessageId : undefined
    const plainText = typeof body.text === "string" ? body.text : undefined
    this.removeExpiredOrOldConsumedInteractions()
    const row = this.findInteraction({ token, replyTo, plainText })
    if (!row || row.expires_at <= Date.now()) return json({ interaction: null })
    if (row.consumed_update_id !== null) return json({ interaction: null })
    this.claimInteraction(row.interaction_id, numericUpdateId)
    const interaction: ResolvedInteraction = {
      interactionId: row.interaction_id,
      version: row.version,
      workflowId: row.workflow_id,
      kind: row.kind,
      telegramUpdateId: numericUpdateId,
      ...(plainText !== undefined ? { text: plainText } : {}),
    }
    return json({ interaction })
  }
}
