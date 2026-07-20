import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { TokenVaultDO } from "../token-vault"
import { createTokenVault } from "../token-vault-client"
import { handleAuthCallback, handleAuthStart } from "../triggers/linkedin-auth"
import type { Env } from "../types"

vi.mock("../workflow", () => ({ PipelineWorkflow: class {} }))

import worker from "../index"

function nonNull<T>(v: T | null): T {
  expect(v).not.toBeNull()
  // biome-ignore lint/style/noNonNullAssertion: expect guard above satisfies tsc
  return v!
}

function b64url(buf: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function makeKey(): string {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return b64url(key)
}

function mockStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async (opts?: { prefix?: string }) => {
      const entries = [...store.entries()].filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))
      return new Map(entries)
    },
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => {
      alarm = t
    },
  } as unknown as DurableObjectStorage
}

function makeStub(doInstance: TokenVaultDO): DurableObjectStub {
  return {
    fetch: (url: string | Request, init?: RequestInit) => {
      const req = url instanceof Request ? url : new Request(url, init)
      return doInstance.fetch(req)
    },
  } as unknown as DurableObjectStub
}

function makeNs(doInstance: TokenVaultDO): DurableObjectNamespace {
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => "test-id" }),
    get: vi.fn().mockReturnValue(makeStub(doInstance)),
  } as unknown as DurableObjectNamespace
}

let testSeq = 0

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000 + testSeq * 3_600_001)
  testSeq++
})

afterEach(() => {
  vi.useRealTimers()
})

function baseEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  const keyB64 = makeKey()
  return {
    LINKEDIN_CLIENT_ID: "test-client-id",
    LINKEDIN_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY_IDS: "k20260720a",
    TOKEN_ENCRYPTION_KEY_k20260720a: keyB64,
    ...overrides,
  }
}

describe("production-mode route authorization", () => {
  it("handleAuthStart returns 403 without JWT in production mode", async () => {
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false" }) as unknown as Env
    const req = new Request("https://example.com/setup/linkedin")
    const res = await handleAuthStart(req, "example.com", env)
    expect(res.status).toBe(403)
  })

  it("handleAuthStart returns 403 with forged JWT", async () => {
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false" }) as unknown as Env
    const req = new Request("https://example.com/setup/linkedin", {
      headers: { "Cf-Access-Jwt-Assertion": "header.payload.badsig" },
    })
    const res = await handleAuthStart(req, "example.com", env)
    expect(res.status).toBe(403)
  })

  it("handleAuthCallback returns 403 without JWT in production mode", async () => {
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false" }) as unknown as Env
    const req = new Request("https://example.com/auth/linkedin/callback", {
      headers: { cookie: "oauth-session=cookie-1" },
    })
    const res = await handleAuthCallback("code", "state", "example.com", env, req)
    expect(res.status).toBe(403)
  })

  it("ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK=false does not bypass", async () => {
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false" }) as unknown as Env
    const req = new Request("https://example.com/setup/linkedin")
    const res = await handleAuthStart(req, "example.com", env)
    expect(res.status).toBe(403)
  })

  it("ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK=true bypasses for dev mode", async () => {
    const storage = mockStorage()
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true" }) as unknown as Env
    const doInstance = new TokenVaultDO({ storage } as never, env)
    env.TOKEN_VAULT = makeNs(doInstance)

    const req = new Request("https://example.com/setup/linkedin")
    const res = await handleAuthStart(req, "example.com", env)
    expect(res.status).toBe(302)
  })
})

