import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import type { Env } from "../core/types"
import { BufferPublicationDO } from "../integrations/buffer/publication"
import { fingerprintCommand } from "../notes/review"
import type { ApprovedPublication, BufferCreateCommand } from "../notes/types"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const command: BufferCreateCommand = {
  destination: {
    accountId: "account",
    connectionId: "connection",
    organizationId: "org",
    channelId: "channel",
    service: "substack",
  },
  text: "Keep the exact thought.",
  attachmentUrl: null,
  timing: { kind: "now" },
}

async function fixture() {
  const db = new DatabaseSync(":memory:")
  let failSync = false
  const storage = {
    sql: {
      exec: (sql: string, ...args: Array<string | number | null>) => {
        const statement = db.prepare(sql)
        if (statement.columns().length) return { toArray: () => statement.all(...args) }
        statement.run(...args)
        return { toArray: () => [] }
      },
    },
    sync: async () => {
      if (failSync) throw new Error("storage failed")
    },
    transactionSync: (fn: () => unknown) => {
      db.exec("BEGIN")
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
  }
  const ctx = { storage } as unknown as DurableObjectState
  let accountId = "account"
  let connectionId = "connection"
  let usable = true
  const env = {
    BUFFER_SUBSTACK_CHANNEL_ID: "channel",
    TOKEN_VAULT: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async () =>
          Response.json(
            usable
              ? { kind: "usable", accessToken: "synthetic", accountId, connectionId, credentialGeneration: 1 }
              : { kind: "needs-auth", reason: "test" },
          ),
      }),
    },
  } as unknown as Env
  let guard = new BufferPublicationDO(ctx, env)
  let writes = 0
  let reads = 0
  let create: () => Promise<Response> = async () =>
    Response.json({ data: { createPost: { __typename: "PostActionSuccess", post: post() } } })
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.query.includes("KippIdentity"))
      return Response.json({ data: { account: { id: accountId, organizations: [{ id: "org" }] } } })
    if (body.query.includes("KippChannels"))
      return Response.json({
        data: {
          channels: [
            {
              id: "channel",
              organizationId: "org",
              service: "substack",
              name: "test",
              allowedActions: ["scheduleUpdates"],
              isDisconnected: false,
              isLocked: false,
              isQueuePaused: false,
            },
          ],
        },
      })
    if (body.query.includes("KippInspectPost")) {
      reads++
      return Response.json({ data: { post: post() } })
    }
    writes++
    const record = JSON.parse(
      (db.prepare("SELECT record_json FROM publication").get() as { record_json: string }).record_json,
    )
    expect(record.phase).toBe("dispatching")
    expect(db.prepare("SELECT state FROM attempts").get()).toMatchObject({ state: "dispatching" })
    return create()
  })
  vi.stubGlobal("fetch", fetch)
  const approved: ApprovedPublication = {
    publicationId: "wf:v1",
    workflowId: "wf",
    candidateVersion: 1,
    fingerprint: await fingerprintCommand(command),
    command,
    deadlineMs: Date.now() + 60_000,
    approval: {
      userId: "42",
      chatId: "100",
      deliveryId: "delivery",
      interactionId: "action",
      approvedAtMs: Date.now(),
    },
  }
  const call = (op: string, extra = {}) =>
    guard.fetch(
      new Request("https://guard/", {
        method: "POST",
        body: JSON.stringify({ op, fingerprint: approved.fingerprint, ...extra }),
      }),
    )
  expect((await call("prepare", { approved })).status).toBe(200)
  return {
    approved,
    call,
    db,
    fetch,
    writes: () => writes,
    reads: () => reads,
    evict: () => {
      guard = new BufferPublicationDO(ctx, env)
    },
    setCreate: (fn: () => Promise<Response>) => {
      create = fn
    },
    failSync: () => {
      failSync = true
    },
    identity: (account: string, connection: string) => {
      accountId = account
      connectionId = connection
    },
    revoke: () => {
      usable = false
    },
  }
}

function post(patch = {}) {
  return {
    id: "post",
    channelId: "channel",
    channelService: "substack",
    text: command.text,
    status: "sent",
    shareMode: "shareNow",
    schedulingType: "automatic",
    isCustomScheduled: false,
    sharedNow: true,
    metadata: { linkAttachment: null },
    ...patch,
  }
}

