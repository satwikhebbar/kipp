import { BUFFER_SCOPES, bufferRedirectUri, exchangeBufferToken } from "../integrations/buffer/oauth"
import { HTTP_STATUS } from "../runtime/http"
import {
  AES_256_KEY_LENGTH,
  base64urlDecode,
  base64urlEncode,
  decryptToken,
  type Envelope,
  encryptToken,
} from "./crypto"
import type { BufferAccess, BufferGrant, BufferGrantInput } from "./types"
import { type Env, type GoogleCalendarTokens, type LinkedInTokens, TOKEN_PROVIDER, type TokenProvider } from "./types"

const BUFFER_REFRESH_MARGIN_MS = 60_000
const OAUTH_STATE_EXPIRY_MS = 300_000
const MAX_REQUEST_BODY_BYTES = 10_000

type StoredTokens = LinkedInTokens | GoogleCalendarTokens

interface StateEntry {
  cookieId: string
  expiresAt: number
}

/** Returns the storage key for a provider's token envelope. */
function tokenKey(provider: TokenProvider): string {
  return provider === TOKEN_PROVIDER.LINKEDIN ? "tokens" : `${provider}:tokens`
}

/** Returns the storage key for a provider's OAuth state entry. */
function stateKey(provider: TokenProvider, state: string): string {
  return provider === TOKEN_PROVIDER.LINKEDIN ? `state:${state}` : `state:${provider}:${state}`
}

/** Parses a token provider value, defaulting to LINKEDIN when undefined. */
function tokenProvider(value: unknown): TokenProvider | null {
  if (value === undefined || value === TOKEN_PROVIDER.LINKEDIN) return TOKEN_PROVIDER.LINKEDIN
  if (value === TOKEN_PROVIDER.GOOGLE_CALENDAR) return TOKEN_PROVIDER.GOOGLE_CALENDAR
  return null
}

