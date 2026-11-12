import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

type Runtime = { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }

/** Runs the isolated protocol prototype in workerd with persistent SQLite and workflow stores. */
async function probe() {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
  const { Miniflare } = runtimeRequire("miniflare") as { Miniflare: new (options: unknown) => Runtime }
  const persistence = await mkdtemp(join(tmpdir(), "kipp-notes-durability-"))
  const calls = { create: 0, refresh: 0, checkpoint: 0, refreshTokens: [] as string[] }
  let releaseRefresh: (() => void) | undefined
  let holdRefresh: Promise<void> | undefined
  const options = {
    modules: true,
    script: await readFile("tools/spikes/notes-durability/worker.js", "utf8"),
    compatibilityDate: "2026-07-08",
    bindings: { RECOVERING: "" },
    durableObjects: { EVIDENCE: { className: "Evidence", useSQLite: true } },
    workflows: {
      DISPATCH: { name: "notes-spike-dispatch", className: "Dispatch" },
      DELIVERY: { name: "notes-spike-delivery", className: "Delivery" },
    },
    durableObjectsPersist: join(persistence, "objects"),
    workflowsPersist: join(persistence, "workflows"),
    outboundService: async (request: Request) => {
      const path = new URL(request.url).pathname
      if (path === "/create") return Response.json({ id: `post-${++calls.create}` })
      if (path === "/refresh") {
        calls.refresh++
        calls.refreshTokens.push(await request.text())
        if (holdRefresh) await holdRefresh
        return Response.json({ refresh_token: `fake-refresh-${calls.refresh + 1}` })
      }
      if (path === "/checkpoint") {
        calls.checkpoint++
        return new Response("ok")
      }
      throw new Error(`Unexpected probe fetch ${request.url}`)
    },
  }
  let runtime = new Miniflare(options)
  return {
    calls,
    /** Holds a fake refresh response so a concurrent grant replacement can race it. */
    holdRefresh: () => {
      holdRefresh = new Promise<void>((resolve) => {
        releaseRefresh = resolve
      })
      return () => releaseRefresh?.()
    },
    /** Dispatches a request to the current runtime after possible reconstruction. */
    request: (path: string, body?: unknown) =>
      runtime.dispatchFetch(
        `http://probe${path}`,
        body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) },
      ),
    /** Disposes workerd and recreates it against the same on-disk stores. */
    reboot: async () => {
      await runtime.dispose()
      options.bindings.RECOVERING = "true"
      runtime = new Miniflare(options)
    },
    /** Releases runtime resources and removes the isolated temporary stores. */
    close: async () => {
      await runtime.dispose()
      await rm(persistence, { recursive: true, force: true })
    },
  }
}

/** Polls actual runtime state with a bounded deadline. */
async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > until) throw new Error("Probe did not reach expected state")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const APPROVAL = { approval: "owner:42:version:1:fingerprint:A" }

