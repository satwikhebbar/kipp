import type { Env, LinkedInTokens } from "./types"

interface AccessJwtClaims {
  email: string
  sub: string
  iss: string
  aud: string
  exp: number
  nbf: number
  iat: number
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/")
  while (str.length % 4) str += "="
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function jwtToObject(payload: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(payload)))
}

const jwksCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>()

async function fetchJwks(teamDomain: string): Promise<{ keys: JsonWebKey[] }> {
  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to fetch JWKS: ${res.status}`)
  return res.json() as Promise<{ keys: JsonWebKey[] }>
}

function getJwks(teamDomain: string): Promise<{ keys: JsonWebKey[] }> {
  const now = Date.now()
  const cached = jwksCache.get(teamDomain)
  if (cached && now - cached.fetchedAt < 3_600_000) {
    return Promise.resolve({ keys: cached.keys })
  }
  return fetchJwks(teamDomain).then((jwks) => {
    jwksCache.set(teamDomain, { keys: jwks.keys, fetchedAt: now })
    return jwks
  })
}

export async function verifyAccessJwt(request: Request, env: Env): Promise<AccessJwtClaims | null> {
  if (env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK === "true" && env.DEPLOYMENT_ENV === "development") return null

  try {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion")
    if (!jwt) return null

    const parts = jwt.split(".")
    if (parts.length !== 3) return null

    let header: { kid?: string; alg?: string }
    try {
      header = jwtToObject(parts[0]) as { kid?: string; alg?: string }
    } catch {
      return null
    }
    if (typeof header.kid !== "string" || !header.kid) return null
    if (header.alg !== "RS256") return null

    let jwks: { keys: JsonWebKey[] }
    try {
      jwks = await getJwks(env.ACCESS_TEAM)
    } catch {
      return null
    }
    const jwk = jwks.keys.find((k) => (k as unknown as { kid: string }).kid === header.kid)
    if (jwk?.kty !== "RSA") return null
    if (jwk?.use && jwk.use !== "sig") return null

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ])

    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const sig = base64urlDecode(parts[2])

    let verified: boolean
    try {
      verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data)
    } catch {
      return null
    }
    if (!verified) return null

    let rawClaims: Record<string, unknown>
    try {
      rawClaims = jwtToObject(parts[1])
    } catch {
      return null
    }

    if (typeof rawClaims.exp !== "number" || Date.now() > rawClaims.exp * 1000) return null
    if (typeof rawClaims.nbf !== "number" || Date.now() < rawClaims.nbf * 1000) return null
    if (rawClaims.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null

    const aud = rawClaims.aud
    const expectedAud = env.ACCESS_AUDIENCE
    const audMatch = aud === expectedAud || (Array.isArray(aud) && aud.includes(expectedAud))
    if (!audMatch) return null

    if (typeof rawClaims.email !== "string") return null

    const allowed = env.ACCESS_ADMIN_EMAILS?.split(",").map((e) => e.trim()) ?? []
    if (!allowed.includes(rawClaims.email)) return null

    return rawClaims as unknown as AccessJwtClaims
  } catch {
    return null
  }
}

export function createTokenVault(env: Env) {
  const doId = env.TOKEN_VAULT.idFromName("linkedin-token-vault")
  const doStub = env.TOKEN_VAULT.get(doId)

  async function cmd<T>(op: string, args?: Record<string, unknown>): Promise<T> {
    const res = await doStub.fetch("https://dummy/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, ...args }),
    })
    if (!res.ok) throw new Error(`DO command ${op} failed: ${res.status}`)
    return res.json() as Promise<T>
  }

  return {
    issueState: () => cmd<{ state: string; cookieId: string }>("issueState"),
    consumeState: (state: string, cookieId: string) => cmd<{ valid: boolean }>("consumeState", { state, cookieId }),
    readTokens: () => cmd<{ tokens: LinkedInTokens | null }>("readTokens"),
    writeTokens: (tokens: LinkedInTokens) => cmd<{ ok: boolean }>("writeTokens", { tokens }),
    rewrap: () => cmd<{ success: boolean }>("rewrap"),
  }
}
