import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createOAuthHandler, encryptedStore, SCOPES } from "./oauth.mjs"

const origin = "https://spike.example.test"
const tokens = { access_token: "fake-access", refresh_token: "fake-refresh", token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") }

/** Creates a fake-provider handler while preserving real PKCE, state, cookie and consumption logic. */
function fixture() {
  let clock = 1000
  const exchanges = []
  const saved = []
  const handler = createOAuthHandler({
    origin, clientId: "client", clientSecret: "secret", bootstrap: "bootstrap",
    now: () => clock, store: { write: async grant => saved.push(grant) },
    fetchImpl: async (url, request) => { exchanges.push({ url, request }); return Response.json(tokens) },
  })
  return {
    handler, saved, exchanges, advance: ms => { clock += ms },
    async start() {
      const response = await handler(new Request(origin + "/setup/buffer?start=bootstrap"))
      assert.equal(response.status, 302)
      return { auth: new URL(response.headers.get("location")), cookie: response.headers.get("set-cookie").split(";")[0] }
    },
  }
}

test("requires setup capability, exact HTTPS origin, and a GET request", async () => {
  const f = fixture()
  assert.equal((await f.handler(new Request(origin + "/setup/buffer"))).status, 403)
  assert.equal((await f.handler(new Request("https://other.example.test/setup/buffer?start=bootstrap"))).status, 400)
  assert.equal((await f.handler(new Request(origin + "/setup/buffer?start=bootstrap", { method: "POST" }))).status, 405)
  assert.equal(f.exchanges.length, 0)
})

test("rejects missing/wrong cookie, state and expired callbacks without token exchange", async () => {
  const f = fixture()
  const { auth, cookie } = await f.start()
  const callback = origin + "/auth/buffer/callback?code=fake-code&state=" + auth.searchParams.get("state")
  assert.equal((await f.handler(new Request(callback))).status, 403)
  assert.equal((await f.handler(new Request(callback, { headers: { cookie: "kipp-buffer-spike=wrong" } }))).status, 403)
  assert.equal((await f.handler(new Request(callback.replace(auth.searchParams.get("state"), "wrong"), { headers: { cookie } }))).status, 403)
  f.advance(300_000)
  assert.equal((await f.handler(new Request(callback, { headers: { cookie } }))).status, 403)
  assert.equal(f.exchanges.length, 0)
})

test("exchanges once with PKCE, persists grant before returning, and never exposes tokens", async () => {
  const f = fixture()
  const { auth, cookie } = await f.start()
  const callback = origin + "/auth/buffer/callback?code=fake-code&state=" + auth.searchParams.get("state")
  const request = () => new Request(callback, { headers: { cookie } })
  const responses = await Promise.all([f.handler(request()), f.handler(request())])
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 403])
  assert.equal(f.exchanges.length, 1)
  const form = f.exchanges[0].request.body
  assert.equal(form.get("redirect_uri"), origin + "/auth/buffer/callback")
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), auth.searchParams.get("code_challenge"))
  assert.equal(f.saved.length, 1)
  assert.equal(f.saved[0].expiresAtMs, 3_601_000)
  for (const response of responses) {
    const text = await response.text()
    assert.ok(!text.includes("fake-access") && !text.includes("fake-refresh"))
    assert.equal(response.headers.get("referrer-policy"), "no-referrer")
  }
})

test("denial consumes state, and an incomplete grant is never persisted", async () => {
  const f = fixture()
  const { auth, cookie } = await f.start()
  const state = auth.searchParams.get("state")
  assert.equal((await f.handler(new Request(origin + `/auth/buffer/callback?error=access_denied&state=${state}`, { headers: { cookie } }))).status, 400)
  assert.equal((await f.handler(new Request(origin + `/auth/buffer/callback?code=fake&state=${state}`, { headers: { cookie } }))).status, 403)
  assert.equal(f.exchanges.length, 0)
  let writes = 0
  const handler = createOAuthHandler({ origin, clientId: "c", clientSecret: "s", bootstrap: "b", store: { write: async () => { writes++ } }, fetchImpl: async () => Response.json({ ...tokens, scope: "account:read" }) })
  const started = await handler(new Request(origin + "/setup/buffer?start=b"))
  const u = new URL(started.headers.get("location"))
  const response = await handler(new Request(origin + "/auth/buffer/callback?code=fake&state=" + u.searchParams.get("state"), { headers: { cookie: started.headers.get("set-cookie").split(";")[0] } }))
  assert.equal(response.status, 502)
  assert.equal(writes, 0)
})

test("encrypted grant files round-trip without plaintext credentials and use owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kipp-buffer-oauth-check-"))
  try {
    const store = await encryptedStore(directory)
    await store.write(tokens)
    assert.deepEqual(await store.read(), tokens)
    const bytes = await readFile(join(directory, "grant.enc"))
    assert.ok(!bytes.includes(Buffer.from(tokens.access_token)))
    assert.ok(!bytes.includes(Buffer.from(tokens.refresh_token)))
    assert.equal((await stat(join(directory, "grant.enc"))).mode & 0o777, 0o600)
    await store.write({ ...tokens, refresh_token: "replacement" })
    assert.equal((await store.read()).refresh_token, "replacement")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