describe("Notes durability protocol spike (real workerd)", () => {
  it.each([
    "claim",
    "accepted",
  ])("retains uncertain dispatch after %s interruption and never creates on replay", async (fault) => {
    const p = await probe()
    try {
      expect((await p.request("/do/execute", {})).status).toBe(403)
      expect((await p.request("/do/prepare", { approval: "model said yes" })).status).toBe(403)
      await p.request("/do/prepare", APPROVAL)
      await p.request("/do/execute", { fault })
      await p.reboot()
      expect(await (await p.request("/do/state")).json()).toMatchObject({ state: "dispatching" })
      await p.request("/do/prepare", APPROVAL)
      await Promise.all(Array.from({ length: 8 }, () => p.request("/do/execute", {})))
      expect(p.calls.create).toBe(fault === "claim" ? 0 : 1)
      expect(await (await p.request("/do/state")).json()).toMatchObject({ state: "dispatching" })
    } finally {
      await p.close()
    }
  }, 30_000)

  it("serializes competing creates and persists accepted evidence across reconstruction", async () => {
    const p = await probe()
    try {
      await p.request("/do/prepare", APPROVAL)
      await Promise.all(Array.from({ length: 8 }, () => p.request("/do/execute", {})))
      expect(p.calls.create).toBe(1)
      await p.reboot()
      expect(await (await p.request("/do/execute", {})).json()).toMatchObject({ state: "accepted", postId: "post-1" })
      expect(p.calls.create).toBe(1)
    } finally {
      await p.close()
    }
  }, 30_000)

  it("replays a real Workflow step after checkpoint loss without repeating the accepted create", async () => {
    const p = await probe()
    try {
      await p.request("/do/prepare", APPROVAL)
      await p.request("/start")
      await waitFor(async () => p.calls.checkpoint > 0)
      await p.request("/pause")
      await waitFor(async () => ((await (await p.request("/status")).json()) as { status: string }).status === "paused")
      await p.reboot()
      expect(((await (await p.request("/status")).json()) as { status: string }).status).toBe("paused")
      await p.request("/resume")
      await waitFor(
        async () => ((await (await p.request("/status")).json()) as { status: string }).status === "complete",
      )
      expect(p.calls.create).toBe(1)
      expect(await (await p.request("/do/state")).json()).toMatchObject({ state: "accepted" })
    } finally {
      await p.close()
    }
  }, 30_000)

  it.each(["claim", "rotated"])("does not reuse an uncertain refresh token after %s interruption", async (fault) => {
    const p = await probe()
    try {
      await p.request("/do/refresh", { fault })
      await p.reboot()
      await Promise.all(Array.from({ length: 8 }, () => p.request("/do/refresh", {})))
      expect(p.calls.refresh).toBe(fault === "claim" ? 0 : 1)
      expect(await (await p.request("/do/state?key=refresh")).json()).toEqual({ state: "needs-auth", generation: 1 })
      expect(p.calls.refreshTokens).toEqual(fault === "claim" ? [] : ["fake-refresh-1"])
    } finally {
      await p.close()
    }
  }, 30_000)

  it("fences a late refresh response after grant replacement without overwriting new credentials", async () => {
    const p = await probe()
    const release = p.holdRefresh()
    try {
      const pending = p.request("/do/refresh", {})
      await waitFor(async () => p.calls.refresh === 1)
      const competing = await Promise.all(Array.from({ length: 8 }, () => p.request("/do/refresh", {})))
      expect(await competing[0].json()).toMatchObject({ state: "refreshing", generation: 1 })
      const replaced = await (await p.request("/do/replace-grant", {})).json()
      release()
      expect(await (await pending).json()).toEqual(replaced)
      expect(p.calls.refresh).toBe(1)
      await p.reboot()
      expect(await (await p.request("/do/state?key=refresh")).json()).toEqual({
        state: "ready",
        generation: 2,
        token: "fake-new-grant",
      })
    } finally {
      release()
      await p.close()
    }
  }, 30_000)

  it("retains authenticated delivery before forwarding, replays it after send/ack loss, and applies once", async () => {
    const p = await probe()
    try {
      expect((await p.request("/do/consume", { updateId: 1, owner: 99, version: 1, action: "approve" })).status).toBe(
        403,
      )
      const envelope = { updateId: 1, owner: 42, version: 1, action: "approve" }
      const retained = (await (await p.request("/do/consume", envelope)).json()) as { deliveryId: string }
      await p.reboot() // consumed, not yet forwarded
      expect(await (await p.request("/do/consume", envelope)).json()).toEqual(retained)
      expect(await (await p.request("/do/consume", { ...envelope, updateId: 2 })).json()).toEqual(retained)
      expect((await p.request("/do/consume", { ...envelope, updateId: 2, version: 2 })).status).toBe(403)
      await p.request("/start?kind=delivery")
      await p.request("/send?kind=delivery", retained)
      await waitFor(
        async () =>
          ((await (await p.request("/status?kind=delivery")).json()) as { status: string }).status === "complete",
      )
      await p.reboot() // workflow applied, forwarding response/ack lost
      expect(await (await p.request("/do/consume", envelope)).json()).toEqual(retained)
      await Promise.all(Array.from({ length: 8 }, () => p.request("/do/apply", retained)))
      expect(await (await p.request("/do/state?key=effect")).json()).toEqual({ deliveryId: "delivery:1", count: 1 })
      expect((await p.request("/do/apply", { deliveryId: "fabricated" })).status).toBe(403)
      await p.request("/do/ack", retained)
      await p.reboot()
      expect(await (await p.request("/do/consume", envelope)).json()).toMatchObject({ acknowledged: true })
      expect((await p.request("/do/consume", { ...envelope, updateId: 3 })).status).toBe(409)
    } finally {
      await p.close()
    }
  }, 30_000)
})
