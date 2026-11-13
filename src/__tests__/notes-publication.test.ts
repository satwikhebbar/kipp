import type { WorkflowStep } from "cloudflare:workers"
import { expect, it } from "vitest"
import type { Env } from "../core/types"
import { publishApprovedNote } from "../notes/publication"
import type { ApprovedPublication } from "../notes/types"

it.each([
  "submit",
  "inspect",
])("propagates Workflow interruption during %s instead of checkpointing failure", async (boundary) => {
  let inspections = 0
  const interruption = new Error("Aborting engine: User called pause")
  const env = {
    TELEGRAM_BOT_TOKEN: "synthetic",
    INTERACTION_ROUTER: { idFromName: (id: string) => id, get: () => ({}) },
    BUFFER_PUBLICATIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (_url: string, request: RequestInit) => {
          const input = JSON.parse(String(request.body))
          if (input.op === "prepare") return Response.json({ ok: true })
          if (input.op === "submit") throw boundary === "submit" ? interruption : new Error("Lost RPC")
          inspections++
          throw interruption
        },
      }),
    },
  } as unknown as Env
  const approved = {
    publicationId: "wf:v1",
    workflowId: "wf",
    candidateVersion: 1,
    fingerprint: "f".repeat(64),
    command: {
      destination: { accountId: "a", connectionId: "c", organizationId: "o", channelId: "ch", service: "substack" },
      text: "Note",
      attachmentUrl: null,
      timing: { kind: "now" },
    },
    approval: { userId: "42", chatId: "100", deliveryId: "d", interactionId: "i", approvedAtMs: Date.now() },
    deadlineMs: Date.now() + 60_000,
  } as ApprovedPublication
  const step = {
    do: async (_name: string, _options: unknown, fn: () => Promise<unknown>) => fn(),
  } as unknown as WorkflowStep
  await expect(publishApprovedNote(env, step, approved, null, false, 0)).rejects.toThrow(interruption.message)
  expect(inspections).toBe(boundary === "inspect" ? 1 : 0)
})
