import { expect, it } from "vitest"
import type { ApprovedPublication, NotesInteractionEvent } from "../notes/types"
import { createNotesRecovery } from "./helpers/notes-recovery"

/** Bounds asynchronous observations of the fake provider without relying on fixed sleeps. */
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Recovery boundary was not reached")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it.each([
  ["dispatch-sync", 0, "unknown"],
  ["result-write", 1, "unknown"],
  ["result-sync", 1, "accepted"],
  [undefined, 1, "accepted"],
] as const)(
  "recovers the production publication guard after %s with no second create",
  async (fault, count, kind) => {
    const h = await createNotesRecovery()
    try {
      const approved = await h.fixture()
      const body = { fingerprint: approved.fingerprint }
      expect((await h.request("/publication", { op: "prepare", approved })).status).toBe(200)
      await h.request("/publication", { op: "submit", ...body }, fault)
      expect(h.calls.creates).toHaveLength(count)
      await h.reboot()
      const results = await Promise.all(
        Array.from({ length: 4 }, async () => (await h.request("/publication", { op: "submit", ...body })).json()),
      )
      for (const result of results) expect(result).toMatchObject({ kind })
      if (kind === "accepted") expect(results[0]).toMatchObject({ postId: "post-1", dueAt: "2030-01-01T09:00:00.000Z" })
      expect(h.calls.creates).toHaveLength(count)
      const state = (await (await h.request("/publication/state")).json()) as {
        publications: Array<{ record_json: string }>
        attempts: Array<{ state: string }>
      }
      expect(JSON.parse(state.publications[0].record_json).approved).toEqual(approved)
      expect(state.attempts).toHaveLength(1)
      expect(state.attempts[0].state).toBe(kind === "accepted" ? "accepted" : "dispatching")
      expect(
        (
          await h.request("/publication", {
            op: "prepare",
            approved: { ...approved, command: { ...approved.command, text: "Changed without approval" } },
          })
        ).status,
      ).toBe(400)
    } finally {
      await h.dispose()
    }
  },
  30_000,
)

/** Makes a synthetic owner-authorized Retry event for the exact frozen publication. */
function retry(approved: ApprovedPublication): NotesInteractionEvent {
  return {
    deliveryId: "retry-delivery",
    interactionId: "retry-action",
    workflowId: approved.workflowId,
    version: 2,
    fingerprint: approved.fingerprint,
    userId: "42",
    chatId: "100",
    telegramUpdateId: 2,
    receivedAtMs: Date.now(),
    kind: "notes-retry",
  }
}

it.each([
  false,
  true,
])("preserves rejected Retry authority and supersession across cold restarts: supersede=%s", async (supersede) => {
  const h = await createNotesRecovery()
  try {
    const approved = await h.fixture()
    const fingerprint = approved.fingerprint
    await h.request("/publication", { op: "prepare", approved })
    h.pauseQueue(true)
    const rejected = (await (await h.request("/publication", { op: "submit", fingerprint })).json()) as {
      kind: string
      attemptId: string
    }
    expect(rejected).toMatchObject({ kind: "rejected", attemptId: expect.any(String) })
    expect(h.calls.creates).toHaveLength(0)
    await h.reboot()
    h.pauseQueue(false)
    const authorization = retry(approved)
    const operation = { op: "retryRejected", fingerprint, expectedAttemptId: rejected.attemptId, authorization }
    if (supersede) {
      expect(
        (
          await h.request("/publication", {
            op: "supersedeRejected",
            fingerprint,
            expectedAttemptId: rejected.attemptId,
          })
        ).status,
      ).toBe(200)
      await h.reboot()
      expect((await h.request("/publication", operation)).status).toBe(409)
      expect(await (await h.request("/publication", { op: "submit", fingerprint })).json()).toMatchObject({
        kind: "rejected",
        reason: "superseded",
        repair: "none",
      })
      expect(h.calls.creates).toHaveLength(0)
    } else {
      expect(
        (await h.request("/publication", { ...operation, authorization: { ...authorization, userId: "99" } })).status,
      ).toBe(409)
      expect(await (await h.request("/publication", operation)).json()).toMatchObject({ kind: "accepted" })
      await h.reboot()
      expect(await (await h.request("/publication", operation)).json()).toMatchObject({ kind: "accepted" })
      expect(
        (
          await h.request("/publication", {
            ...operation,
            authorization: { ...authorization, deliveryId: "new-stale-delivery" },
          })
        ).status,
      ).toBe(409)
      expect(h.calls.creates).toHaveLength(1)
      const state = (await (await h.request("/publication/state")).json()) as {
        attempts: Array<{ ordinal: number; state: string }>
      }
      expect(state.attempts.map(({ ordinal, state }) => ({ ordinal, state }))).toEqual([
        { ordinal: 1, state: "rejected" },
        { ordinal: 2, state: "accepted" },
      ])
    }
  } finally {
    await h.dispose()
  }
}, 30_000)

it.each([
  ["refresh-claim", 0],
  ["rotation-write", 1],
] as const)(
  "never reuses a rotating token after %s and a cold restart",
  async (fault, count) => {
    const h = await createNotesRecovery()
    try {
      await h.request("/fixture", { nearExpiry: true })
      expect((await h.request("/vault", { op: "acquireBufferAccess" }, fault)).status).toBe(500)
      await h.reboot()
      for (const response of await Promise.all(
        Array.from({ length: 4 }, () => h.request("/vault", { op: "acquireBufferAccess" })),
      ))
        expect(await response.json()).toMatchObject({ kind: "needs-auth" })
      expect(h.calls.refreshTokens).toEqual(count ? ["synthetic-refresh"] : [])
    } finally {
      await h.dispose()
    }
  },
  30_000,
)

