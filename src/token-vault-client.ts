import { createRemoteJWKSet, jwtVerify } from "jose"
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

const JWKS_URL_TEMPLATE = "https://{domain}.cloudflareaccess.com/cdn-cgi/access/certs"

const jwksResolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getResolver(domain: string) {
  let r = jwksResolvers.get(domain)
  if (!r) {
    r = createRemoteJWKSet(new URL(JWKS_URL_TEMPLATE.replace("{domain}", domain)))
    jwksResolvers.set(domain, r)
  }
  return r
}

export async function verifyAccessJwt(request: Request, env: Env): Promise<AccessJwtClaims | null> {
  if (env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK === "true" && env.DEPLOYMENT_ENV === "development") return null

  try {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion")
    if (!jwt) return null

    const JWKS = getResolver(env.ACCESS_TEAM)
    const { payload } = await jwtVerify(jwt, JWKS, {
      algorithms: ["RS256"],
      requiredClaims: ["exp", "nbf"],
      issuer: `https://${env.ACCESS_TEAM}.cloudflareaccess.com`,
      audience: env.ACCESS_AUDIENCE,
    })

    if (typeof payload.email !== "string") return null

    const allowed = env.ACCESS_ADMIN_EMAILS?.split(",").map((e) => e.trim()) ?? []
    if (!allowed.includes(payload.email)) return null

    return payload as unknown as AccessJwtClaims
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