describe("end-to-end OAuth/DO contract", () => {
  it("OAuth flow creates state, completes callback with encrypted tokens", async () => {
    const storage = mockStorage()
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true" }) as unknown as Env
    const doInstance = new TokenVaultDO({ storage } as never, env)
    env.TOKEN_VAULT = makeNs(doInstance)

    const setupReq = new Request("https://example.com/setup/linkedin")
    const setupRes = await handleAuthStart(setupReq, "example.com", env)
    expect(setupRes.status).toBe(302)

    const setCookie = setupRes.headers.get("set-cookie") ?? ""
    const cookieId = nonNull(setCookie.match(/oauth-session=([^;]+)/))[1]

    const loc = setupRes.headers.get("location") ?? ""
    const state = nonNull(new URL(loc).searchParams.get("state"))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "e2e-access-token",
          expires_in: 5184000,
          refresh_token: "e2e-refresh-token",
        }),
    })

    const callbackReq = new Request(`https://example.com/auth/linkedin/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth-session=${cookieId}` },
    })
    const callbackRes = await handleAuthCallback("abc", state, "example.com", env, callbackReq)
    expect(callbackRes.status).toBe(200)

    const envelope = (await storage.get("tokens")) as Record<string, unknown>
    expect(envelope).not.toBeUndefined()
    expect(envelope.ct).toBeTypeOf("string")
    expect(envelope.kid).toBe("k20260720a")
    expect(JSON.stringify(envelope)).not.toContain("e2e-access-token")
    expect(JSON.stringify(envelope)).not.toContain("e2e-refresh-token")

    const vault = createTokenVault(env as Env)
    const { tokens } = await vault.readTokens()
    expect(tokens).not.toBeNull()
    expect(tokens?.access_token).toBe("e2e-access-token")
    expect(tokens?.refresh_token).toBe("e2e-refresh-token")
  })

  it("replayed state cannot complete callback again", async () => {
    const storage = mockStorage()
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true" }) as unknown as Env
    const doInstance = new TokenVaultDO({ storage } as never, env)
    env.TOKEN_VAULT = makeNs(doInstance)

    const setupReq = new Request("https://example.com/setup/linkedin")
    const setupRes = await handleAuthStart(setupReq, "example.com", env)
    expect(setupRes.status).toBe(302)
    const setCookie = setupRes.headers.get("set-cookie") ?? ""
    const cookieId = nonNull(setCookie.match(/oauth-session=([^;]+)/))[1]
    const state = nonNull(new URL(setupRes.headers.get("location") ?? "").searchParams.get("state"))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "t", expires_in: 5184000 }),
    })

    const callbackReq1 = new Request(`https://example.com/auth/linkedin/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth-session=${cookieId}` },
    })
    const res1 = await handleAuthCallback("abc", state, "example.com", env, callbackReq1)
    expect(res1.status).toBe(200)

    const callbackReq2 = new Request(`https://example.com/auth/linkedin/callback?code=def&state=${state}`, {
      headers: { cookie: `oauth-session=${cookieId}` },
    })
    const res2 = await handleAuthCallback("def", state, "example.com", env, callbackReq2)
    expect(res2.status).toBe(400)
  })

  it("accepts request without content-length header via DO client", async () => {
    const storage = mockStorage()
    const env = baseEnv({ ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true" }) as unknown as Env
    const doInstance = new TokenVaultDO({ storage } as never, env)
    env.TOKEN_VAULT = makeNs(doInstance)

    const vault = createTokenVault(env as Env)
    const result = await vault.writeTokens({ access_token: "no-cl-token", expires_in: 3600, created_at: "now" })
    expect(result).toEqual({ ok: true })

    const { tokens } = await vault.readTokens()
    expect(tokens?.access_token).toBe("no-cl-token")
  })
})

