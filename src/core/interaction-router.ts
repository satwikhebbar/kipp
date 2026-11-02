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
  /** Chat-scoped plan-message generation (§6); carries group invalidation when present. */
  generation?: number
  edit?: { sessionId?: string }
}

interface ResolvedInteraction extends WorkflowInteraction {
  workflowId: string
  edit?: { sessionId?: string }
}

type InteractionRow = {
  interaction_id: string
  version: number
  workflow_id: string
  kind: WorkflowInteractionKind
  expires_at: number
  consumed_update_id: number | null
  interaction_group: string | null
  generation: number | null
  edit_json?: string | null
}

export const CONSUMED_INTERACTION_RETENTION_MS = 3_600_000 // ponytail: 1 hour
const PLAIN_TEXT_INTERACTION_KINDS = [
  INTERACTION_KIND.REVISION_FEEDBACK,
  INTERACTION_KIND.CALENDAR_CLARIFICATION,
  INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
  INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME,
  INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
  INTERACTION_KIND.MEAL_CLARIFICATION,
  INTERACTION_KIND.MEAL_FEEDBACK_REPLY,
] as const

/** Returns a JSON response with the given status code. */
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

/**
 * Short-lived, per-chat routing index. The namespace derives one logical
 * object from each chat id; Cloudflare lazily creates or rehydrates it. Pending
 * waits retain routing metadata; completed calendar writes also retain bounded
 * edit context and transcripts until their edit authority expires.
 */
