import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, open, readFile, rename } from "node:fs/promises"
import { join } from "node:path"

export const SCOPES = ["account:read", "posts:read", "posts:write", "offline_access"]
const COOKIE = "kipp-buffer-spike"
const CALLBACK = "/auth/buffer/callback"

/** Compares opaque values without accepting absent values. */
function same(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length > 0 &&
    Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** Stores local spike grants encrypted, with atomic replacement and owner-only files. */
export async function encryptedStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const keyPath = join(directory, "key")
  try {
    const file = await open(keyPath, "wx", 0o600)
    try { await file.writeFile(randomBytes(32)) } finally { await file.close() }
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  const key = await readFile(keyPath)
  if (key.length !== 32) throw Error("Invalid local encryption key")
  return {
    async write(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
      const bytes = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
      const temp = join(directory, `grant-${randomBytes(8).toString("hex")}.tmp`)
      const file = await open(temp, "wx", 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await rename(temp, join(directory, "grant.enc"))
    },
    async read() {
      const bytes = await readFile(join(directory, "grant.enc"))
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString())
    },
  }
}

/** Validates token fields without returning credentials to a browser or diagnostic. */
export function validateGrant(data, now) {
  const scopes = typeof data?.scope === "string" ? data.scope.split(/\s+/) : []
  if (typeof data?.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token ||
      data.token_type?.toLowerCase() !== "bearer" ||
      typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      !SCOPES.every(scope => scopes.includes(scope))) throw Error("Incomplete Buffer grant")
  return { ...data, expiresAtMs: now + data.expires_in * 1000, scopes }
}

/** Builds the isolated HTTP handler; only the callback can exchange a grant. */
export function createOAuthHandler({ origin, clientId, clientSecret, bootstrap, store, fetchImpl = fetch, now = Date.now, onConnected = async () => {}, onFailure = () => {} }) {
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) throw Error("An exact HTTPS origin is required")
  let pending = null
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  }
  const reply = (text, status = 200, extra = {}) => new Response(text, { status, headers: { ...headers, ...extra } })
  return async request => {
    const url = new URL(request.url)
    if (request.method !== "GET") return reply("Method not allowed", 405)
    if (url.pathname === "/health") return reply("Kipp Buffer OAuth spike ready")
    if (url.origin !== origin) return reply("Unexpected origin", 400)
    if (url.pathname === "/setup/buffer") {
      if (!same(url.searchParams.get("start"), bootstrap)) return reply("Setup link required", 403)
      const verifier = randomBytes(32).toString("base64url")
      pending = { state: randomBytes(32).toString("base64url"), cookie: randomBytes(32).toString("base64url"), verifier, expiresAt: now() + 300_000 }
      const auth = new URL("https://auth.buffer.com/auth")
      auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: origin + CALLBACK, response_type: "code", scope: SCOPES.join(" "), state: pending.state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" }).toString()
      return reply("", 302, { Location: auth.toString(), "Set-Cookie": `${COOKIE}=${pending.cookie}; Secure; HttpOnly; SameSite=Lax; Path=/auth/buffer; Max-Age=300` })
    }
    if (url.pathname !== CALLBACK) return reply("Not found", 404)
    const cookie = request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1)
    if (!pending || pending.expiresAt <= now() || !same(url.searchParams.get("state"), pending.state) || !same(cookie, pending.cookie)) return reply("Invalid or expired setup. Open the setup link again.", 403)
    const session = pending
    pending = null // Consume before any network await; a failed exchange must start over.
    const clearCookie = { "Set-Cookie": `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/auth/buffer; Max-Age=0` }
    const code = url.searchParams.get("code")
    if (url.searchParams.has("error") || !code) return reply("Authorization was not completed. Open the setup link to retry.", 400, clearCookie)
    try {
      const response = await fetchImpl("https://auth.buffer.com/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: origin + CALLBACK, code_verifier: session.verifier }),
      })
      if (!response.ok) { onFailure(`token-http-${response.status}`); return reply("Buffer token exchange failed. Return to Codex; do not share the callback URL.", 502, clearCookie) }
      const grant = validateGrant(await response.json(), now())
      await store.write(grant)
      // Keep discovery failure distinct: a usable encrypted grant was already saved.
      try { await onConnected(grant) } catch { onFailure("discovery-failed"); return reply("Buffer authorization saved. Channel discovery needs checking in Codex.", 200, clearCookie) }
      return reply("Buffer connected. You can return to Codex. No Note has been posted.", 200, clearCookie)
    } catch {
      onFailure("exchange-or-storage-failed")
      return reply("Authorization could not be saved. Open the setup link to start over.", 502, clearCookie)
    }
  }
}