describe("Worker fetch — production-mode routes", () => {
  let keyPair: CryptoKeyPair
  let publicJwk: JsonWebKey & { kid: string }
  const KID = "wrk-test-key-01"
  const TEAM = "wrk-test-team"
  const ISS = `https://${TEAM}.cloudflareaccess.com`
  const AUD = "wrk-test-aud-123"
  const ADMIN_EMAIL = "admin-wrk@example.com"

  async function createJwt(payload: Record<string, unknown>): Promise<string> {
    const enc = (obj: Record<string, unknown>) =>
      btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    const header = { alg: "RS256", kid: KID, typ: "JWT" }
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

  function validClaims(): Record<string, unknown> {
    const now = Date.now()
    return {
      sub: "u-123",
      email: ADMIN_EMAIL,
      aud: AUD,
      iss: ISS,
      exp: Math.floor(now / 1000) + 3600,
      nbf: Math.floor(now / 1000) - 60,
      iat: Math.floor(now / 1000) - 60,
    }
  }

  function makeVaultEnv(storage: DurableObjectStorage): Env {
    const env = {
      LINKEDIN_CLIENT_ID: "wrk-client-id",
      LINKEDIN_CLIENT_SECRET: "wrk-client-secret",
      TOKEN_ENCRYPTION_KEY_IDS: "k20260720a",
      TOKEN_ENCRYPTION_KEY_k20260720a: makeKey(),
      ACCESS_TEAM: TEAM,
      ACCESS_AUDIENCE: AUD,
      ACCESS_ADMIN_EMAILS: ADMIN_EMAIL,
      ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false",
    } as unknown as Env
    const doInstance = new TokenVaultDO({ storage } as never, env)
    const ns = {
      idFromName: vi.fn().mockReturnValue({ toString: () => "wrk-test-id" }),
      get: vi.fn().mockReturnValue(makeStub(doInstance)),
    } as unknown as DurableObjectNamespace
    ;(env as unknown as Record<string, unknown>).TOKEN_VAULT = ns
    return env
  }

  beforeAll(async () => {
    keyPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair
    publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & { kid: string }
    publicJwk.kid = KID
    publicJwk.alg = "RS256"
  })

  function setupJwksMock(): void {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("cloudflareaccess.com/cdn-cgi/access/certs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ keys: [publicJwk as unknown as JsonWebKey] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: "wrk-at", expires_in: 5184000, refresh_token: "wrk-rt" }),
      })
    })
  }

  it("setup/linkedin returns 403 without JWT", async () => {
    const env = makeVaultEnv(mockStorage())
    setupJwksMock()
    const req = new Request("https://example.com/setup/linkedin")
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(403)
  })

  it("setup/linkedin returns 403 with forged JWT", async () => {
    const env = makeVaultEnv(mockStorage())
    setupJwksMock()
    const req = new Request("https://example.com/setup/linkedin", {
      headers: { "Cf-Access-Jwt-Assertion": "bad.header.sig" },
    })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(403)
  })

  it("setup/linkedin returns 302 with valid JWT", async () => {
    const env = makeVaultEnv(mockStorage())
    setupJwksMock()
    const jwt = await createJwt(validClaims())
    const req = new Request("https://example.com/setup/linkedin", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(302)
  })

  it("callback returns 403 without JWT", async () => {
    const env = makeVaultEnv(mockStorage())
    setupJwksMock()
    const req = new Request("https://example.com/auth/linkedin/callback?code=abc&state=xyz")
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(403)
  })

  it("callback returns 400 when code parameter is missing", async () => {
    const env = makeVaultEnv(mockStorage())
    setupJwksMock()
    const jwt = await createJwt(validClaims())
    const req = new Request("https://example.com/auth/linkedin/callback?state=xyz", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(400)
  })

  it("callback completes full OAuth flow through worker.fetch", async () => {
    const storage = mockStorage()
    const env = makeVaultEnv(storage)
    env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK = "true" as never

    // First request — setup creates state
    const jwt = await createJwt(validClaims())
    const setupReq = new Request("https://example.com/setup/linkedin", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    })
    const setupRes = await worker.fetch(setupReq, env, {} as ExecutionContext)
    expect(setupRes.status).toBe(302)

    const setCookie = setupRes.headers.get("set-cookie") ?? ""
    const cookieId = nonNull(setCookie.match(/oauth-session=([^;]+)/))[1]
    const loc = setupRes.headers.get("location") ?? ""
    const state = nonNull(new URL(loc).searchParams.get("state"))

    // Second request — callback consumes state, exchanges code
    setupJwksMock()
    const callbackReq = new Request(`https://example.com/auth/linkedin/callback?code=abc&state=${state}`, {
      headers: { "Cf-Access-Jwt-Assertion": jwt, cookie: `oauth-session=${cookieId}` },
    })
    const callbackRes = await worker.fetch(callbackReq, env, {} as ExecutionContext)
    expect(callbackRes.status).toBe(200)
  })

  it("rewrap returns 403 without JWT", async () => {
    const storage = mockStorage()
    await storage.put("tokens", { v: 1, kid: "k20260720a", aad: "", iv: "", ct: "" })
    const env = makeVaultEnv(storage)
    setupJwksMock()
    const req = new Request("https://example.com/admin/rewrap", { method: "POST" })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(403)
  })

  it("rewrap returns 500 with unauthenticated env when no tokens stored", async () => {
    const env = makeVaultEnv(mockStorage())
    env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK = "true" as never
    setupJwksMock()
    const req = new Request("https://example.com/admin/rewrap", { method: "POST" })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false })
  })

  it("rewrap returns 200 with tokens and valid JWT", async () => {
    const storage = mockStorage()
    const env = makeVaultEnv(storage)
    setupJwksMock()

    // Store tokens via the vault client first
    const vault = createTokenVault(env)
    await vault.writeTokens({ access_token: "rewrap-at", expires_in: 3600, created_at: "now" })

    const jwt = await createJwt(validClaims())
    const req = new Request("https://example.com/admin/rewrap", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true })
  })

  it("denies requests with expired JWT", async () => {
    const env = makeVaultEnv(mockStorage())
    setupJwksMock()
    const expired = { ...validClaims(), exp: Math.floor(Date.now() / 1000) - 10 }
    const jwt = await createJwt(expired)
    const req = new Request("https://example.com/setup/linkedin", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(403)
  })

  it("denies requests with wrong audience", async () => {
    const env = makeVaultEnv(mockStorage())
    setupJwksMock()
    const badAud = { ...validClaims(), aud: "wrong-aud" }
    const jwt = await createJwt(badAud)
    const req = new Request("https://example.com/setup/linkedin", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    })
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(403)
  })

  it("ALLOW_INSECURE=true bypasses JWT check in dev mode", async () => {
    const env = makeVaultEnv(mockStorage())
    env.ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK = "true" as never
    setupJwksMock()
    const req = new Request("https://example.com/setup/linkedin")
    const res = await worker.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(302)
  })
})
