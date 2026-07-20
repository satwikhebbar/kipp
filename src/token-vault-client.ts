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

let cachedJwks: { keys: JsonWebKey[] } | null = null
let jwksFetchedAt = 0

async function fetchJwks(teamDomain: string): Promise<{ keys: JsonWebKey[] }> {
  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to fetch JWKS: ${res.status}`)
  return res.json() as Promise<{ keys: JsonWebKey[] }>
}

function getJwks(teamDomain: string): Promise<{ keys: JsonWebKey[] }> {
  const now = Date.now()
  if (cachedJwks && now - jwksFetchedAt < 3_600_000) {
    return Promise.resolve(cachedJwks)
  }
  return fetchJwks(teamDomain).then((jwks) => {
    cachedJwks = jwks
    jwksFetchedAt = now
    return jwks
  })
}

export async function verifyAccessJwt(request: Request, env: Env): Promise<AccessJwtClaims | null> {
  if (env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK) return null

  const jwt = request.headers.get("Cf-Access-Jwt-Assertion")
  if (!jwt) return null

  const parts = jwt.split(".")
  if (parts.length !== 3) return null

  const header = jwtToObject(parts[0]) as { kid?: string; alg?: string }
  if (!header.kid) return null

  const jwks = await getJwks(env.ACCESS_TEAM)
  const jwk = jwks.keys.find((k) => (k as unknown as { kid: string }).kid === header.kid)
  if (!jwk) return null

  const algo =
    jwk.kty === "EC"
      ? ({ name: "ECDSA", namedCurve: jwk.crv } as { name: string; namedCurve: string })
      : ({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as { name: string; hash: string })

  const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"])

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const sig = base64urlDecode(parts[2])

  const verified = await crypto.subtle.verify(jwk.kty === "EC" ? "ECDSA" : "RSASSA-PKCS1-v1_5", key, sig, data)
  if (!verified) return null

  const claims = jwtToObject(parts[1]) as unknown as AccessJwtClaims
  if (Date.now() > claims.exp * 1000) return null
  if (Date.now() < claims.nbf * 1000) return null
  if (claims.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null
  if (claims.aud !== env.ACCESS_AUDIENCE) return null

  const allowed = env.ACCESS_ADMIN_EMAILS?.split(",").map((e) => e.trim()) ?? []
  if (!allowed.includes(claims.email)) return null

  return claims
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
