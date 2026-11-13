import { expect, it } from "vitest"
import { createInteractionRouter } from "../core/interaction-router-client"
import { sqliteInteractionRouter } from "./fixtures/interaction-router"

const registration = {
  interactionId: "approve",
  version: 1,
  workflowId: "notes-wf",
  kind: "notes-publish" as const,
  callbackToken: "n:token",
  expiresAt: Date.now() + 60_000,
  notes: { userId: "42", chatId: "100", fingerprint: "hash" },
}
const input = { telegramUpdateId: 1, callbackToken: "n:token", userId: "42", chatId: "100", receivedAtMs: Date.now() }

it("retains an immutable consumed event through reconstruction and repeated update/action delivery", async () => {
  const fixture = sqliteInteractionRouter()
  const router = createInteractionRouter(fixture.namespace, "100")
  await router.register(registration)
  const first = await router.resolveNotes(input)
  expect(first.event).toMatchObject({ interactionId: "approve", userId: "42" })
  fixture.evict("telegram-chat:100")
  expect(await router.resolveNotes({ ...input, receivedAtMs: input.receivedAtMs + 1 })).toEqual(first)
  expect(await router.resolveNotes({ ...input, telegramUpdateId: 2 })).toEqual(first)
  if (!first.event) throw new Error("Missing delivery")
  await router.acknowledgeNotes(first.event.deliveryId)
  expect((await router.resolveNotes(input)).event).toBeNull()
  expect((await router.resolveNotes({ ...input, telegramUpdateId: 3 })).event).toBeNull()
})

it("rejects wrong owners without consuming, and fences stale registrations even after replay", async () => {
  const fixture = sqliteInteractionRouter()
  const router = createInteractionRouter(fixture.namespace, "100")
  await router.register(registration)
  expect((await router.resolveNotes({ ...input, userId: "43" })).event).toBeNull()
  await router.invalidateNotes("notes-wf", 2)
  await router.register(registration)
  expect((await router.resolveNotes(input)).event).toBeNull()
  await router.register({ ...registration, interactionId: "new", version: 2, callbackToken: "n:new" })
  expect((await router.resolveNotes({ ...input, callbackToken: "n:new" })).event?.version).toBe(2)
})

it("binds replies to feedback without treating their text as approval", async () => {
  const fixture = sqliteInteractionRouter()
  const router = createInteractionRouter(fixture.namespace, "100")
  await router.register({
    ...registration,
    interactionId: "feedback",
    callbackToken: undefined,
    kind: "notes-feedback",
  })
  await router.bindNotes("feedback", 99)
  const result = await router.resolveNotes({
    ...input,
    callbackToken: undefined,
    replyToMessageId: 99,
    text: "publish",
  })
  expect(result.event).toMatchObject({ kind: "notes-feedback", text: "publish" })
})

it("lets plain text reach other workflows after Notes review is invalidated", async () => {
  const fixture = sqliteInteractionRouter()
  const router = createInteractionRouter(fixture.namespace, "100")
  await router.register({
    ...registration,
    interactionId: "feedback",
    callbackToken: undefined,
    kind: "notes-feedback",
  })
  await router.invalidateNotes("notes-wf", 2)
  expect(await router.resolveNotes({ ...input, callbackToken: undefined, text: "Calendar clarification" })).toEqual({
    handled: false,
  })
})
