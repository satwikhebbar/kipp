import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { verifyAccessJwt } from "../token-vault-client"
import type { Env } from "../types"

const KID = "test-key-01"
const TEAM = "test-team"
const ISS = `https://${TEAM}.cloudflareaccess.com`
const AUD = "test-aud-123"

let keyPair: CryptoKeyPair
let publicJwk: JsonWebKey & { kid: string }

async function createJwt(
  payload: Record<string, unknown>,
  overrides?: { alg?: string; kid?: string },
): Promise<string> {
  const enc = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const header = { alg: overrides?.alg ?? "RS256", kid: overrides?.kid ?? KID, typ: "JWT" }
  const h = enc(header)
  const p = enc(payload)
  const data = new TextEncoder().encode(`${h}.${p}`)
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, data)
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `${h}.${p}.${sigB64}`
}

function baseEnv(): Env {
  return {
    ACCESS_TEAM: TEAM,
    ACCESS_AUDIENCE: AUD,
    ACCESS_ADMIN_EMAILS: "admin@example.com",
    ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false",
  } as unknown as Env
}

function makeRequest(jwt?: string): Request {
  const headers: Record<string, string> = {}
  if (jwt) headers["Cf-Access-Jwt-Assertion"] = jwt
  return new Request("https://example.com/setup/linkedin", { headers })
}

let testSeq = 0

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & { kid: string }
  publicJwk.kid = KID
  publicJwk.alg = "RS256"
  publicJwk.use = "sig"
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000 + testSeq * 3_600_001)
  testSeq++
})

afterEach(() => {
  vi.useRealTimers()
})

function validClaims(): Record<string, unknown> {
  const now = Date.now()
  return {
    sub: "user-id-123",
    email: "admin@example.com",
    aud: AUD,
    iss: ISS,
    exp: Math.floor(now / 1000) + 3600,
    nbf: Math.floor(now / 1000) - 60,
    iat: Math.floor(now / 1000) - 60,
  }
}

async function setupJwksFetch(keys?: JsonWebKey[]): Promise<void> {
  const jwks = keys ?? [publicJwk as unknown as JsonWebKey]
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ keys: jwks }), {
      headers: { "cache-control": "public, max-age=3600" },
    }),
  )
}

async function signedRequest(payload: Record<string, unknown>): Promise<Request> {
  const jwt = await createJwt(payload)
  return makeRequest(jwt)
}