it("persists a claim before create and returns one accepted result to concurrent and reconstructed callers", async () => {
  const h = await fixture()
  let release: () => void = () => {}
  h.setCreate(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve(Response.json({ data: { createPost: { __typename: "PostActionSuccess", post: post() } } }))
      }),
  )
  const first = h.call("submit")
  await vi.waitFor(() => expect(h.writes()).toBe(1))
  const second = h.call("submit")
  release()
  expect(await (await first).json()).toEqual({ kind: "accepted", postId: "post" })
  expect(await (await second).json()).toEqual({ kind: "accepted", postId: "post" })
  h.evict()
  expect(await (await h.call("submit")).json()).toEqual({ kind: "accepted", postId: "post" })
  expect(h.writes()).toBe(1)
  expect(h.reads()).toBe(0)
})

it("rejects modified approvals and fingerprints without sending", async () => {
  const h = await fixture()
  expect(
    (await h.call("prepare", { approved: { ...h.approved, command: { ...command, text: "changed" } } })).status,
  ).toBe(400)
  expect((await h.call("prepare", { approved: { ...h.approved, deadlineMs: h.approved.deadlineMs + 1 } })).status).toBe(
    409,
  )
  expect((await h.call("submit", { fingerprint: "other" })).status).toBe(409)
  expect(h.writes()).toBe(0)
})

it.each([
  "reauth",
  "account",
  "connection",
  "deadline",
])("records a definitive no-create preflight failure for %s", async (failure) => {
  const h = await fixture()
  if (failure === "reauth") h.revoke()
  if (failure === "account") h.identity("other", "connection")
  if (failure === "connection") h.identity("account", "other")
  if (failure === "deadline") vi.spyOn(Date, "now").mockReturnValue(h.approved.deadlineMs)
  expect(await (await h.call("submit")).json()).toMatchObject({ kind: "rejected" })
  expect(h.writes()).toBe(0)
})

it("never reclaims an abandoned dispatch or infers non-creation from a timeout", async () => {
  const h = await fixture()
  h.setCreate(async () => {
    throw new Error("lost response")
  })
  expect(await (await h.call("submit")).json()).toMatchObject({ kind: "unknown" })
  h.evict()
  expect(await (await h.call("submit")).json()).toMatchObject({ kind: "unknown" })
  expect(h.writes()).toBe(1)
  const row = h.db.prepare("SELECT record_json FROM publication").get() as { record_json: string }
  const record = JSON.parse(row.record_json)
  delete record.result
  record.phase = "dispatching"
  h.db.prepare("UPDATE publication SET record_json = ?").run(JSON.stringify(record))
  h.evict()
  expect(await (await h.call("submit")).json()).toEqual({ kind: "unknown", reason: "dispatch-already-claimed" })
  expect(h.writes()).toBe(1)
})

it("does not contact Buffer if persisting the dispatch claim fails", async () => {
  const h = await fixture()
  h.failSync()
  expect((await h.call("submit")).status).toBe(503)
  expect(h.writes()).toBe(0)
})

it("keeps unexpected-created evidence terminal and reconciles only an exact captured ID", async () => {
  const h = await fixture()
  h.setCreate(async () =>
    Response.json({ data: { createPost: { __typename: "PostActionSuccess", post: post({ status: "draft" }) } } }),
  )
  expect(await (await h.call("submit")).json()).toMatchObject({ kind: "created-unexpected", postId: "post" })
  h.evict()
  expect(await (await h.call("submit")).json()).toMatchObject({ kind: "created-unexpected" })
  expect(h.writes()).toBe(1)
})

it("can confirm an incomplete response with one bounded read of its captured post ID", async () => {
  const h = await fixture()
  h.setCreate(async () =>
    Response.json({
      data: { createPost: { __typename: "PostActionSuccess", post: post() } },
      errors: [{ message: "partial" }],
    }),
  )
  expect(await (await h.call("submit")).json()).toEqual({ kind: "accepted", postId: "post" })
  expect(h.reads()).toBe(1)
  expect(h.writes()).toBe(1)
})
