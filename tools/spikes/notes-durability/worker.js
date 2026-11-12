import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers"

// Isolated protocol prototype, deliberately not a production Buffer client.
export class Evidence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, body TEXT NOT NULL)")
  }
  read(key) {
    const row = this.ctx.storage.sql.exec("SELECT body FROM records WHERE key = ?", key).toArray()[0]
    return row ? JSON.parse(row.body) : null
  }
  write(key, value) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO records VALUES (?, ?)", key, JSON.stringify(value))
  }
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.json() : {}
    if (url.pathname === "/state")
      return Response.json(this.read(body.key || url.searchParams.get("key") || "publication"))
    if (url.pathname === "/prepare") {
      if (body.approval !== "owner:42:version:1:fingerprint:A") return new Response("denied", { status: 403 })
      const existing = this.read("publication")
      if (!existing) this.write("publication", { state: "prepared", fingerprint: "A" })
      return Response.json(existing || this.read("publication"))
    }
    if (url.pathname === "/execute") {
      const current = this.read("publication")
      if (!current) return new Response("approval required", { status: 403 })
      if (current.state !== "prepared") return Response.json(current)
      // Synchronous SQL claim precedes any await: concurrent handlers cannot both dispatch.
      this.write("publication", { ...current, state: "dispatching" })
      if (body.fault === "claim") return Response.json({ state: "interrupted" })
      const result = await (await fetch("https://fake-provider/create", { method: "POST" })).json()
      if (body.fault === "accepted") return Response.json({ state: "interrupted" })
      this.write("publication", { ...current, state: "accepted", postId: result.id })
      return Response.json(this.read("publication"))
    }
    if (url.pathname === "/refresh") {
      const current = this.read("refresh") || { state: "ready", generation: 1, token: "fake-refresh-1" }
      if (current.state === "refreshing" && !this.refreshRunning) {
        this.write("refresh", { ...current, state: "needs-auth" })
        return Response.json(this.read("refresh"))
      }
      if (current.state !== "ready") return Response.json(current)
      this.write("refresh", { state: "refreshing", generation: current.generation })
      if (body.fault === "claim") return Response.json({ state: "interrupted" })
      this.refreshRunning = true
      const result = await (
        await fetch("https://fake-provider/refresh", { method: "POST", body: current.token })
      ).json()
      this.refreshRunning = false
      if (body.fault === "rotated") return Response.json({ state: "interrupted" })
      const latest = this.read("refresh")
      if (latest.generation !== current.generation || latest.state !== "refreshing") return Response.json(latest)
      this.write("refresh", { state: "ready", generation: current.generation + 1, token: result.refresh_token })
      return Response.json(this.read("refresh"))
    }
    if (url.pathname === "/replace-grant") {
      const generation = (this.read("refresh")?.generation || 0) + 1
      this.write("refresh", { state: "ready", generation, token: "fake-new-grant" })
      return Response.json(this.read("refresh"))
    }
    if (url.pathname === "/consume") {
      const key = `delivery:${body.updateId}`
      if (body.owner !== 42 || body.version !== 1 || body.action !== "approve")
        return new Response("denied", { status: 403 })
      const retained = this.read(key)
      if (retained) return Response.json(retained)
      const pendingId = this.read("interaction-consumed")
      if (pendingId) {
        const pending = this.read(pendingId)
        return pending && !pending.acknowledged ? Response.json(pending) : new Response("consumed", { status: 409 })
      }
      const event = {
        deliveryId: key,
        owner: body.owner,
        version: body.version,
        action: body.action,
        acknowledged: false,
      }
      this.ctx.storage.transactionSync(() => {
        this.write(key, event)
        this.write("interaction-consumed", key)
      })
      return Response.json(event)
    }
    if (url.pathname === "/apply") {
      const retained = this.read(body.deliveryId)
      if (!retained || retained.owner !== 42 || retained.version !== 1) return new Response("denied", { status: 403 })
      if (!this.read("effect")) this.write("effect", { deliveryId: body.deliveryId, count: 1 })
      return Response.json(this.read("effect"))
    }
    if (url.pathname === "/ack") {
      const retained = this.read(body.deliveryId)
      if (!retained) return new Response("missing", { status: 404 })
      this.write(body.deliveryId, { ...retained, acknowledged: true })
      return Response.json(this.read(body.deliveryId))
    }
    return new Response("not found", { status: 404 })
  }
}

export class Dispatch extends WorkflowEntrypoint {
  async run(event, step) {
    const stub = this.env.EVIDENCE.get(this.env.EVIDENCE.idFromName(event.payload.objectId))
    return step.do("guarded-create", { retries: { limit: 2, delay: "1 second", backoff: "constant" } }, async () => {
      const result = await (await stub.fetch("http://evidence/execute", { method: "POST", body: "{}" })).json()
      if (!this.env.RECOVERING) {
        await fetch("https://fake-provider/checkpoint", { method: "POST" })
        throw new Error("Injected checkpoint loss after durable acceptance")
      }
      return result
    })
  }
}

export class Delivery extends WorkflowEntrypoint {
  async run(event, step) {
    const incoming = await step.waitForEvent("approval", { type: "approval", timeout: "1 hour" })
    return step.do("apply-once", async () => {
      const stub = this.env.EVIDENCE.get(this.env.EVIDENCE.idFromName(event.payload.objectId))
      return (
        await stub.fetch("http://evidence/apply", { method: "POST", body: JSON.stringify(incoming.payload) })
      ).json()
    })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const objectId = url.searchParams.get("id") || "probe"
    if (url.pathname.startsWith("/do/")) {
      const stub = env.EVIDENCE.get(env.EVIDENCE.idFromName(objectId))
      return stub.fetch(new Request(`http://evidence/${url.pathname.slice(4)}${url.search}`, request))
    }
    const binding = url.searchParams.get("kind") === "delivery" ? env.DELIVERY : env.DISPATCH
    if (url.pathname === "/start") {
      await binding.create({ id: objectId, params: { objectId } })
      return Response.json({ ok: true })
    }
    const instance = await binding.get(objectId)
    if (url.pathname === "/pause") await instance.pause()
    if (url.pathname === "/resume") await instance.resume()
    if (url.pathname === "/send") await instance.sendEvent({ type: "approval", payload: await request.json() })
    return Response.json(await instance.status())
  },
}