describe("verifyAccessJwt — early exits (no fetch)", () => {
  it("returns null when ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK is true", async () => {
    const env = { ...baseEnv(), ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true" }
    expect(await verifyAccessJwt(makeRequest(), env)).toBeNull()
  })

  it("returns null when JWT header is missing", async () => {
    expect(await verifyAccessJwt(makeRequest(), baseEnv())).toBeNull()
  })

  it("returns null when JWT has wrong part count", async () => {
    expect(await verifyAccessJwt(makeRequest("header.payload"), baseEnv())).toBeNull()
  })

  it("returns null when header is not valid JSON", async () => {
    expect(await verifyAccessJwt(makeRequest("not-json.payload.sig"), baseEnv())).toBeNull()
  })

  it("returns null when header lacks kid", async () => {
    const h = btoa(JSON.stringify({ alg: "RS256" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(await verifyAccessJwt(makeRequest(`${h}.payload.sig`), baseEnv())).toBeNull()
  })

  it("returns null when alg is not RS256", async () => {
    const h = btoa(JSON.stringify({ alg: "HS256", kid: KID }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(await verifyAccessJwt(makeRequest(`${h}.payload.sig`), baseEnv())).toBeNull()
  })

  it("returns null when alg is none", async () => {
    const h = btoa(JSON.stringify({ alg: "none", kid: KID }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(await verifyAccessJwt(makeRequest(`${h}.payload.sig`), baseEnv())).toBeNull()
  })
})

describe("verifyAccessJwt — JWKS and signature", () => {
  it("returns null on JWKS fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"))
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).toBeNull()
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  it("returns null on JWKS non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).toBeNull()
  })

  it("returns null when JWKS has no matching kid", async () => {
    const noKidJwk = { ...publicJwk }
    delete (noKidJwk as { kid?: string }).kid
    await setupJwksFetch([noKidJwk as unknown as JsonWebKey])
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).toBeNull()
  })

  it("returns null when matching key is not RSA", async () => {
    const octJwk = { kty: "oct", kid: KID, alg: "HS256", k: "bG9s" }
    await setupJwksFetch([octJwk as unknown as JsonWebKey])
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).toBeNull()
  })

  it("rejects JWK with use: enc even when signature is valid", async () => {
    const encJwk = { ...publicJwk, use: "enc" }
    await setupJwksFetch([encJwk as unknown as JsonWebKey])
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).toBeNull()
  })

  it("accepts JWK with use: sig", async () => {
    const sigJwk = { ...publicJwk, use: "sig" }
    await setupJwksFetch([sigJwk as unknown as JsonWebKey])
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).not.toBeNull()
  })

  it("accepts JWK without use field", async () => {
    const noUseJwk = { ...publicJwk }
    delete (noUseJwk as { use?: string }).use
    await setupJwksFetch([noUseJwk as unknown as JsonWebKey])
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).not.toBeNull()
  })

  it("returns null on bad signature", async () => {
    await setupJwksFetch()
    const jwt = await createJwt(validClaims())
    const badSig = btoa("bad").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    const [h, p] = jwt.split(".")
    expect(await verifyAccessJwt(makeRequest(`${h}.${p}.${badSig}`), baseEnv())).toBeNull()
  })

  it("returns claims on valid JWT", async () => {
    await setupJwksFetch()
    expect(await verifyAccessJwt(await signedRequest(validClaims()), baseEnv())).not.toBeNull()
  })

  it("returns null when payload claims JSON is malformed", async () => {
    await setupJwksFetch()
    const h = btoa(JSON.stringify({ alg: "RS256", kid: KID }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const data = new TextEncoder().encode(`${h}.not-json`)
    const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, data)
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(await verifyAccessJwt(makeRequest(`${h}.not-json.${sigB64}`), baseEnv())).toBeNull()
  })
})

describe("verifyAccessJwt — claims validation", () => {
  it("returns null when exp is missing", async () => {
    await setupJwksFetch()
    const claims = { ...validClaims() }
    delete (claims as { exp?: number }).exp
    expect(await verifyAccessJwt(await signedRequest(claims), baseEnv())).toBeNull()
  })

  it("returns null when token is expired", async () => {
    await setupJwksFetch()
    expect(
      await verifyAccessJwt(
        await signedRequest({ ...validClaims(), exp: Math.floor(Date.now() / 1000) - 10 }),
        baseEnv(),
      ),
    ).toBeNull()
  })

  it("returns null when nbf is missing", async () => {
    await setupJwksFetch()
    const claims = { ...validClaims() }
    delete (claims as { nbf?: number }).nbf
    expect(await verifyAccessJwt(await signedRequest(claims), baseEnv())).toBeNull()
  })

  it("returns null when token is not yet valid", async () => {
    await setupJwksFetch()
    expect(
      await verifyAccessJwt(
        await signedRequest({ ...validClaims(), nbf: Math.floor(Date.now() / 1000) + 3600 }),
        baseEnv(),
      ),
    ).toBeNull()
  })

  it("returns null when iss is wrong", async () => {
    await setupJwksFetch()
    expect(
      await verifyAccessJwt(
        await signedRequest({ ...validClaims(), iss: "https://evil.cloudflareaccess.com" }),
        baseEnv(),
      ),
    ).toBeNull()
  })

  it("returns null when aud is wrong (string)", async () => {
    await setupJwksFetch()
    expect(await verifyAccessJwt(await signedRequest({ ...validClaims(), aud: "wrong-aud" }), baseEnv())).toBeNull()
  })

  it("accepts array aud that includes expected", async () => {
    await setupJwksFetch()
    expect(
      await verifyAccessJwt(await signedRequest({ ...validClaims(), aud: [AUD, "extra-aud"] }), baseEnv()),
    ).not.toBeNull()
  })

  it("rejects array aud that does not include expected", async () => {
    await setupJwksFetch()
    expect(
      await verifyAccessJwt(await signedRequest({ ...validClaims(), aud: ["wrong-aud", "other-aud"] }), baseEnv()),
    ).toBeNull()
  })

  it("returns null when email is missing", async () => {
    await setupJwksFetch()
    const claims = { ...validClaims() }
    delete (claims as { email?: string }).email
    expect(await verifyAccessJwt(await signedRequest(claims), baseEnv())).toBeNull()
  })

  it("returns null when email is not allowlisted", async () => {
    await setupJwksFetch()
    expect(
      await verifyAccessJwt(await signedRequest({ ...validClaims(), email: "other@example.com" }), baseEnv()),
    ).toBeNull()
  })

  it("returns null when email is empty string", async () => {
    await setupJwksFetch()
    expect(await verifyAccessJwt(await signedRequest({ ...validClaims(), email: "" }), baseEnv())).toBeNull()
  })
})

describe("verifyAccessJwt — team-scoped JWKS cache", () => {
  it("uses separate cache entries for different team domains", async () => {
    const TEAM_A = "team-a"
    const TEAM_B = "team-b"
    const ISS_A = `https://${TEAM_A}.cloudflareaccess.com`
    const ISS_B = `https://${TEAM_B}.cloudflareaccess.com`
    const AUD = "test-aud"

    const kpA = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair
    const jwkA = (await crypto.subtle.exportKey("jwk", kpA.publicKey)) as JsonWebKey & { kid: string }
    jwkA.kid = "key-a"
    jwkA.alg = "RS256"

    const kpB = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair
    const jwkB = (await crypto.subtle.exportKey("jwk", kpB.publicKey)) as JsonWebKey & { kid: string }
    jwkB.kid = "key-b"
    jwkB.alg = "RS256"

    const envA = {
      ACCESS_TEAM: TEAM_A,
      ACCESS_AUDIENCE: AUD,
      ACCESS_ADMIN_EMAILS: "admin@example.com",
      ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false",
    } as unknown as Env
    const envB = {
      ACCESS_TEAM: TEAM_B,
      ACCESS_AUDIENCE: AUD,
      ACCESS_ADMIN_EMAILS: "admin@example.com",
      ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false",
    } as unknown as Env

    let fetchCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      fetchCount++
      if (url.includes(TEAM_A)) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [jwkA] }), {
            headers: { "cache-control": "public, max-age=3600" },
          }),
        )
      }
      if (url.includes(TEAM_B)) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [jwkB] }), {
            headers: { "cache-control": "public, max-age=3600" },
          }),
        )
      }
      return Promise.reject(new Error("unexpected url"))
    })

    async function signFor(payload: Record<string, unknown>, kp: CryptoKeyPair): Promise<string> {
      const enc = (obj: Record<string, unknown>) =>
        btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      const kid = kp === kpA ? "key-a" : "key-b"
      const h = enc({ alg: "RS256", kid })
      const p = enc(payload)
      const data = new TextEncoder().encode(`${h}.${p}`)
      const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, data)
      const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
      return `${h}.${p}.${sigB64}`
    }

    const now = Date.now()
    const payload = (iss: string) => ({
      sub: "u",
      email: "admin@example.com",
      aud: AUD,
      iss,
      exp: Math.floor(now / 1000) + 3600,
      nbf: Math.floor(now / 1000) - 60,
      iat: Math.floor(now / 1000) - 60,
    })

    // First call for each team fetches JWKS (2 fetches)
    expect(await verifyAccessJwt(await makeRequest(await signFor(payload(ISS_A), kpA)), envA)).not.toBeNull()
    expect(await verifyAccessJwt(await makeRequest(await signFor(payload(ISS_B), kpB)), envB)).not.toBeNull()
    expect(fetchCount).toBe(2)

    // Second call for each team uses cache (0 additional fetches)
    expect(await verifyAccessJwt(await makeRequest(await signFor(payload(ISS_A), kpA)), envA)).not.toBeNull()
    expect(await verifyAccessJwt(await makeRequest(await signFor(payload(ISS_B), kpB)), envB)).not.toBeNull()
    expect(fetchCount).toBe(2)

    // Cross-team JWT should fail (wrong key)
    expect(await verifyAccessJwt(await makeRequest(await signFor(payload(ISS_A), kpB)), envA)).toBeNull()
  })
})
