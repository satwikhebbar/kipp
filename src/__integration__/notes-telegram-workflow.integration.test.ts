import { expect, it } from "vitest"
import { createWorkflowSanity, toolResponse } from "./helpers/workflow-sanity"
import { notesScheduledJourney } from "./helpers/workflow-sanity-scenarios"

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
    userTurnLimit: 8,
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
    await h.click(first, /^Revise$/)
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

it("clarifies missing facts before presenting any Publish action", async () => {
  const h = await createWorkflowSanity({
    model: (_body, call) =>
      call === 1 ? toolResponse("ask_note_question", { question: "Which experiment do you mean?" }) : model(),
  })
  try {
    await h.message("/note That experiment changed my mind.")
    const question = await h.waitMessage(/Which experiment/)
    expect(question.replyMarkup).toBeUndefined()
    expect(h.state.registrations.some((r) => r.kind === "notes-publish")).toBe(false)
    await h.message("The smaller release experiment.", question.messageId)
    const review = await h.waitMessage(/^A small release/)
    await h.click(review, /^Publish$/)
    await h.waitStatus("notes")
    expect(h.state.modelCalls).toBe(2)
    expect(h.state.bufferWrites).toHaveLength(1)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("retains a masked first card through prose revision, replaces it from feedback, and removes it explicitly", async () => {
  const h = await createWorkflowSanity({
    userTurnLimit: 8,
    model: (_body, call) =>
      toolResponse("submit_note", {
        commentary: `Draft ${call}`,
        text: `Version ${call}: small releases teach us faster.`,
        linkCardAction: call === 3 ? "use-input" : call === 4 ? "remove" : "keep",
      }),
  })
  try {
    const initial = "/note 😀 Read this article and https://later.example.com"
    await h.message(initial, undefined, [
      {
        type: "text_link",
        offset: initial.indexOf("this article"),
        length: 12,
        url: "https://first.example.com/?a=1#part",
      },
    ])
    const first = await h.waitMessage(/^Version 1/)
    await h.waitMessage(/Embedded card: https:\/\/first.example.com/)
    await h.message("Make it more direct.", first.messageId)
    const second = await h.waitMessage(/^Version 2/)
    await h.waitMessage(/Embedded card: https:\/\/first.example.com/, first.messageId)
    await h.message(
      "Use this instead https://replacement.example.com and ignore https://last.example.com",
      second.messageId,
    )
    const third = await h.waitMessage(/^Version 3/)
    await h.waitMessage(/Embedded card: https:\/\/replacement.example.com/)
    await h.click(first, /^Publish$/)
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.message("Remove the card.", third.messageId)
    const fourth = await h.waitMessage(/^Version 4/)
    await h.click(fourth, /^Publish$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites).toHaveLength(1)
    expect(h.state.bufferWrites[0].metadata).toBeUndefined()
  } finally {
    await h.dispose()
  }
}, 30_000)

it("publishes only the first URL as a card and verifies Buffer's matching metadata", async () => {
  const h = await createWorkflowSanity({ model })
  try {
    await h.message("/note See https://example.com/first?a=1#part and https://substack.com/second")
    const review = await h.waitMessage(/^A small release/)
    await h.click(review, /^Publish$/)
    await h.waitStatus("notes")
    await h.waitMessage(/^Sent to Buffer for publication/)
    expect(h.state.bufferWrites[0].metadata).toEqual({
      substack: { linkAttachment: { url: "https://example.com/first?a=1#part" } },
    })
  } finally {
    await h.dispose()
  }
}, 30_000)

it("keeps the last valid linked draft after clarification exhausts five writing sessions", async () => {
  const h = await createWorkflowSanity({
    userTurnLimit: 8,
    model: (_body, call) =>
      call === 1 ? model() : toolResponse("ask_note_question", { question: `Question ${call}: what detail?` }),
  })
  try {
    await h.message("/note Small releases https://example.com/original")
    const original = await h.waitMessage(/^A small release/)
    await h.message("Revise it.", original.messageId)
    for (let call = 2; call <= 4; call++) {
      const question = await h.waitMessage(new RegExp(`^Question ${call}:`))
      await h.message("Keep the supplied facts.", question.messageId)
    }
    const final = await h.waitMessage(/^A small release/, original.messageId)
    await h.waitMessage(/writing limit is reached/)
    expect(h.state.modelCalls).toBe(5)
    expect(final.replyMarkup?.inline_keyboard).toEqual([[{ text: "Publish", callback_data: expect.any(String) }]])
    await h.click(original, /^Publish$/)
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.click(final, /^Publish$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites[0].text).toBe(NOTE)
    expect(h.state.bufferWrites[0].metadata).toEqual({
      substack: { linkAttachment: { url: "https://example.com/original" } },
    })
  } finally {
    await h.dispose()
  }
}, 30_000)

it("ends after five necessary clarifications when no valid draft exists", async () => {
  const h = await createWorkflowSanity({
    model: (_body, call) => toolResponse("ask_note_question", { question: `Question ${call}: which fact?` }),
  })
  try {
    await h.message("/note That changed everything.")
    for (let call = 1; call <= 4; call++) {
      const question = await h.waitMessage(new RegExp(`^Question ${call}:`))
      await h.message("I still need to explain.", question.messageId)
    }
    await h.waitStatus("notes")
    await h.waitMessage(/couldn't prepare a Note within the writing limit/)
    expect(h.state.modelCalls).toBe(5)
    expect(h.state.registrations.some((r) => r.kind === "notes-publish")).toBe(false)
    expect(h.state.bufferWrites).toHaveLength(0)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("reoffers the exact last valid draft and card after Workflow writing retries are exhausted", async () => {
  const h = await createWorkflowSanity({
    notesWritingRetries: 1,
    model: (_body, call) =>
      call === 1
        ? model()
        : {
            choices: [{ finish_reason: "stop", message: { content: "Unable to draft." } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
  })
  try {
    await h.message("/note Small releases https://example.com/original")
    const original = await h.waitMessage(/^A small release/)
    await h.message("Try a different opening.", original.messageId)
    await h.waitMessage(/couldn't reshape it/)
    const recovered = await h.waitMessage(/^A small release/, original.messageId)
    expect(recovered.text).toBe(NOTE)
    expect(h.state.modelCalls).toBe(7)
    expect(new Set(h.state.registrations.map((r) => r.expiresAt)).size).toBe(1)
    await h.click(original, /^Publish$/)
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.click(recovered, /^Publish$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites[0].metadata).toEqual({
      substack: { linkAttachment: { url: "https://example.com/original" } },
    })
  } finally {
    await h.dispose()
  }
}, 30_000)

it("retries a failed bounded writing session without consuming another logical review round", async () => {
  const h = await createWorkflowSanity({
    notesWritingRetries: 1,
    userTurnLimit: 8,
    model: (_body, call) =>
      call <= 3
        ? {
            choices: [{ finish_reason: "stop", message: { content: "No handoff." } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }
        : model(),
  })
  try {
    await h.message("/note Small releases https://example.com/original")
    let review = await h.waitMessage(/^A small release/)
    expect(h.state.modelCalls).toBe(4)
    expect(h.state.transcript[3].request.messages).toEqual(h.state.transcript[0].request.messages)
    // Four follow-ups remain after recovery of the initial writing step.
    for (let round = 0; round < 4; round++) {
      await h.message("Tighten the wording; preserve the card.", review.messageId)
      review = await h.waitMessage(/^A small release/, review.messageId)
    }
    expect(h.state.modelCalls).toBe(8)
    expect(review.replyMarkup?.inline_keyboard).toEqual([[{ text: "Publish", callback_data: expect.any(String) }]])
    expect(new Set(h.state.registrations.map((r) => r.expiresAt)).size).toBe(1)
    await h.click(review, /^Publish$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites).toHaveLength(1)
    expect(h.state.bufferWrites[0].metadata).toEqual({
      substack: { linkAttachment: { url: "https://example.com/original" } },
    })
  } finally {
    await h.dispose()
  }
}, 30_000)

it("reports an initial writing failure only after Workflow retries are exhausted", async () => {
  const h = await createWorkflowSanity({
    notesWritingRetries: 1,
    model: () => ({
      choices: [{ finish_reason: "stop", message: { content: "No handoff." } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  })
  try {
    await h.message("/note Small releases")
    await h.waitStatus("notes")
    await h.waitMessage(/couldn't prepare a Note/)
    expect(h.state.modelCalls).toBe(6)
    expect(h.state.registrations).toHaveLength(0)
    expect(h.state.bufferWrites).toHaveLength(0)
  } finally {
    await h.dispose()
  }
}, 30_000)

it.each(["Asia/Kolkata", null])("queues a Note and displays Buffer's assigned slot using %s", async (timeZone) => {
  const h = await createWorkflowSanity({
    timeZone,
    loseNotesSubmitCheckpoint: true,
    model: () => toolResponse("submit_note", { commentary: "A clear point.", text: NOTE, timing: { kind: "queue" } }),
  })
  try {
    await h.message("/note Small releases. Add this to my queue.")
    const review = await h.waitMessage(/^A small release/)
    await h.waitMessage(/Timing: next available slot/)
    await h.click(review, /^Add to queue$/)
    await h.waitStatus("notes")
    const confirmation = await h.waitMessage(/^Added to your Buffer queue/)
    expect(confirmation.text).toContain(timeZone ? "2030-01-01 19:00 Asia/Kolkata" : "2030-01-01 13:30 UTC")
    expect(h.state.bufferWrites).toHaveLength(1)
    expect(h.state.bufferWrites[0]).toMatchObject({ mode: "addToQueue", schedulingType: "automatic" })
    expect(h.state.bufferWrites[0]).not.toHaveProperty("dueAt")
  } finally {
    await h.dispose()
  }
}, 30_000)

it("schedules an exact UTC instant and preserves it through a prose revision", async () => {
  const h = await createWorkflowSanity({
    model: (_body, call) =>
      toolResponse("submit_note", {
        commentary: "A clear point.",
        text: call === 1 ? NOTE : "A revised small release Note.",
        timing:
          call === 1
            ? {
                kind: "schedule",
                date: { kind: "absolute", localDate: "2030-01-01" },
                localTime: "19:00",
                timeZone: null,
              }
            : { kind: "unchanged" },
      }),
  })
  try {
    await h.message("/note Small releases. Schedule for 2030-01-01 at 7pm.")
    const first = await h.waitMessage(/^A small release/)
    await h.waitMessage(/Timing: 2030-01-01 19:00 Asia\/Kolkata/)
    await h.message("Make the opening more concrete.", first.messageId)
    const review = await h.waitMessage(/^A revised small/)
    await h.click(first, /^Schedule$/)
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.click(review, /^Schedule$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites[0]).toMatchObject({ mode: "customScheduled", dueAt: "2030-01-01T13:30:00.000Z" })
    await h.waitMessage(/^Scheduled with Buffer for 2030-01-01 19:00 Asia\/Kolkata/)
  } finally {
    await h.dispose()
  }
}, 30_000)

it.each([
  ["2027-03-14", "02:30", "America/New_York", "does not exist"],
  ["2027-11-07", "01:30", "America/New_York", "occurs twice"],
  ["2020-01-01", "12:00", "UTC", "has passed"],
])(
  "clarifies scheduling %s %s %s without offering approval",
  async (date, time, zone, question) => {
    const h = await createWorkflowSanity({
      model: (_body, call) =>
        toolResponse("submit_note", {
          commentary: "One idea.",
          text: NOTE,
          timing:
            call === 1
              ? { kind: "schedule", date: { kind: "absolute", localDate: date }, localTime: time, timeZone: zone }
              : { kind: "queue" },
        }),
    })
    try {
      await h.message(`/note Small releases. Schedule ${date} ${time} ${zone}.`)
      const clarification = await h.waitMessage(new RegExp(question))
      expect(clarification.replyMarkup).toBeUndefined()
      expect(h.state.registrations.some((r) => r.kind === "notes-publish")).toBe(false)
      await h.message("Use my Buffer queue instead.", clarification.messageId)
      const review = await h.waitMessage(/^A small release/)
      await h.click(review, /^Add to queue$/)
      await h.waitStatus("notes")
      expect(h.state.bufferWrites).toHaveLength(1)
      expect(h.state.bufferWrites[0].mode).toBe("addToQueue")
    } finally {
      await h.dispose()
    }
  },
  30_000,
)

it("clarifies missing scheduling timezone but permits queue placement without one", async () => {
  const h = await createWorkflowSanity({
    timeZone: null,
    model: (_body, call) =>
      toolResponse("submit_note", {
        commentary: "One idea.",
        text: NOTE,
        timing:
          call === 1
            ? {
                kind: "schedule",
                date: { kind: "absolute", localDate: "2030-01-01" },
                localTime: "19:00",
                timeZone: null,
              }
            : { kind: "queue" },
      }),
  })
  try {
    await h.message("/note Small releases. Post 2030-01-01 at 7pm.")
    const question = await h.waitMessage(/Which timezone/)
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.message("Use the queue instead.", question.messageId)
    const review = await h.waitMessage(/^A small release/)
    await h.click(review, /^Add to queue$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites[0]).not.toHaveProperty("dueAt")
  } finally {
    await h.dispose()
  }
}, 30_000)

it("requires explicit Retry after resuming a paused queue and ignores duplicate/stale Retry", async () => {
  const h = await createWorkflowSanity({
    userTurnLimit: 8,
    model: () => toolResponse("submit_note", { commentary: "One idea.", text: NOTE, timing: { kind: "queue" } }),
  })
  try {
    await h.message("/note Small releases. Queue it.")
    const review = await h.waitMessage(/^A small release/)
    h.state.bufferQueuePaused = true
    await h.click(review, /^Add to queue$/)
    const repair = await h.waitMessage(/Resume your queue in Buffer/)
    expect(h.state.bufferWrites).toHaveLength(0)
    h.state.bufferQueuePaused = false
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.click(repair, /^Retry$/, 90)
    await h.waitStatus("notes")
    await h.click(repair, /^Retry$/, 90)
    await h.click(repair, /^Retry$/, 91)
    expect(h.state.bufferWrites).toHaveLength(1)
    await h.waitMessage(/^Added to your Buffer queue/)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("requests Buffer reauthorization and retries the same approved Note after same-account repair", async () => {
  const h = await createWorkflowSanity({ model })
  try {
    await h.message("/note Small releases.")
    const review = await h.waitMessage(/^A small release/)
    await h.setBufferGrant(true)
    await h.click(review, /^Publish$/)
    const repair = await h.waitMessage(/Reconnect using Connect Buffer/)
    expect(h.state.bufferRefreshes).toBe(1)
    expect(repair.replyMarkup?.inline_keyboard).toEqual([
      expect.arrayContaining([{ text: "Connect Buffer", url: "https://kipp.test/setup/buffer" }]),
    ])
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.setBufferGrant()
    await h.click(repair, /^Retry$/)
    await h.waitStatus("notes")
    expect(h.state.modelCalls).toBe(1)
    expect(h.state.bufferWrites).toHaveLength(1)
    expect(h.state.bufferWrites[0].text).toBe(NOTE)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("seals a rejected guard before changed timing gets fresh approval", async () => {
  const h = await createWorkflowSanity({
    userTurnLimit: 8,
    model: (_body, call) =>
      toolResponse("submit_note", {
        commentary: "One idea.",
        text: NOTE,
        timing: call === 1 ? { kind: "now" } : { kind: "queue" },
      }),
  })
  try {
    await h.message("/note Small releases.")
    const first = await h.waitMessage(/^A small release/)
    h.state.bufferDisconnected = true
    await h.click(first, /^Publish$/)
    const repair = await h.waitMessage(/Reconnect the Substack channel inside Buffer/)
    h.state.bufferDisconnected = false
    await h.message("Put it in my queue instead.", repair.messageId)
    const revised = await h.waitMessage(/^A small release/, repair.messageId)
    await h.click(repair, /^Retry$/)
    expect(h.state.bufferWrites).toHaveLength(0)
    await h.click(revised, /^Add to queue$/)
    await h.waitStatus("notes")
    expect(h.state.bufferWrites).toHaveLength(1)
    expect(h.state.bufferWrites[0].mode).toBe("addToQueue")
  } finally {
    await h.dispose()
  }
}, 30_000)

it("stops offering Retry after three definitive no-create failures", async () => {
  const h = await createWorkflowSanity({ model, userTurnLimit: 8 })
  try {
    await h.message("/note Small releases.")
    const review = await h.waitMessage(/^A small release/)
    h.state.bufferDisconnected = true
    await h.click(review, /^Publish$/)
    let repair = await h.waitMessage(/Reconnect the Substack channel inside Buffer/)
    for (let retry = 0; retry < 2; retry++) {
      await h.click(repair, /^Retry$/)
      repair = await h.waitMessage(/Reconnect the Substack channel inside Buffer/, repair.messageId)
    }
    const buttons = repair.replyMarkup?.inline_keyboard as Array<Array<{ text: string }>>
    expect(buttons.flat().some((button) => button.text === "Retry")).toBe(false)
    expect(buttons.flat().some((button) => button.text === "Revise")).toBe(true)
    expect(h.state.bufferWrites).toHaveLength(0)
    expect(h.state.modelCalls).toBe(1)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("requires fresh destination review after reauthorization changes the account", async () => {
  const h = await createWorkflowSanity({ model })
  try {
    await h.message("/note Small releases.")
    const review = await h.waitMessage(/^A small release/)
    await h.setBufferGrant(true)
    await h.click(review, /^Publish$/)
    const repair = await h.waitMessage(/Reconnect using Connect Buffer/)
    await h.setBufferGrant(false, "another-buffer-account")
    await h.click(repair, /^Retry$/)
    await h.waitStatus("notes")
    await h.waitMessage(/account or channel changed/)
    expect(h.state.bufferWrites).toHaveLength(0)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("confirms queue acceptance without inventing a slot when dueAt is absent", async () => {
  const h = await createWorkflowSanity({
    model: () => toolResponse("submit_note", { commentary: "One idea.", text: NOTE, timing: { kind: "queue" } }),
    bufferResult: (input) => ({
      data: {
        createPost: {
          __typename: "PostActionSuccess",
          post: {
            id: "p",
            channelId: input.channelId,
            channelService: "substack",
            text: input.text,
            status: "scheduled",
            shareMode: "addToQueue",
            schedulingType: "automatic",
            isCustomScheduled: false,
            sharedNow: false,
            dueAt: null,
            metadata: { linkAttachment: null },
          },
        },
      },
    }),
  })
  try {
    await h.message("/note Small releases. Queue it.")
    const review = await h.waitMessage(/^A small release/)
    await h.click(review, /^Add to queue$/)
    await h.waitStatus("notes")
    expect((await h.waitMessage(/^Added to your Buffer queue/)).text).toBe("Added to your Buffer queue.")
    expect(h.state.bufferWrites).toHaveLength(1)
  } finally {
    await h.dispose()
  }
}, 30_000)

it("runs the scheduled sanity journey with an equivalent UTC zone", async () => {
  const h = await createWorkflowSanity({
    model: (_body, call) =>
      toolResponse("submit_note", {
        commentary: "One idea.",
        text: NOTE,
        timing:
          call === 1
            ? {
                kind: "schedule",
                date: { kind: "absolute", localDate: "2030-01-01" },
                localTime: "09:00",
                timeZone: "Etc/UTC",
                source: "initial",
              }
            : { kind: "unchanged" },
      }),
  })
  try {
    await notesScheduledJourney(h)
  } finally {
    await h.dispose()
  }
}, 30_000)
