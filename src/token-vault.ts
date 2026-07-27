import { base64urlDecode, decryptToken, type Envelope, encryptToken } from "./crypto"
import { type Env, type GoogleCalendarTokens, type LinkedInTokens, TOKEN_PROVIDER, type TokenProvider } from "./types"

type StoredTokens = LinkedInTokens | GoogleCalendarTokens

interface StateEntry {
  cookieId: string
  expiresAt: number
}

function tokenKey(provider: TokenProvider): string {
  return provider === TOKEN_PROVIDER.LINKEDIN ? "tokens" : `${provider}:tokens`
}

function stateKey(provider: TokenProvider, state: string): string {
  return provider === TOKEN_PROVIDER.LINKEDIN ? `state:${state}` : `state:${provider}:${state}`
}

function tokenProvider(value: unknown): TokenProvider | null {
  if (value === undefined || value === TOKEN_PROVIDER.LINKEDIN) return TOKEN_PROVIDER.LINKEDIN
  if (value === TOKEN_PROVIDER.GOOGLE_CALENDAR) return TOKEN_PROVIDER.GOOGLE_CALENDAR
  return null
}

export class TokenVaultDO implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env

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
    if (new TextEncoder().encode(raw).byteLength > 10_000) return new Response("request too large", { status: 413 })
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
      console.error("[TokenVaultDO] operation failed:", err)
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
    const expiresAt = Date.now() + 5 * 60 * 1000
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
      if (rawKey.byteLength !== 32) continue
      const result = await decryptToken(envelope, rawKey)
      if (result !== null) return result
    }
    return null
  }
}
