import { afterEach, expect, it, vi } from "vitest"
import { handleBufferAuthCallback, handleBufferAuthStart } from "../triggers/buffer-auth"
import { bufferHarness, tokenResponse } from "./helpers/buffer-vault"

const discoveredChannel = {
  id: "substack-one",
  organizationId: "org-one",
  name: "Author",
  service: "substack",
  allowedActions: ["scheduleUpdates"],
  isDisconnected: false,
  isLocked: false,
  isQueuePaused: false,
}
afterEach(() => vi.unstubAllGlobals())
async function setup() {
  const h = bufferHarness()
  const start = await handleBufferAuthStart(new Request("https://attacker.test/setup/buffer"), h.env)
  const location = new URL(start.headers.get("Location") ?? "")
  const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? ""
  const callback = (state = location.searchParams.get("state"), cookies = cookie, extra = "code=one-time-code") =>
    new Request(`https://kipp.test/auth/buffer/callback?state=${state}&${extra}`, { headers: { cookie: cookies } })
  return { ...h, start, location, callback }
}
it("requires setup access for both routes and reports incomplete configuration", async () => {
  const h = bufferHarness()
  const env = { ...h.env, ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "false" }
  expect((await handleBufferAuthStart(new Request("https://kipp.test/setup/buffer"), env)).status).toBe(403)
  expect((await handleBufferAuthCallback(new Request("https://kipp.test/auth/buffer/callback"), env)).status).toBe(403)
  expect(
    (
      await handleBufferAuthStart(new Request("https://kipp.test/setup/buffer"), {
        ...h.env,
        BUFFER_REDIRECT_ORIGIN: undefined,
      })
    ).status,
  ).toBe(503)
})
it("uses fixed callback, S256 PKCE and secure five-minute cookie", async () => {
  const h = await setup()
  expect(h.location.origin).toBe("https://auth.buffer.com")
  expect(h.location.searchParams.get("redirect_uri")).toBe("https://kipp.test/auth/buffer/callback")
  expect(h.location.searchParams.get("code_challenge_method")).toBe("S256")
  expect(h.start.headers.get("Set-Cookie")).toContain("Secure; HttpOnly; SameSite=Lax")
  expect(h.start.headers.get("Set-Cookie")).toContain("Max-Age=300")
  expect(h.location.searchParams.has("code_verifier")).toBe(false)
})
it("rejects absent/wrong state or cookie without network exchange", async () => {
  const h = await setup()
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  for (const request of [
    h.callback("wrong"),
    h.callback(undefined, ""),
    h.callback(undefined, "buffer-oauth-session=wrong"),
  ])
    expect((await handleBufferAuthCallback(request, h.env)).status).toBe(400)
  expect(fetch).not.toHaveBeenCalled()
})
it("exchanges once with verifier, saves verified identity, lists manual channel ID and never returns credentials", async () => {
  const h = await setup()
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(
      Response.json({ data: { account: { id: "account-one", organizations: [{ id: "org-one" }] } } }),
    )
    .mockResolvedValueOnce(Response.json({ data: { channels: [discoveredChannel] } }))
  vi.stubGlobal("fetch", fetch)
  const response = await handleBufferAuthCallback(h.callback(), h.env)
  const text = await response.text()
  expect(response.status).toBe(200)
  expect(text).toContain("Author: substack-one")
  expect(text).toContain("BUFFER_SUBSTACK_CHANNEL_ID")
  expect(text).not.toContain("access-new")
  expect(text).not.toContain("refresh-new")
  expect(fetch.mock.calls[0][1].body.get("code_verifier")).toBeTruthy()
  expect(await h.command("acquireBufferAccess")).toMatchObject({ kind: "usable", accountId: "account-one" })
  expect((await handleBufferAuthCallback(h.callback(), h.env)).status).toBe(400)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0")
})
it("consumes state on failed exchange; a retry must start a new consent", async () => {
  const h = await setup()
  const fetch = vi.fn(async () => new Response("provider-secret", { status: 400 }))
  vi.stubGlobal("fetch", fetch)
  const response = await handleBufferAuthCallback(h.callback(), h.env)
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("provider-secret")
  expect((await handleBufferAuthCallback(h.callback(), h.env)).status).toBe(400)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it("rejects missing granted scopes before account lookup or persistence", async () => {
  const h = await setup()
  const fetch = vi.fn(async () => tokenResponse({ scope: "account:read" }))
  vi.stubGlobal("fetch", fetch)
  expect((await handleBufferAuthCallback(h.callback(), h.env)).status).toBe(502)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await h.command("acquireBufferAccess")).toMatchObject({ kind: "needs-auth" })
})