export class TokenVaultDO implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private bufferQueue: Promise<void> = Promise.resolve()
  private bufferRefresh: Promise<BufferAccess> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("content-type") !== "application/json")
      return new Response("invalid request", { status: 400 })
    let raw: string
    try {
      raw = await request.text()
    } catch {
      return new Response("invalid body", { status: 400 })
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BODY_BYTES)
      return new Response("request too large", { status: HTTP_STATUS.PAYLOAD_TOO_LARGE })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return new Response("invalid body", { status: 400 })
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return new Response("invalid body", { status: 400 })
    const body = parsed as Record<string, unknown>
    const { op, ...args } = body
    try {
      switch (op) {
        case "issueBufferState":
          return await this.#issueBufferState()
        case "consumeBufferState":
          return await this.#consumeBufferState(args.state, args.cookieId)
        case "replaceBufferGrant":
          return await this.#replaceBufferGrant(args.grant)
        case "acquireBufferAccess":
          return Response.json(await this.#acquireBufferAccess())
        case "rewrapBuffer":
          return await this.#bufferLocked(async () => this.#rewrap(TOKEN_PROVIDER.BUFFER))
        case "issueState":
          return this.#issueState(tokenProvider(args.provider))
        case "consumeState":
          return this.#consumeState(tokenProvider(args.provider), args.state as string, args.cookieId as string)
        case "readTokens":
          return this.#readTokens(tokenProvider(args.provider))
        case "writeTokens":
          if (typeof args.tokens !== "object" || args.tokens === null || Array.isArray(args.tokens))
            return new Response(JSON.stringify({ ok: false }), { status: 400 })
          return this.#writeTokens(tokenProvider(args.provider), args.tokens as StoredTokens)
        case "rewrap":
          return this.#rewrap(tokenProvider(args.provider))
        default:
          return new Response("unknown operation", { status: 400 })
      }
    } catch (err) {
      if (typeof op !== "string" || !op.toLowerCase().includes("buffer"))
        console.error(new Date().toISOString(), "[TokenVaultDO] operation failed:", err)
      return new Response("internal error", { status: 500 })
    }
  }

  async alarm(): Promise<void> {
    let nextExpiry: number | null = null
    const entries = await this.ctx.storage.list<StateEntry>({ prefix: "state:" })
    for (const [key, value] of entries) {
      if (Date.now() > value.expiresAt) {
        await this.ctx.storage.delete(key)
      } else if (nextExpiry === null || value.expiresAt < nextExpiry) {
        nextExpiry = value.expiresAt
      }
    }
    if (nextExpiry !== null) await this.ctx.storage.setAlarm(nextExpiry)
  }

  async #issueState(provider: TokenProvider | null): Promise<Response> {
    if (!provider) return new Response("invalid provider", { status: 400 })
    const state = crypto.randomUUID()
    const cookieId = crypto.randomUUID()
    const expiresAt = Date.now() + OAUTH_STATE_EXPIRY_MS
    await this.ctx.storage.put<StateEntry>(stateKey(provider, state), { cookieId, expiresAt })
    const currentAlarm = await this.ctx.storage.getAlarm()
    if (currentAlarm === null || expiresAt < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresAt)
    }
    return Response.json({ state, cookieId })
  }

  async #consumeState(provider: TokenProvider | null, state: string, cookieId: string): Promise<Response> {
    if (!provider) return new Response("invalid provider", { status: 400 })
    const key = stateKey(provider, state)
    const entry = await this.ctx.storage.get<StateEntry>(key)
    if (!entry || entry.cookieId !== cookieId || Date.now() > entry.expiresAt) {
      return Response.json({ valid: false })
    }
    await this.ctx.storage.delete(key)
    return Response.json({ valid: true })
  }

  async #readTokens(provider: TokenProvider | null): Promise<Response> {
    if (!provider) return new Response("invalid provider", { status: 400 })
    const raw = await this.ctx.storage.get<Envelope>(tokenKey(provider))
    if (!raw) return Response.json({ tokens: null })
    const result = await this.#decrypt(raw)
    if (!result) return Response.json({ tokens: null })
    return Response.json({ tokens: result as unknown as StoredTokens })
  }

  async #writeTokens(provider: TokenProvider | null, tokens: StoredTokens): Promise<Response> {
    if (!provider) return new Response("invalid provider", { status: 400 })
    if (!tokens.access_token || typeof tokens.access_token !== "string") return Response.json({ ok: false })
    const envelope = await this.#encrypt(tokens as unknown as Record<string, unknown>)
    await this.ctx.storage.put(tokenKey(provider), envelope)
    return Response.json({ ok: true })
  }

  async #rewrap(provider: TokenProvider | null): Promise<Response> {
    if (!provider) return new Response("invalid provider", { status: 400 })
    const key = tokenKey(provider)
    const raw = await this.ctx.storage.get<Envelope>(key)
    if (!raw) return new Response(JSON.stringify({ success: false, reason: "no tokens stored" }), { status: 500 })
    const decrypted = await this.#decrypt(raw)
    if (!decrypted)
      return new Response(JSON.stringify({ success: false, reason: "decryption failed" }), { status: 500 })
    const reencrypted = await this.#encrypt(decrypted)
    await this.ctx.storage.put(key, reencrypted)
    return Response.json({ success: true })
  }

  /** Serializes short Buffer storage transitions without holding other providers behind network I/O. */
  #bufferLocked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.bufferQueue.then(operation)
    this.bufferQueue = result.then(
      () => {},
      () => {},
    )
    return result
  }

  async #issueBufferState(): Promise<Response> {
    const redirectUri = bufferRedirectUri(this.env)
    if (!redirectUri) return new Response("Buffer callback origin is not configured", { status: 503 })
    const state = crypto.randomUUID()
    const cookieId = crypto.randomUUID()
    const verifier = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
    const challenge = base64urlEncode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    )
    const expiresAt = Date.now() + OAUTH_STATE_EXPIRY_MS
    const envelope = await this.#encrypt({ verifier, redirectUri })
    await this.ctx.storage.put(stateKey(TOKEN_PROVIDER.BUFFER, state), { cookieId, expiresAt, envelope })
    const alarm = await this.ctx.storage.getAlarm()
    if (alarm === null || expiresAt < alarm) await this.ctx.storage.setAlarm(expiresAt)
    return Response.json({ state, cookieId, challenge })
  }

  #consumeBufferState(state: unknown, cookieId: unknown): Promise<Response> {
    return this.#bufferLocked(async () => {
      if (typeof state !== "string" || !state || typeof cookieId !== "string" || !cookieId)
        return Response.json({ valid: false })
      const key = stateKey(TOKEN_PROVIDER.BUFFER, state)
      const entry = await this.ctx.storage.get<StateEntry & { envelope: Envelope }>(key)
      if (!entry || entry.cookieId !== cookieId || Date.now() >= entry.expiresAt) return Response.json({ valid: false })
      const payload = await this.#decrypt(entry.envelope)
      await this.ctx.storage.delete(key)
      if (!payload || typeof payload.verifier !== "string" || payload.redirectUri !== bufferRedirectUri(this.env))
        return Response.json({ valid: false })
      return Response.json({ valid: true, ...payload })
    })
  }

  async #bufferRecord(): Promise<{ grant: BufferGrant; claim?: string } | null> {
    const envelope = await this.ctx.storage.get<Envelope>(tokenKey(TOKEN_PROVIDER.BUFFER))
    return envelope ? ((await this.#decrypt(envelope)) as { grant: BufferGrant; claim?: string } | null) : null
  }

  #replaceBufferGrant(value: unknown): Promise<Response> {
    return this.#bufferLocked(async () => {
      const input = value as BufferGrantInput | null
      if (
        !input ||
        typeof input.accessToken !== "string" ||
        !input.accessToken ||
        typeof input.refreshToken !== "string" ||
        !input.refreshToken ||
        typeof input.accountId !== "string" ||
        !input.accountId ||
        typeof input.expiresAtMs !== "number" ||
        !Number.isFinite(input.expiresAtMs) ||
        input.expiresAtMs <= Date.now() ||
        !Array.isArray(input.scopes) ||
        !BUFFER_SCOPES.every((scope) => input.scopes.includes(scope))
      )
        return Response.json({ ok: false }, { status: 400 })
      const old = await this.#bufferRecord()
      const grant: BufferGrant = {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAtMs: input.expiresAtMs,
        accountId: input.accountId,
        scopes: [...input.scopes],
        credentialGeneration: (old?.grant.credentialGeneration ?? 0) + 1,
        connectionId: old?.grant.accountId === input.accountId ? old.grant.connectionId : crypto.randomUUID(),
      }
      await this.ctx.storage.put(tokenKey(TOKEN_PROVIDER.BUFFER), await this.#encrypt({ grant }))
      return Response.json({ ok: true })
    })
  }

  #access(grant: BufferGrant): BufferAccess {
    return {
      kind: "usable",
      accessToken: grant.accessToken,
      accountId: grant.accountId,
      credentialGeneration: grant.credentialGeneration,
      connectionId: grant.connectionId,
    }
  }

  #acquireBufferAccess(): Promise<BufferAccess> {
    if (this.bufferRefresh) return this.bufferRefresh
    // Set the shared promise before the first asynchronous storage read.
    const operation = this.#refreshBuffer()
    this.bufferRefresh = operation
    void operation
      .finally(() => {
        if (this.bufferRefresh === operation) this.bufferRefresh = null
      })
      .catch(() => {})
    return operation
  }

  async #refreshBuffer(): Promise<BufferAccess> {
    const pending = await this.#bufferLocked(async () => {
      const record = await this.#bufferRecord()
      if (!record || record.claim)
        return {
          result: {
            kind: "needs-auth",
            reason: "Connect Buffer again; authorization is missing or a previous refresh could not be confirmed.",
          } as BufferAccess,
        }
      if (record.grant.expiresAtMs - Date.now() >= BUFFER_REFRESH_MARGIN_MS)
        return { result: this.#access(record.grant) }
      if (!this.env.BUFFER_CLIENT_ID || !this.env.BUFFER_CLIENT_SECRET)
        return { result: { kind: "needs-auth", reason: "Configure Buffer OAuth before reconnecting." } as BufferAccess }
      const claim = crypto.randomUUID()
      await this.ctx.storage.put(tokenKey(TOKEN_PROVIDER.BUFFER), await this.#encrypt({ grant: record.grant, claim }))
      return { grant: record.grant, claim }
    })
    if (pending.result) return pending.result
    const { grant, claim } = pending
    let replacement: Omit<BufferGrantInput, "accountId"> | null = null
    try {
      replacement = await exchangeBufferToken(this.env, {
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
      })
    } catch {
      /* Single-use refresh may have been consumed. Keep the durable claim. */
    }
    return this.#bufferLocked(async () => {
      const current = await this.#bufferRecord()
      if (current?.grant.credentialGeneration !== grant.credentialGeneration || current.claim !== claim) {
        if (current && !current.claim && current.grant.expiresAtMs - Date.now() >= BUFFER_REFRESH_MARGIN_MS)
          return this.#access(current.grant)
        return { kind: "needs-auth", reason: "Buffer authorization changed; reconnect Buffer." }
      }
      if (!replacement)
        return { kind: "needs-auth", reason: "Buffer refresh could not be confirmed. Connect Buffer again." }
      const updated: BufferGrant = { ...grant, ...replacement, credentialGeneration: grant.credentialGeneration + 1 }
      await this.ctx.storage.put(tokenKey(TOKEN_PROVIDER.BUFFER), await this.#encrypt({ grant: updated }))
      return this.#access(updated)
    })
  }

  #validKid(kid: string): boolean {
    return /^[a-zA-Z0-9_]+$/.test(kid)
  }

  async #encrypt(plaintext: Record<string, unknown>): Promise<Envelope> {
    const env = this.env as unknown as Record<string, string | undefined>
    const keyIds = env.TOKEN_ENCRYPTION_KEY_IDS?.split(",") ?? []
    const keyId = keyIds[0]
    if (!keyId || !this.#validKid(keyId)) throw new Error("no valid encryption keys configured")
    const keyB64 = env[`TOKEN_ENCRYPTION_KEY_${keyId}`]
    if (!keyB64) throw new Error(`key ${keyId} not found in env`)
    const rawKey = base64urlDecode(keyB64).buffer as ArrayBuffer
    return encryptToken(plaintext, keyId, rawKey)
  }

  async #decrypt(envelope: Envelope): Promise<Record<string, unknown> | null> {
    const env = this.env as unknown as Record<string, string | undefined>
    const keyIds = env.TOKEN_ENCRYPTION_KEY_IDS?.split(",") ?? []
    const ordered = [...keyIds.filter((k) => this.#validKid(k))]
    const kidIdx = ordered.indexOf(envelope.kid)
    if (kidIdx !== -1) {
      ordered.splice(kidIdx, 1)
      ordered.unshift(envelope.kid)
    }
    for (const kid of ordered) {
      const keyB64 = env[`TOKEN_ENCRYPTION_KEY_${kid}`]
      if (!keyB64) continue
      const rawKey = base64urlDecode(keyB64).buffer as ArrayBuffer
      if (rawKey.byteLength !== AES_256_KEY_LENGTH) continue
      const result = await decryptToken(envelope, rawKey)
      if (result !== null) return result
    }
    return null
  }
}