export class InteractionRouterDO implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
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
    try {
      this.ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN generation INTEGER")
    } catch {
      // Existing Durable Object databases already have this optional column.
    }
    try {
      this.ctx.storage.sql.exec("ALTER TABLE interactions ADD COLUMN edit_json TEXT")
    } catch {
      // Existing objects already have this column.
    }
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS edit_contexts (
      session_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, context_json TEXT NOT NULL, active INTEGER NOT NULL
    )`)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS edit_locks (
      resource_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, domain TEXT NOT NULL
    )`)
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
    if (url.pathname === "/edit-context") return this.saveEditContext(body)
    if (url.pathname === "/edit-context/get") return this.getEditContext(body)
    if (url.pathname === "/edit/claim") return this.claimEdit(body)
    if (url.pathname === "/edit/release") {
      this.ctx.storage.sql.exec(
        "DELETE FROM edit_locks WHERE resource_id = ? AND workflow_id = ?",
        String(body.resourceId),
        String(body.workflowId),
      )
      return json({ ok: true })
    }
    if (url.pathname === "/register") return this.register(body)
    if (url.pathname === "/resolve") return this.resolve(body)
    return new Response("Not found", { status: 404 })
  }

  /** Stores bounded edit authority separately from the completed generation run. */
  private saveEditContext(body: Record<string, unknown>): Response {
    const { sessionId, resourceId, userId, expiresAt, context } = body
    if (
      typeof sessionId !== "string" ||
      typeof resourceId !== "string" ||
      typeof userId !== "string" ||
      !Number.isFinite(expiresAt)
    )
      return new Response("invalid context", { status: 400 })
    // A replay of an older registration must never reactivate an obsolete baseline.
    const existing = this.ctx.storage.sql
      .exec("SELECT session_id FROM edit_contexts WHERE session_id = ?", sessionId)
      .toArray()
    if (existing.length || Number(expiresAt) <= Date.now()) return json({ ok: true })
    this.ctx.storage.sql.exec("UPDATE edit_contexts SET active = 0 WHERE resource_id = ?", resourceId)
    this.ctx.storage.sql.exec(
      "INSERT INTO edit_contexts VALUES (?, ?, ?, ?, ?, 1)",
      sessionId,
      resourceId,
      userId,
      Number(expiresAt),
      JSON.stringify(context),
    )
    this.ctx.storage.sql.exec(
      "DELETE FROM edit_contexts WHERE expires_at < ?",
      Date.now() - CONSUMED_INTERACTION_RETENTION_MS,
    )
    return json({ ok: true })
  }

  /** Returns only the current, unexpired baseline owned by this user and chat. */
  private getEditContext(body: Record<string, unknown>): Response {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT context_json, resource_id, expires_at FROM edit_contexts WHERE session_id = ? AND user_id = ? AND active = 1 AND expires_at > ?",
        String(body.sessionId),
        String(body.userId),
        Date.now(),
      )
      .toArray()[0] as { context_json: string; resource_id: string; expires_at: number } | undefined
    return json(
      row
        ? { context: JSON.parse(row.context_json), resourceId: row.resource_id, expiresAt: row.expires_at }
        : { context: null },
    )
  }

  /** Serializes edits to a resource; a terminal workflow cannot leave a permanent lock. */
  private async claimEdit(body: Record<string, unknown>): Promise<Response> {
    const resourceId = String(body.resourceId)
    const workflowId = String(body.workflowId)
    const domain = body.domain
    if (domain !== "calendar" && domain !== "meal") return new Response("invalid domain", { status: 400 })
    const current = this.ctx.storage.sql
      .exec("SELECT workflow_id, domain FROM edit_locks WHERE resource_id = ?", resourceId)
      .toArray()[0] as { workflow_id: string; domain: string } | undefined
    if (current && current.workflow_id !== workflowId) {
      const binding = current.domain === "calendar" ? this.env.CALENDAR_WORKFLOW : this.env.MEAL_PLANNING_WORKFLOW
      if (!binding) return json({ ok: false })
      try {
        const status = await (await binding.get(current.workflow_id)).status()
        if (!["complete", "errored", "terminated"].includes(status.status)) return json({ ok: false })
      } catch {
        return json({ ok: false })
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM edit_locks WHERE resource_id = ? AND workflow_id = ?",
        resourceId,
        current.workflow_id,
      )
    }
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO edit_locks VALUES (?, ?, ?)", resourceId, workflowId, domain)
    const owner = this.ctx.storage.sql
      .exec("SELECT workflow_id FROM edit_locks WHERE resource_id = ?", resourceId)
      .toArray()[0] as { workflow_id: string } | undefined
    return json({ ok: owner?.workflow_id === workflowId })
  }

  private register(body: Record<string, unknown>): Response {
    const r = body as unknown as Registration
    if (!r.interactionId || !r.workflowId || !r.kind || !Number.isFinite(r.expiresAt))
      return new Response("invalid registration", { status: 400 })
    this.removeExpiredOrOldConsumedInteractions()
    if (r.kind === INTERACTION_KIND.REVISION_FEEDBACK) this.removeActiveRevisionFeedback()
    if (r.interactionGroup) {
      if (r.generation !== undefined) {
        this.removeOlderGroupInteractionsByGeneration(r.interactionGroup, r.generation)
      } else {
        this.removeOlderGroupInteractions(r.interactionGroup, r.version)
      }
    }
    this.saveRegistration(r)
    return json({ ok: true })
  }

  private saveRegistration(registration: Registration): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO interactions (interaction_id, version, workflow_id, kind, callback_token, bot_message_id, expires_at, consumed_update_id, interaction_group, generation, edit_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      registration.interactionId,
      registration.version,
      registration.workflowId,
      registration.kind,
      registration.callbackToken ?? null,
      registration.botMessageId ?? null,
      registration.expiresAt,
      registration.interactionGroup ?? null,
      registration.generation ?? null,
      registration.edit ? JSON.stringify(registration.edit) : null,
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

  /** Deletes a group's unconsumed rows below the given plan-message generation (§6). */
  private removeOlderGroupInteractionsByGeneration(interactionGroup: string, generation: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM interactions WHERE interaction_group = ? AND generation < ? AND consumed_update_id IS NULL",
      interactionGroup,
      generation,
    )
  }

  /** True when the row's plan-message generation is below the group's highest present generation (§6). */
  private isGenerationInvalidated(row: InteractionRow): boolean {
    if (row.generation === null || row.interaction_group === null) return false
    const result = this.ctx.storage.sql
      .exec(
        "SELECT MAX(generation) AS max_generation FROM interactions WHERE interaction_group = ? AND generation IS NOT NULL",
        row.interaction_group,
      )
      .toArray()[0] as { max_generation: number | null } | undefined
    const max = result?.max_generation ?? null
    return max !== null && max > row.generation
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
                `SELECT * FROM interactions WHERE kind IN (${PLAIN_TEXT_INTERACTION_KINDS.map(() => "?").join(", ")}) AND (consumed_update_id IS NULL OR edit_json IS NOT NULL) ORDER BY rowid DESC LIMIT 1`,
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
    const row = this.findInteraction({ token, replyTo, plainText })
    this.removeExpiredOrOldConsumedInteractions()
    if (!row) return json({ interaction: null })
    if (row.expires_at <= Date.now()) return json({ interaction: null, reason: "expired" })
    if (row.consumed_update_id !== null && !row.edit_json) return json({ interaction: null })
    if (this.isGenerationInvalidated(row)) return json({ interaction: null, reason: "stale" })
    this.claimInteraction(row.interaction_id, numericUpdateId)
    const interaction: ResolvedInteraction = {
      interactionId: row.interaction_id,
      version: row.version,
      workflowId: row.workflow_id,
      kind: row.kind,
      telegramUpdateId: numericUpdateId,
      ...(row.edit_json ? { edit: JSON.parse(row.edit_json) as { sessionId?: string } } : {}),
      ...(plainText !== undefined ? { text: plainText } : {}),
    }
    return json({ interaction })
  }
}
