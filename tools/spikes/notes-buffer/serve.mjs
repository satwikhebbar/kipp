import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { join } from "node:path"
import { createOAuthHandler, encryptedStore } from "./oauth.mjs"

const vars = parseEnv(await readFile(".dev.vars", "utf8"))
if (!vars.BUFFER_CLIENT_ID?.trim() || !vars.BUFFER_CLIENT_SECRET?.trim()) throw Error("BUFFER_CLIENT_ID and BUFFER_CLIENT_SECRET are required in .dev.vars")
const config = await readFile("wrangler.local.toml", "utf8")
const origin = process.env.BUFFER_SPIKE_ORIGIN || config.match(/^MINI_APP_ORIGIN\s*=\s*"([^"]+)"/m)?.[1]
if (!origin) throw Error("Configure an HTTPS spike origin")
const directory = ".wrangler/notes-buffer-spike"
const store = await encryptedStore(directory)
const bootstrap = randomBytes(32).toString("base64url")

/** Makes a read-only GraphQL call without printing provider bodies or authorization material. */
async function query(token, document, variables = {}) {
  const response = await fetch("https://api.buffer.com", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
  })
  if (!response.ok) throw Error("Buffer discovery HTTP failure")
  const data = await response.json()
  if (data.errors || !data.data) throw Error("Buffer discovery GraphQL failure")
  return data.data
}

const handle = createOAuthHandler({
  origin, clientId: vars.BUFFER_CLIENT_ID.trim(), clientSecret: vars.BUFFER_CLIENT_SECRET.trim(), bootstrap, store,
  onFailure: kind => console.log(`Buffer spike: ${kind}`),
  async onConnected(grant) {
    const { account } = await query(grant.access_token, "query KippSpikeIdentity { account { id organizations { id } } }")
    if (!account?.id || !Array.isArray(account.organizations)) throw Error("Invalid account")
    const channels = []
    for (const org of account.organizations) {
      const found = await query(grant.access_token, "query KippSpikeChannels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id organizationId service name allowedActions isDisconnected isLocked isQueuePaused } }", { organizationId: org.id })
      if (!Array.isArray(found.channels)) throw Error("Invalid channel list")
      channels.push(...found.channels.filter(x => x.service === "substack").map(x => ({ id: x.id, organizationId: x.organizationId, service: x.service, name: x.name, allowedActions: x.allowedActions, isDisconnected: x.isDisconnected, isLocked: x.isLocked, isQueuePaused: x.isQueuePaused })))
    }
    const evidence = { connectedAt: new Date().toISOString(), accountId: account.id, scopes: grant.scopes, expiresAtMs: grant.expiresAtMs, refreshTokenPresent: Boolean(grant.refresh_token), substackChannels: channels }
    await writeFile(join(directory, "discovery.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 })
    console.log(`Buffer connected; read-only discovery found ${channels.length} Substack channel(s).`)
  },
})

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host
    const requestOrigin = host === "127.0.0.1:8787" || host === "localhost:8787" ? `http://${host}` : origin
    const request = new Request(new URL(req.url || "/", requestOrigin), { method: req.method, headers: req.headers })
    const response = await handle(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(await response.text())
  } catch {
    res.writeHead(500, { "Cache-Control": "no-store" })
    res.end("Buffer spike request failed")
  }
})
server.listen(8787, "127.0.0.1", () => {
  console.log("Local Buffer OAuth spike ready on 127.0.0.1:8787 (no request logging).")
  console.log(`Authorize: ${origin}/setup/buffer?start=${bootstrap}`)
})
