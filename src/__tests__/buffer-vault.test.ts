import { afterEach, describe, expect, it, vi } from "vitest"
import { base64urlEncode } from "../core/crypto"
import type { BufferAccess } from "../core/types"
import { bufferHarness, deferred, grant, tokenResponse } from "./helpers/buffer-vault"

afterEach(() => vi.unstubAllGlobals())

describe("Buffer encrypted vault", () => {
  it("encrypts state/verifier, enforces cookie, consumes once concurrently and expires at five minutes", async () => {
    const h = bufferHarness()
    const state = await h.command<{ state: string; cookieId: string; challenge: string }>("issueBufferState")
    expect(JSON.stringify([...h.entries])).not.toContain("verifier")
    expect(await h.command("consumeBufferState", { ...state, cookieId: "wrong" })).toEqual({ valid: false })
    const consumed = await Promise.all([h.command("consumeBufferState", state), h.command("consumeBufferState", state)])
    expect(consumed.filter((x) => x.valid)).toHaveLength(1)
    const valid = consumed.find((x) => x.valid) as { verifier: string; redirectUri: string }
    expect(valid.redirectUri).toBe("https://kipp.test/auth/buffer/callback")
    expect(
      base64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(valid.verifier)))),
    ).toBe(state.challenge)
    const expired = await h.command<{ state: string; cookieId: string }>("issueBufferState")
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_000)
    expect(await h.command("consumeBufferState", expired)).toEqual({ valid: false })
    await h.restart()
    now.mockRestore()
  })
  it("disallows generic Buffer read/write/state operations", async () => {
    const h = bufferHarness()
    for (const op of ["readTokens", "writeTokens", "issueState", "consumeState"])
      await expect(h.command(op, { provider: "buffer", tokens: { access_token: "bypass" } })).rejects.toThrow("400")
  })
  it("returns usable access without exposing refresh credentials and preserves other provider storage", async () => {
    const h = bufferHarness()
    await h.command("writeTokens", { tokens: { access_token: "linkedin" } })
    await h.command("writeTokens", { provider: "google-calendar", tokens: { access_token: "calendar" } })
    await h.command("replaceBufferGrant", { grant: grant({ expiresAtMs: Date.now() + 3600_000 }) })
    const access = await h.command("acquireBufferAccess")
    expect(access).toMatchObject({ kind: "usable", accessToken: "access-old", credentialGeneration: 1 })
    expect(access).not.toHaveProperty("refreshToken")
    expect(JSON.stringify([...h.entries])).not.toContain("access-old")
    expect(await h.command("readTokens")).toEqual({ tokens: { access_token: "linkedin" } })
    expect(await h.command("readTokens", { provider: "google-calendar" })).toEqual({
      tokens: { access_token: "calendar" },
    })
    expect(await h.command("rewrapBuffer")).toEqual({ success: true })
  })
  it("joins concurrent refreshes, persists both rotated tokens, and does not block other providers", async () => {
    const h = bufferHarness()
    await h.command("replaceBufferGrant", { grant: grant() })
    const response = deferred<Response>()
    const entered = deferred<void>()
    const requests: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        requests.push(options.body.toString())
        entered.resolve()
        return response.promise
      }),
    )
    const first = h.command("acquireBufferAccess")
    await entered.promise
    const second = h.command("acquireBufferAccess")
    expect(await h.command("readTokens")).toEqual({ tokens: null })
    response.resolve(tokenResponse())
    expect(await first).toEqual(await second)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("refresh_token=refresh-old")
    h.restart()
    expect(await h.command("acquireBufferAccess")).toMatchObject({ accessToken: "access-new", credentialGeneration: 2 })
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600_000)
    try {
      await h.command("acquireBufferAccess")
      expect(requests).toHaveLength(2)
      expect(requests[1]).toContain("refresh_token=refresh-new")
      expect(requests[1]).not.toContain("refresh_token=refresh-old")
    } finally {
      clock.mockRestore()
    }
  })
  it("never reuses a refresh token after uncertain response or cold restart with claim", async () => {
    const h = bufferHarness()
    await h.command("replaceBufferGrant", { grant: grant() })
    const response = deferred<Response>()
    const entered = deferred<void>()
    const fetch = vi.fn(async () => {
      entered.resolve()
      return response.promise
    })
    vi.stubGlobal("fetch", fetch)
    const active = h.command("acquireBufferAccess")
    await entered.promise
    h.restart()
    expect(await h.command("acquireBufferAccess")).toMatchObject({ kind: "needs-auth" })
    response.resolve(new Response("revoked", { status: 400 }))
    expect(await active).toMatchObject({ kind: "needs-auth" })
    expect(await h.command("acquireBufferAccess")).toMatchObject({ kind: "needs-auth" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(["account-one", "account-two"])("fences late refresh after newer OAuth grant for %s", async (accountId) => {
    const h = bufferHarness()
    await h.command("replaceBufferGrant", { grant: grant({ expiresAtMs: Date.now() + 3600_000 }) })
    const initial = await h.command<Extract<BufferAccess, { kind: "usable" }>>("acquireBufferAccess")
    await h.command("replaceBufferGrant", { grant: grant() })
    const response = deferred<Response>()
    const entered = deferred<void>()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        entered.resolve()
        return response.promise
      }),
    )
    const pending = h.command("acquireBufferAccess")
    await entered.promise
    await h.command("replaceBufferGrant", {
      grant: grant({ accountId, accessToken: "reauthorized", expiresAtMs: Date.now() + 3600_000 }),
    })
    response.resolve(tokenResponse())
    const result = await pending
    expect(result).toMatchObject({ accessToken: "reauthorized", accountId, credentialGeneration: 3 })
    expect(result.connectionId === initial.connectionId).toBe(accountId === "account-one")
  })
  it("retains the durable claim if storing rotated tokens fails", async () => {
    const h = bufferHarness()
    await h.command("replaceBufferGrant", { grant: grant() })
    const put = h.storage.put
    let writes = 0
    h.storage.put = async (...args) => {
      if (++writes === 2) throw new Error("storage failed")
      return put(...args)
    }
    const fetch = vi.fn(async () => tokenResponse())
    vi.stubGlobal("fetch", fetch)
    await expect(h.command("acquireBufferAccess")).rejects.toThrow("500")
    h.restart()
    expect(await h.command("acquireBufferAccess")).toMatchObject({ kind: "needs-auth" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("rejects incomplete scopes and missing credentials without storing grants", async () => {
    const h = bufferHarness()
    await expect(h.command("replaceBufferGrant", { grant: grant({ scopes: ["account:read"] }) })).rejects.toThrow("400")
    expect(await h.command("acquireBufferAccess")).toMatchObject({ kind: "needs-auth" })
  })
})
