import { describe, expect, it } from "vitest"
import type { Envelope } from "../crypto"
import { TokenVaultDO } from "../token-vault"
import type { Env } from "../types"

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

function makeDO(env: Env): TokenVaultDO {
  return new TokenVaultDO({ storage: mockStorage() } as never, env)
}

function keyEnv(keyId = "k20260720a", keyB64?: string): Env {
  return {
    TOKEN_ENCRYPTION_KEY_IDS: keyId,
    [`TOKEN_ENCRYPTION_KEY_${keyId}`]: keyB64 ?? makeKey(),
  } as never
}

function callFetch(
  doObj: TokenVaultDO,
  body: Record<string, unknown>,
  overrides?: Partial<RequestInit>,
): Promise<Response> {
  return doObj.fetch(
    new Request("https://dummy/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...overrides,
    }),
  )
}

describe("TokenVaultDO — dispatcher validation", () => {
  it("rejects non-JSON content-type", async () => {
    const doObj = makeDO(keyEnv())
    const res = await doObj.fetch(new Request("https://dummy/", { method: "POST", body: "x" }))
    expect(res.status).toBe(400)
  })

  it("rejects oversized body", async () => {
    const doObj = makeDO(keyEnv())
    const big = new Array(12_000).fill("x").join("")
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "readTokens", padding: big }),
      }),
    )
    expect(res.status).toBe(413)
  })

  it("accepts request without content-length header", async () => {
    const doObj = makeDO(keyEnv())
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "readTokens" }),
      }),
    )
    expect(res.status).toBe(200)
  })

  it("rejects malformed JSON", async () => {
    const doObj = makeDO(keyEnv())
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    )
    expect(res.status).toBe(400)
  })

  it("rejects unknown operation", async () => {
    const res = await callFetch(makeDO(keyEnv()), { op: "nope" })
    expect(res.status).toBe(400)
  })

  it("rejects JSON null", async () => {
    const doObj = makeDO(keyEnv())
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    )
    expect(res.status).toBe(400)
  })

  it("rejects JSON array", async () => {
    const doObj = makeDO(keyEnv())
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      }),
    )
    expect(res.status).toBe(400)
  })

  it("rejects JSON string", async () => {
    const doObj = makeDO(keyEnv())
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '"hi"',
      }),
    )
    expect(res.status).toBe(400)
  })

  it("rejects JSON number", async () => {
    const doObj = makeDO(keyEnv())
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "42",
      }),
    )
    expect(res.status).toBe(400)
  })

  it("rejects body at byte boundary with multi-byte characters", async () => {
    const doObj = makeDO(keyEnv())
    const big = "\u4e00".repeat(5001)
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "readTokens", padding: big }),
      }),
    )
    expect(res.status).toBe(413)
  })

  it("accepts body just under byte boundary with multi-byte characters", async () => {
    const doObj = makeDO(keyEnv())
    const padding = "\u4e00".repeat(3324)
    const body = JSON.stringify({ op: "readTokens", a: padding })
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(10_000)
    const res = await doObj.fetch(
      new Request("https://dummy/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe("TokenVaultDO — encrypted read/write", () => {
  it("writes and reads tokens", async () => {
    const env = keyEnv()
    const doObj = makeDO(env)
    const writeRes = await callFetch(doObj, {
      op: "writeTokens",
      tokens: { access_token: "at", expires_in: 3600, created_at: "now" },
    })
    expect(await writeRes.json()).toEqual({ ok: true })

    const readRes = await callFetch(doObj, { op: "readTokens" })
    const readBody = (await readRes.json()) as { tokens: { access_token: string } }
    expect(readBody.tokens.access_token).toBe("at")
  })

  it("returns null tokens when none stored", async () => {
    const res = await callFetch(makeDO(keyEnv()), { op: "readTokens" })
    expect(await res.json()).toEqual({ tokens: null })
  })

  it("rejects write without access_token", async () => {
    const res = await callFetch(makeDO(keyEnv()), { op: "writeTokens", tokens: { expires_in: 3600 } })
    expect(await res.json()).toEqual({ ok: false })
  })
})

describe("TokenVaultDO — key rotation", () => {
  it("rewrap changes kid and remains decryptable after old key removed", async () => {
    const oldKeyB64 = makeKey()
    const newKeyB64 = makeKey()
    const storage = mockStorage()
    const env = keyEnv("k20260720a", oldKeyB64)
    const ctx = { storage }
    const doObj = new TokenVaultDO(ctx as never, env as never)

    await callFetch(doObj, { op: "writeTokens", tokens: { access_token: "at", expires_in: 3600, created_at: "now" } })

    const read1 = await callFetch(doObj, { op: "readTokens" })
    const body1 = (await read1.json()) as { tokens: { access_token: string } }
    expect(body1.tokens.access_token).toBe("at")

    const env2 = {
      TOKEN_ENCRYPTION_KEY_IDS: "k20260720b,k20260720a",
      TOKEN_ENCRYPTION_KEY_k20260720b: newKeyB64,
      TOKEN_ENCRYPTION_KEY_k20260720a: oldKeyB64,
    } as never
    const doObj2 = new TokenVaultDO(ctx as never, env2 as never)

    const rewrapRes = await callFetch(doObj2, { op: "rewrap" })
    expect(rewrapRes.status).toBe(200)
    expect(await rewrapRes.json()).toEqual({ success: true })

    const envelope = (await storage.get("tokens")) as Envelope
    expect(envelope.kid).toBe("k20260720b")

    const env3 = keyEnv("k20260720b", newKeyB64)
    const doObj3 = new TokenVaultDO(ctx as never, env3 as never)

    const read2 = await callFetch(doObj3, { op: "readTokens" })
    const body2 = (await read2.json()) as { tokens: { access_token: string } }
    expect(body2.tokens.access_token).toBe("at")
  })

  it("returns 500 when no tokens stored", async () => {
    const res = await callFetch(makeDO(keyEnv()), { op: "rewrap" })
    expect(res.status).toBe(500)
  })
})

describe("TokenVaultDO — state consumption", () => {
  it("consumeState returns valid only once", async () => {
    const doObj = makeDO(keyEnv())
    const issueRes = await callFetch(doObj, { op: "issueState" })
    const { state, cookieId } = (await issueRes.json()) as { state: string; cookieId: string }

    const ok1 = await callFetch(doObj, { op: "consumeState", state, cookieId })
    expect(((await ok1.json()) as { valid: boolean }).valid).toBe(true)

    const ok2 = await callFetch(doObj, { op: "consumeState", state, cookieId })
    expect(((await ok2.json()) as { valid: boolean }).valid).toBe(false)
  })

  it("consumeState rejects mismatched cookieId", async () => {
    const doObj = makeDO(keyEnv())
    const issueRes = await callFetch(doObj, { op: "issueState" })
    const { state } = (await issueRes.json()) as { state: string }

    const res = await callFetch(doObj, { op: "consumeState", state, cookieId: "wrong" })
    expect(((await res.json()) as { valid: boolean }).valid).toBe(false)
  })

  it("consumeState rejects expired state", async () => {
    const origDateNow = Date.now
    const now = Date.now()
    try {
      Date.now = () => now
      const doObj = makeDO(keyEnv())
      const issueRes = await callFetch(doObj, { op: "issueState" })
      const { state, cookieId } = (await issueRes.json()) as { state: string; cookieId: string }

      Date.now = () => now + 10 * 60 * 1000 + 1

      const res = await callFetch(doObj, { op: "consumeState", state, cookieId })
      expect(((await res.json()) as { valid: boolean }).valid).toBe(false)
    } finally {
      Date.now = origDateNow
    }
  })

  it("alarm sweep removes expired states and reschedules for earliest live", async () => {
    const now = 1_000_000_000_000
    const origDateNow = Date.now
    try {
      Date.now = () => now

      const storage = mockStorage()
      const env = keyEnv()
      const doObj = new TokenVaultDO({ storage } as never, env as never)

      const s1 = await callFetch(doObj, { op: "issueState" })
      const { state: state1 } = (await s1.json()) as { state: string; cookieId: string }
      const s2 = await callFetch(doObj, { op: "issueState" })
      const { state: state2 } = (await s2.json()) as { state: string }

      Date.now = () => now + 3 * 60 * 1000

      const s3 = await callFetch(doObj, { op: "issueState" })
      const { state: state3, cookieId: cookie3 } = (await s3.json()) as { state: string; cookieId: string }

      Date.now = () => now + 6 * 60 * 1000

      await doObj.alarm()

      Date.now = () => now + 6 * 60 * 1000

      const entries = await storage.list({ prefix: "state:" })
      expect(entries.has(`state:${state1}`)).toBe(false)
      expect(entries.has(`state:${state2}`)).toBe(false)
      expect(entries.has(`state:${state3}`)).toBe(true)

      const alarmTime = await storage.getAlarm()
      expect(alarmTime).toBe(now + 6 * 60 * 1000 + 2 * 60 * 1000)

      const ok = await callFetch(doObj, { op: "consumeState", state: state3, cookieId: cookie3 })
      expect(((await ok.json()) as { valid: boolean }).valid).toBe(true)
    } finally {
      Date.now = origDateNow
    }
  })
})
