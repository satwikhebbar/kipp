import { createTokenVault } from "../../core/token-vault-client"
import type { Env } from "../../core/types"
import { fingerprintCommand } from "../../notes/review"
import { type ApprovedPublication, approvedPublicationSchema, type BufferCreateResult } from "../../notes/types"
import { createBufferPostOnce, discoverBufferDestination, inspectBufferPost } from "./client"

interface PublicationRecord {
  approved: ApprovedPublication
  phase: "prepared" | "dispatching" | "finished"
  attemptId?: string
  result?: BufferCreateResult
  reconciliationAttempted?: boolean
}

/** Owns one immutable approved publication and the sole permission to dispatch its create. */
export class BufferPublicationDO implements DurableObject {
  private live: Promise<BufferCreateResult> | null = null
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication (
      id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL)`)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS attempts (
      attempt_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, state TEXT NOT NULL,
      started_at INTEGER NOT NULL, result_json TEXT)`)
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    try {
      const body = (await request.json()) as { op: string; approved?: unknown; fingerprint?: string }
      if (body.op === "prepare") {
        const parsed = approvedPublicationSchema.safeParse(body.approved)
        if (!parsed.success) return new Response("Invalid approval", { status: 400 })
        const approved = parsed.data
        if (
          approved.fingerprint !== (await fingerprintCommand(approved.command)) ||
          approved.publicationId !== `${approved.workflowId}:v${approved.candidateVersion}` ||
          approved.approval.approvedAtMs >= approved.deadlineMs ||
          approved.approval.approvedAtMs > Date.now()
        )
          return new Response("Invalid approval", { status: 400 })
        const existing = this.read()
        if (existing && JSON.stringify(existing.approved) !== JSON.stringify(approved))
          return new Response("Immutable publication", { status: 409 })
        if (!existing) this.save({ approved, phase: "prepared" })
        await this.ctx.storage.sync()
        return Response.json({ ok: true })
      }
      const record = this.read()
      if (!record || record.approved.fingerprint !== body.fingerprint)
        return new Response("Publication mismatch", { status: 409 })
      if (body.op === "inspect") return Response.json(record.result ?? { kind: "unknown", reason: record.phase })
      if (body.op !== "submit") return new Response("Not found", { status: 404 })
      if (!this.live) {
        this.live = this.submit()
        const pending = this.live
        void pending
          .finally(() => {
            if (this.live === pending) this.live = null
          })
          .catch(() => {})
      }
      return Response.json(await this.live)
    } catch {
      // Storage failure leaves dispatch evidence intact. Never expose provider errors or approved text.
      return Response.json({ kind: "unknown", reason: "publication-storage-unavailable" }, { status: 503 })
    }
  }

  private read(): PublicationRecord | undefined {
    const row = this.ctx.storage.sql.exec("SELECT record_json FROM publication WHERE id = 1").toArray()[0] as
      | { record_json: string }
      | undefined
    return row ? (JSON.parse(row.record_json) as PublicationRecord) : undefined
  }

  private save(record: PublicationRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO publication VALUES (1, 1, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET revision = revision + 1, record_json = excluded.record_json`,
      record.approved.fingerprint,
      JSON.stringify(record),
    )
  }

  private async finish(record: PublicationRecord, result: BufferCreateResult): Promise<BufferCreateResult> {
    this.ctx.storage.transactionSync(() => {
      this.save({ ...record, phase: "finished", result })
      if (record.attemptId)
        this.ctx.storage.sql.exec(
          "UPDATE attempts SET state = ?, result_json = ? WHERE attempt_id = ?",
          result.kind,
          JSON.stringify(result),
          record.attemptId,
        )
    })
    await this.ctx.storage.sync()
    return result
  }

  private async submit(): Promise<BufferCreateResult> {
    const record = this.read()
    if (!record) return { kind: "unknown", reason: "missing-publication" }
    if (record.result) {
      if (record.result.kind === "unknown" && record.result.postId && !record.reconciliationAttempted)
        return this.reconcile(record, record.result.postId)
      return record.result
    }
    if (record.phase !== "prepared") return { kind: "unknown", reason: "dispatch-already-claimed" }
    const { approved } = record
    const reject = (reason: string, repair: "reauthorize" | "configuration" | "none") =>
      this.finish(record, { kind: "rejected", reason, repair })
    if (Date.now() >= approved.deadlineMs) return reject("review-expired", "none")
    let access: Awaited<ReturnType<ReturnType<typeof createTokenVault>["acquireBufferAccess"]>>
    try {
      access = await createTokenVault(this.env).acquireBufferAccess()
    } catch {
      return reject("credentials-unavailable", "reauthorize")
    }
    if (access.kind !== "usable") return reject("reauthorization-required", "reauthorize")
    const destination = approved.command.destination
    if (
      access.accountId !== destination.accountId ||
      access.connectionId !== destination.connectionId ||
      this.env.BUFFER_SUBSTACK_CHANNEL_ID !== destination.channelId
    )
      return reject("destination-changed", "configuration")
    try {
      const current = await discoverBufferDestination(access.accessToken, access.connectionId, destination.channelId)
      if (JSON.stringify(current) !== JSON.stringify(destination)) return reject("destination-changed", "configuration")
    } catch {
      return reject("destination-unavailable", "configuration")
    }
    if (Date.now() >= approved.deadlineMs) return reject("review-expired", "none")
    // No await between the final phase check and transactional claim.
    const latest = this.read()
    if (!latest) return { kind: "unknown", reason: "missing-publication" }
    if (latest.phase !== "prepared") return latest.result ?? { kind: "unknown", reason: "dispatch-already-claimed" }
    record.phase = "dispatching"
    const attemptId = crypto.randomUUID()
    record.attemptId = attemptId
    this.ctx.storage.transactionSync(() => {
      this.save(record)
      this.ctx.storage.sql.exec("INSERT INTO attempts VALUES (?, 1, 'dispatching', ?, NULL)", attemptId, Date.now())
    })
    // Explicitly persist the claim before the network create. No lease can release it.
    await this.ctx.storage.sync()
    if (Date.now() >= approved.deadlineMs) return reject("review-expired", "none")
    const result = await createBufferPostOnce(access.accessToken, approved.command)
    // Preserve observed ID/result before any reconciliation or Workflow checkpoint.
    if (result.kind === "unknown" && result.postId) {
      await this.finish(record, result)
      return this.reconcile({ ...record, phase: "finished", result }, result.postId)
    }
    return this.finish(record, result)
  }

  private async reconcile(record: PublicationRecord, postId: string): Promise<BufferCreateResult> {
    // Claim the sole lookup before I/O; interruption cannot turn it into a poll loop.
    record.reconciliationAttempted = true
    this.save(record)
    await this.ctx.storage.sync()
    try {
      const access = await createTokenVault(this.env).acquireBufferAccess()
      if (
        access.kind === "usable" &&
        access.accountId === record.approved.command.destination.accountId &&
        access.connectionId === record.approved.command.destination.connectionId
      )
        return this.finish(record, await inspectBufferPost(access.accessToken, postId, record.approved.command))
    } catch {
      /* Persisted uncertainty remains terminal. */
    }
    return record.result ?? { kind: "unknown", reason: "unconfirmed-create", postId }
  }
}

/** Addresses a separate guard per workflow and approved candidate version. */
export function createBufferPublication(namespace: DurableObjectNamespace, publicationId: string) {
  const stub = namespace.get(namespace.idFromName(publicationId))
  const post = async <T>(body: unknown): Promise<T> => {
    const response = await stub.fetch("https://buffer-publication/", { method: "POST", body: JSON.stringify(body) })
    if (!response.ok) throw new Error("Buffer publication unavailable")
    return response.json() as Promise<T>
  }
  return {
    prepare: (approved: ApprovedPublication) => post<{ ok: boolean }>({ op: "prepare", approved }),
    submit: (fingerprint: string) => post<BufferCreateResult>({ op: "submit", fingerprint }),
    inspect: (fingerprint: string) => post<BufferCreateResult>({ op: "inspect", fingerprint }),
  }
}
