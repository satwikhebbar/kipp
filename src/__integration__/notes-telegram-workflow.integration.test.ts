import { expect, it } from "vitest"
import { createWorkflowSanity, toolResponse } from "./helpers/workflow-sanity"

const NOTE = "A small release is easier to understand. Keep *the decision* human. 😀"
const model = () => toolResponse("submit_note", { commentary: "One concrete idea, in the author's voice.", text: NOTE })

it("replays a lost Workflow submit checkpoint from durable acceptance without another Buffer create", async () => {
  const h = await createWorkflowSanity({ model, loseNotesSubmitCheckpoint: true })
  try {
    await h.message("/note Small releases keep feedback useful.")
    const review = await h.waitMessage(/^A small release/)
    await h.click(review, /^Publish$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites).toHaveLength(1)
    await h.waitMessage(/^Sent to Buffer for publication/)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("keeps Revise separate from writing and rejects the old Publish button", async () => {
  const revised = "Smaller releases give feedback a clear target."
  const h = await createWorkflowSanity({
    model: (_body, call) =>
      toolResponse("submit_note", {
        commentary: call === 1 ? "One clear idea." : "Tighter wording.",
        text: call === 1 ? NOTE : revised,
      }),
  })
  try {
    await h.message("/note Small releases keep feedback useful.")
    const first = await h.waitMessage(/^A small release/)
    await h.click(first, /^Revise$/)
    const question = await h.waitMessage(/What would you like to change/)
    expect(h.state.modelCalls).toBe(1)
    await h.message("Make it tighter.", question.messageId)
    const latest = await h.waitMessage(/^Smaller releases/)
    expect(await h.click(first, /^Publish$/)).toBe(200)
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.click(latest, /^Publish$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites).toHaveLength(1)
    expect(h.state.bufferWrites[0].text).toBe(revised)
    expect(h.state.modelCalls).toBe(2)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("takes authenticated /note through exact approval and immediate Buffer acceptance in workerd", async () => {
  const h = await createWorkflowSanity({ model })
  try {
    expect(await h.message("/note")).toBe(200)
    await h.waitMessage(/Use \/note/)
    expect(h.state.modelCalls).toBe(0)
    expect(await h.message("/note Small releases keep feedback useful.")).toBe(200)
    const review = await h.waitMessage(/^A small release/)
    expect(review.text).toBe(NOTE)
    expect(h.state.transcript[0].request).toMatchObject({ model: "openai/gpt-6-luna", reasoning: { effort: "none" } })
    const messages = h.network.getState().telegramMessages
    expect(messages.map((m) => m.text).slice(-3)).toEqual([
      "One concrete idea, in the author's voice.",
      expect.stringContaining("Timing: publish immediately"),
      NOTE,
    ])
    expect(h.state.bufferWrites).toHaveLength(0)
    expect(await h.click(review, /^Publish$/, 90)).toBe(200)
    await h.waitStatus("notes")
    expect(await h.click(review, /^Publish$/, 90)).toBe(200)
    expect(h.state.bufferWrites).toEqual([
      {
        channelId: "buffer-channel",
        text: NOTE,
        assets: [],
        schedulingType: "automatic",
        mode: "shareNow",
        needsApproval: false,
        saveToDraft: false,
      },
    ])
    await h.waitMessage(/^Sent to Buffer for publication/)
    expect(h.state.failures).toEqual([])
  } finally {
    await h.dispose()
  }
}, 30_000)

it.each([
  "resolve",
  "ack",
] as const)("recovers a lost Notes router %s response through webhook redelivery", async (fault) => {
  const h = await createWorkflowSanity({ model, notesRouterFault: fault })
  try {
    await h.message("/note Small releases keep feedback useful.")
    const review = await h.waitMessage(/^A small release/)
    expect(await h.click(review, /^Publish$/, 90)).toBe(503)
    expect(await h.click(review, /^Publish$/, 90)).toBe(200)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites).toHaveLength(1)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("ends without a publishing Retry when Buffer returns an unconfirmed mutation error", async () => {
  const h = await createWorkflowSanity({
    model,
    bufferResult: () => ({ data: { createPost: { __typename: "UnauthorizedError", message: "generic" } } }),
  })
  try {
    await h.message("/note Small releases keep feedback useful.")
    const review = await h.waitMessage(/^A small release/)
    await h.click(review, /^Publish$/)
    await h.waitStatus("notes")
    const failure = await h.waitMessage(/couldn't confirm submission/)
    expect(failure.replyMarkup).toBeUndefined()
    expect(h.state.bufferWrites).toHaveLength(1)
    expect(h.state.modelCalls).toBe(1)
  } finally {
    await h.dispose()
  }
}, 30_000)
