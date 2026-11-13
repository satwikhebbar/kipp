import type { InteractionRegistration, InteractionResolveInput } from "../core/interaction-router-client"
import { type NotesInteractionEvent, notesEventSchema } from "./types"

const DELIVERY_GRACE_MS = 3_600_000

export interface NotesActionMetadata {
  userId: string
  chatId: string
  fingerprint: string
}
interface ActionRow {
  registration_json: string
  consumed_delivery_id: string | null
}
interface DeliveryRow {
  envelope_json: string
  acknowledged_at: number | null
}

/** Notes-only durable transport; legacy interactions keep their existing consume/forward behavior. */
export class NotesRouter {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS notes_actions (
      interaction_id TEXT PRIMARY KEY, callback_token TEXT UNIQUE, workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL,
      registration_json TEXT NOT NULL, consumed_delivery_id TEXT)`)
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS notes_messages (message_id INTEGER PRIMARY KEY, interaction_id TEXT NOT NULL)`,
    )
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS notes_versions (workflow_id TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
    )
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS notes_deliveries (
      delivery_id TEXT PRIMARY KEY, telegram_update_id INTEGER NOT NULL UNIQUE,
      interaction_id TEXT NOT NULL, workflow_id TEXT NOT NULL, envelope_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL, acknowledged_at INTEGER)`)
    storage.sql.exec("CREATE INDEX IF NOT EXISTS notes_delivery_action ON notes_deliveries(interaction_id)")
  }

  register(registration: InteractionRegistration): Response {
    if (
      !registration.notes ||
      !registration.interactionId ||
      !registration.workflowId ||
      !Number.isInteger(registration.version) ||
      !Number.isFinite(registration.expiresAt) ||
      !registration.notes.userId ||
      !registration.notes.chatId ||
      !registration.notes.fingerprint
    )
      return new Response("Invalid Notes action", { status: 400 })
    this.cleanup()
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO notes_versions VALUES (?, ?)",
      registration.workflowId,
      registration.version,
    )
    this.storage.sql.exec(
      "UPDATE notes_versions SET version = MAX(version, ?) WHERE workflow_id = ?",
      registration.version,
      registration.workflowId,
    )
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO notes_actions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      registration.interactionId,
      registration.callbackToken ?? null,
      registration.workflowId,
      registration.version,
      registration.kind,
      registration.expiresAt,
      JSON.stringify(registration),
    )
    return Response.json({ ok: true })
  }

  /** Records the exact authenticated event and consumes its action in one synchronous SQLite transaction. */
  resolve(input: InteractionResolveInput & { userId: string; chatId: string; receivedAtMs: number }): Response {
    this.cleanup()
    if (
      !Number.isInteger(input.telegramUpdateId) ||
      !input.userId ||
      !input.chatId ||
      !Number.isFinite(input.receivedAtMs)
    )
      return new Response("Invalid Notes update", { status: 400 })
    const previous = this.storage.sql
      .exec("SELECT * FROM notes_deliveries WHERE telegram_update_id = ?", input.telegramUpdateId)
      .toArray()[0] as unknown as DeliveryRow | undefined
    if (previous) return this.delivery(previous, input)
    const row = (
      input.callbackToken
        ? this.storage.sql.exec("SELECT * FROM notes_actions WHERE callback_token = ?", input.callbackToken)
        : input.replyToMessageId !== undefined
          ? this.storage.sql.exec(
              "SELECT a.* FROM notes_actions a JOIN notes_messages m ON m.interaction_id = a.interaction_id WHERE m.message_id = ?",
              input.replyToMessageId,
            )
          : input.text !== undefined
            ? this.storage.sql.exec(
                "SELECT a.* FROM notes_actions a JOIN notes_versions v ON v.workflow_id = a.workflow_id WHERE a.kind = 'notes-feedback' AND a.consumed_delivery_id IS NULL AND a.version = v.version AND a.expires_at > ? ORDER BY a.rowid DESC LIMIT 1",
                Date.now(),
              )
            : null
    )?.toArray()[0] as ActionRow | undefined
    if (!row) return Response.json({ handled: false })
    const r = JSON.parse(row.registration_json) as InteractionRegistration
    if (r.notes?.userId !== input.userId || r.notes.chatId !== input.chatId)
      return Response.json({ handled: true, event: null })
    if (row.consumed_delivery_id) {
      const pending = this.storage.sql
        .exec("SELECT * FROM notes_deliveries WHERE delivery_id = ?", row.consumed_delivery_id)
        .toArray()[0] as unknown as DeliveryRow | undefined
      if (pending) return this.delivery(pending, input)
      return Response.json({ handled: true, event: null })
    }
    const version = this.storage.sql
      .exec("SELECT version FROM notes_versions WHERE workflow_id = ?", r.workflowId)
      .toArray()[0] as { version: number } | undefined
    if (r.expiresAt <= Date.now() || version?.version !== r.version)
      return Response.json({ handled: true, event: null })
    const event = notesEventSchema.parse({
      deliveryId: crypto.randomUUID(),
      workflowId: r.workflowId,
      interactionId: r.interactionId,
      version: r.version,
      kind: r.kind,
      fingerprint: r.notes.fingerprint,
      userId: input.userId,
      chatId: input.chatId,
      telegramUpdateId: input.telegramUpdateId,
      receivedAtMs: input.receivedAtMs,
      ...(input.text !== undefined ? { text: input.text, firstUrl: input.firstUrl ?? null } : {}),
    })
    // No asynchronous operation can interleave consumption and retention.
    this.storage.sql.exec(
      "INSERT INTO notes_deliveries VALUES (?, ?, ?, ?, ?, ?, NULL)",
      event.deliveryId,
      event.telegramUpdateId,
      event.interactionId,
      event.workflowId,
      JSON.stringify(event),
      r.expiresAt + DELIVERY_GRACE_MS,
    )
    this.storage.sql.exec(
      "UPDATE notes_actions SET consumed_delivery_id = ? WHERE interaction_id = ?",
      event.deliveryId,
      r.interactionId,
    )
    return Response.json({ handled: true, event })
  }

  private delivery(row: DeliveryRow, input: { userId: string; chatId: string }): Response {
    const event = JSON.parse(row.envelope_json) as NotesInteractionEvent
    if (event.userId !== input.userId || event.chatId !== input.chatId)
      return Response.json({ handled: true, event: null })
    return Response.json({ handled: true, event: row.acknowledged_at === null ? event : null })
  }

  control(path: string, body: Record<string, unknown>): Response {
    if (path === "/notes/ack") {
      this.storage.sql.exec(
        "UPDATE notes_deliveries SET acknowledged_at = ? WHERE delivery_id = ?",
        Date.now(),
        String(body.deliveryId),
      )
    } else if (path === "/notes/invalidate") {
      this.storage.sql.exec(
        "INSERT INTO notes_versions VALUES (?, ?) ON CONFLICT(workflow_id) DO UPDATE SET version = MAX(version, excluded.version)",
        String(body.workflowId),
        Number(body.version),
      )
    } else if (path === "/notes/bind") {
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO notes_messages VALUES (?, ?)",
        Number(body.messageId),
        String(body.interactionId),
      )
    } else return new Response("Not found", { status: 404 })
    return Response.json({ ok: true })
  }

  private cleanup(): void {
    this.storage.sql.exec(
      "DELETE FROM notes_messages WHERE interaction_id IN (SELECT interaction_id FROM notes_actions WHERE expires_at < ?)",
      Date.now() - DELIVERY_GRACE_MS,
    )
    this.storage.sql.exec("DELETE FROM notes_actions WHERE expires_at < ?", Date.now() - DELIVERY_GRACE_MS)
    this.storage.sql.exec("DELETE FROM notes_deliveries WHERE expires_at <= ?", Date.now())
    this.storage.sql.exec("DELETE FROM notes_versions WHERE workflow_id NOT IN (SELECT workflow_id FROM notes_actions)")
  }
}
