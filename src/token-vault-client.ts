import { createRemoteJWKSet, jwtVerify } from "jose"
import { type Env, type GoogleCalendarTokens, type LinkedInTokens, TOKEN_PROVIDER, type TokenProvider } from "./types"

export { TOKEN_PROVIDER, type TokenProvider } from "./types"

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
  if (isInsecureLocalAccessEnabled(env)) return null

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

/** Never enables the development fallback outside an explicitly marked development deployment. */
export function isInsecureLocalAccessEnabled(env: Env): boolean {
  return env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK === "true" && env.DEPLOYMENT_ENV === "development"
}

export function createTokenVault(env: Env, provider: TokenProvider = TOKEN_PROVIDER.LINKEDIN) {
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
    issueState: () => cmd<{ state: string; cookieId: string }>("issueState", { provider }),
    consumeState: (state: string, cookieId: string) =>
      cmd<{ valid: boolean }>("consumeState", { provider, state, cookieId }),
    readTokens: () => cmd<{ tokens: LinkedInTokens | GoogleCalendarTokens | null }>("readTokens", { provider }),
    writeTokens: (tokens: LinkedInTokens | GoogleCalendarTokens) =>
      cmd<{ ok: boolean }>("writeTokens", { provider, tokens }),
    rewrap: () => cmd<{ success: boolean }>("rewrap", { provider }),
  }
}