it("joins real RPC refresh callers and returns the persisted replacement after runtime reconstruction", async () => {
  const h = await createNotesRecovery()
  const release = h.holdRefresh()
  try {
    await h.request("/fixture", { nearExpiry: true })
    const first = h.request("/vault", { op: "acquireBufferAccess" })
    await until(() => h.calls.refreshTokens.length === 1)
    const second = h.request("/vault", { op: "acquireBufferAccess" })
    // A separate provider remains accessible while Buffer's network call is pending.
    expect(await (await h.request("/vault", { op: "readTokens", provider: "linkedin" })).json()).toEqual({
      tokens: null,
    })
    release()
    const a = await (await first).json()
    expect(await (await second).json()).toEqual(a)
    expect(a).toMatchObject({ kind: "usable", accessToken: "rotated-access", credentialGeneration: 2 })
    expect(a).not.toHaveProperty("refreshToken")
    await h.reboot()
    expect(await (await h.request("/vault", { op: "acquireBufferAccess" })).json()).toEqual(a)
    expect(h.calls.refreshTokens).toEqual(["synthetic-refresh"])
  } finally {
    release()
    await h.dispose()
  }
}, 30_000)

it("retains one exact authenticated router event across resolve/send/ack restarts and invalidates stale actions", async () => {
  const h = await createNotesRecovery()
  try {
    const approved = await h.fixture()
    const action = {
      interactionId: "approve",
      callbackToken: "n:test",
      workflowId: approved.workflowId,
      kind: "notes-publish",
      version: 1,
      expiresAt: approved.deadlineMs,
      notes: { userId: "42", chatId: "100", fingerprint: approved.fingerprint },
    }
    await h.request("/router/register", action)
    const input = {
      callbackToken: action.callbackToken,
      telegramUpdateId: 1,
      userId: "42",
      chatId: "100",
      receivedAtMs: Date.now(),
    }
    expect(await (await h.request("/router/notes/resolve", { ...input, userId: "99" })).json()).toMatchObject({
      event: null,
    })
    const retained = (await (await h.request("/router/notes/resolve", input)).json()) as {
      event: NotesInteractionEvent
    }
    expect(retained.event).toMatchObject({
      kind: "notes-publish",
      fingerprint: approved.fingerprint,
      userId: "42",
      chatId: "100",
      version: 1,
    })
    await h.reboot() // resolve completed; forwarding has not happened
    expect(await (await h.request("/router/notes/resolve", input)).json()).toEqual(retained)
    expect(await (await h.request("/router/notes/resolve", { ...input, telegramUpdateId: 2 })).json()).toEqual(retained)
    await h.request("/router/notes/invalidate", { workflowId: approved.workflowId, version: 2 })
    await h.reboot() // forwarding may have succeeded; acknowledgement was lost
    expect(await (await h.request("/router/notes/resolve", input)).json()).toEqual(retained)
    await h.request("/router/notes/ack", { deliveryId: retained.event.deliveryId })
    await h.reboot()
    expect(await (await h.request("/router/notes/resolve", input)).json()).toMatchObject({ event: null })
    await h.request("/router/register", { ...action, interactionId: "stale", callbackToken: "n:stale" })
    expect(
      await (
        await h.request("/router/notes/resolve", { ...input, telegramUpdateId: 3, callbackToken: "n:stale" })
      ).json(),
    ).toMatchObject({ event: null })
  } finally {
    await h.dispose()
  }
}, 30_000)

it("uses the persisted replacement refresh token for the next exchange after cold restart", async () => {
  const h = await createNotesRecovery()
  try {
    await h.request("/fixture", { nearExpiry: true })
    h.expireNextRotationSoon()
    expect(await (await h.request("/vault", { op: "acquireBufferAccess" })).json()).toMatchObject({
      kind: "usable",
      credentialGeneration: 2,
    })
    await h.reboot()
    expect(await (await h.request("/vault", { op: "acquireBufferAccess" })).json()).toMatchObject({
      kind: "usable",
      credentialGeneration: 3,
    })
    expect(h.calls.refreshTokens).toEqual(["synthetic-refresh", "rotated-refresh"])
  } finally {
    await h.dispose()
  }
}, 30_000)

it("fences an in-flight refresh behind a newer same-account authorization in the real vault", async () => {
  const h = await createNotesRecovery()
  const release = h.holdRefresh()
  try {
    await h.request("/fixture", { nearExpiry: true })
    const pending = h.request("/vault", { op: "acquireBufferAccess" })
    await until(() => h.calls.refreshTokens.length === 1)
    // Replaces the grant without waiting for Buffer; does not acquire access while refresh is in flight.
    expect(
      (
        await h.request("/fixture", {
          grantOnly: true,
          accessToken: "reauthorized-access",
          refreshToken: "reauthorized-refresh",
        })
      ).status,
    ).toBe(200)
    release()
    expect(await (await pending).json()).toMatchObject({
      kind: "usable",
      accessToken: "reauthorized-access",
      credentialGeneration: 2,
    })
    // The late rotation must not erase the new grant, including across reconstruction.
    expect(await (await h.request("/vault", { op: "acquireBufferAccess" })).json()).toMatchObject({
      kind: "usable",
      accessToken: "reauthorized-access",
      credentialGeneration: 2,
    })
    await h.reboot()
    expect(await (await h.request("/vault", { op: "acquireBufferAccess" })).json()).toMatchObject({
      kind: "usable",
      accessToken: "reauthorized-access",
      credentialGeneration: 2,
    })
    expect(h.calls.refreshTokens).toEqual(["synthetic-refresh"])
  } finally {
    release()
    await h.dispose()
  }
}, 30_000)
