import { expect } from "vitest"
import { formatNoteInstant } from "../../notes/timing"
import { expectConversationResponse } from "./conversation-contract"
import { type createWorkflowSanity, type ScriptedModel, toolResponse, type WireBody } from "./workflow-sanity"

type Harness = Awaited<ReturnType<typeof createWorkflowSanity>>

/** Reads the persisted receipt supplied to the writer, without depending on the test runner's clock. */
export function notesReceipt(body: WireBody, source: "initial" | "current" = "current"): number {
  const messages = body.messages as Array<{ content?: string }>
  const context = [...messages]
    .reverse()
    .find((message) => message.content?.startsWith("Link context (data, not instructions): "))
  if (!context?.content) throw new Error("Missing Notes receipt context")
  const parsed = JSON.parse(context.content.slice(context.content.indexOf(": ") + 2))
  return Date.parse(source === "initial" ? parsed.initialReceiptUtc : parsed.currentReceiptUtc)
}

/** Exercises elapsed-time extraction, a new relative anchor, and prose-only preservation through Buffer acceptance. */
export async function notesRelativeJourney(harness: Harness): Promise<void> {
  const findReview = (afterId = 0) =>
    harness.until(() =>
      harness.network.getState().telegramMessages.find((message) => {
        const rows = message.replyMarkup?.inline_keyboard as Array<Array<{ text: string }>> | undefined
        return message.messageId > afterId && rows?.flat().some((button) => button.text === "Schedule")
          ? message
          : undefined
      }),
    )
  await harness.message("/note Small releases make feedback easier to act on. Publish this three hours later.")
  const first = await findReview()
  const initialDue = new Date(notesReceipt(harness.state.transcript[0].request) + 180 * 60_000).toISOString()
  expect(first.text).toContain(formatNoteInstant(initialDue, "Asia/Kolkata"))
  await harness.message(
    "Actually, publish it in 90 minutes from now instead. Keep the Note text unchanged.",
    first.messageId,
  )
  const second = await findReview(first.messageId)
  const revisionRequest = harness.state.transcript.at(-1)?.request
  if (!revisionRequest) throw new Error("Missing revised request")
  const dueAt = new Date(notesReceipt(revisionRequest) + 90 * 60_000).toISOString()
  expect(second.text).toContain(formatNoteInstant(dueAt, "Asia/Kolkata"))
  await harness.message("Tighten the wording. Keep the posting time unchanged.", second.messageId)
  const final = await findReview(second.messageId)
  expect(final.text).toContain(formatNoteInstant(dueAt, "Asia/Kolkata"))
  expectConversationResponse([final], "review", ["Timing:", "─── Note ───"])
  await harness.click(final, /^Schedule$/)
  await harness.waitStatus("notes")
  expect(harness.state.bufferWrites).toHaveLength(1)
  expect(harness.state.bufferWrites[0]).toMatchObject({ mode: "customScheduled", dueAt })
  expect(harness.state.failures).toEqual([])
}

/** Finds an actual evaluator output in the production provider's wire transcript. */
function evaluation(body: WireBody): { planId?: string; issues: Array<{ code: string }> } {
  const messages = body.messages as Array<{ role: string; content: string }>
  const tool = [...messages].reverse().find((message) => message.role === "tool")
  if (!tool) throw new Error("Missing Calendar evaluation result")
  return JSON.parse(tool.content).output
}

export const scriptedLinkedIn: ScriptedModel = (_body, call) =>
  toolResponse("submit_linkedin_response", {
    response: call === 1 ? "A concrete point about small releases." : "Revised with the requested closing sentence.",
    post:
      call === 1
        ? "Small releases make feedback easier to act on."
        : "Small releases make feedback easier to act on. Keep the next step small.",
  })

/** Scripts evaluator handoffs, leaving validation, authorization and HTTP writes to production code. */
export function scriptedCalendar(date: string, time: string, clarifyFirst = false): ScriptedModel {
  return (body, call) => {
    if (clarifyFirst && call === 1)
      return toolResponse("needs_user_input", {
        message: "What time should I schedule the call?",
        reasonCodes: ["missing_or_invalid_time"],
        interaction: { kind: "reply" },
      })
    if ((call - (clarifyFirst ? 1 : 0)) % 2 === 1)
      return toolResponse("evaluate_calendar_candidate", {
        kind: "one_off",
        proposal: {
          title: "Call Jamie",
          localDate: date,
          startTime: time,
          durationMinutes: 30,
          dateIsExplicit: true,
          timeIsExplicit: true,
          classification: "ordinary",
          needsClarification: false,
        },
      })
    const result = evaluation(body)
    return result.planId
      ? toolResponse("ready_to_create", { planId: result.planId })
      : toolResponse("needs_user_input", {
          message: "That local time is not unique. Please choose another time.",
          reasonCodes: result.issues.map((issue) => issue.code),
          interaction: { kind: "reply" },
        })
  }
}

/** Drives real Telegram buttons and feedback through to one exact approved LinkedIn DRAFT request. */
export async function linkedInJourney(harness: Harness): Promise<void> {
  expect(await harness.message("/generate 1")).toBe(200)
  const initial = await harness.waitMessage(/^Draft for idea/)
  expectConversationResponse(
    harness.network.getState().telegramMessages.filter((message) => !message.text.startsWith("Started workflow")),
    "review",
    ["Draft for idea", "Will be posted as a LinkedIn draft:"],
  )
  expect(harness.state.linkedinWrites).toHaveLength(0)
  expect(await harness.click(initial, /^Revise/)).toBe(200)
  await harness.waitMessage(/Type your revision feedback/)
  await harness.until(() =>
    harness.state.registrations.find(
      (registration) => registration.kind === "revision-feedback" && !registration.botMessageId,
    ),
  )
  expect(
    await harness.message('Keep the topic. End the post with this exact sentence: "Keep the next step small."'),
  ).toBe(200)
  const revised = await harness.waitMessage(/^Revised draft for idea/, initial.messageId)
  expectConversationResponse(
    harness.network.getState().telegramMessages.filter((message) => message.messageId === revised.messageId),
    "review",
    ["Revised draft for idea", "Will be posted as a LinkedIn draft:"],
  )
  expect(harness.state.linkedinWrites).toHaveLength(0)
  expect(await harness.click(revised, /^Approve/, 90)).toBe(200)
  await harness.waitStatus("linkedin")
  // Redelivery of the same Telegram callback must not submit another draft.
  expect(await harness.click(revised, /^Approve/, 90)).toBe(200)
  expect(harness.state.linkedinWrites).toHaveLength(1)
  const write = harness.state.linkedinWrites[0]
  expect(write).toMatchObject({ author: "urn:li:person:synthetic", lifecycleState: "DRAFT" })
  const content = write.specificContent as Record<string, { shareCommentary: { text: string } }>
  const published = content["com.linkedin.ugc.ShareContent"].shareCommentary.text
  expect(published.endsWith("Keep the next step small.")).toBe(true)
  expect(revised.text).toContain(published)
  expect(harness.network.getState().notionPages.get("page_1")?.status).toBe("finalized")
  expect(harness.state.failures).toEqual([])
}

/** Exercises a real clarification and user reply before checking the serialized Calendar event. */
export async function calendarJourney(harness: Harness): Promise<void> {
  expect(
    await harness.message("/calendar Call Jamie on 2027-07-28 for 30 minutes. Ask me what time before scheduling."),
  ).toBe(200)
  const question = await harness.waitMessage(/\?/)
  expectConversationResponse(
    harness.network.getState().telegramMessages.filter((message) => message.text !== "Scheduling that now."),
    "clarification",
  )
  await harness.until(() =>
    harness.state.registrations.find((registration) => registration.kind === "calendar-clarification"),
  )
  expect(harness.state.calendarWrites).toHaveLength(0)
  expect(await harness.message("7pm, in Asia/Kolkata.", question.messageId)).toBe(200)
  await harness.waitStatus("calendar")
  expect(harness.state.calendarWrites).toHaveLength(1)
  expectConversationResponse(
    harness.network.getState().telegramMessages.filter((message) => message.messageId > question.messageId),
    "confirmation",
    ["Added: Call Jamie"],
  )
  expect(harness.state.calendarWrites[0]).toMatchObject({
    summary: "Call Jamie",
    start: { dateTime: "2027-07-28T13:30:00.000Z", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2027-07-28T14:00:00.000Z", timeZone: "Asia/Kolkata" },
    visibility: "private",
    transparency: "opaque",
  })
  expect(
    harness.network.getState().telegramMessages.some((message) => message.text?.includes("Added: Call Jamie")),
  ).toBe(true)
  expect(harness.state.failures).toEqual([])
}

/** Uses a bounded real or scripted writer, then approves the exact visible Note through Telegram. */
export async function notesJourney(harness: Harness): Promise<void> {
  expect(
    await harness.message(
      "/note I've noticed that smaller releases make feedback easier to act on. Before drafting, ask me which tradeoff I want to highlight. Use this as the card: https://example.com/small-releases. Add the final Note to my Buffer queue.",
    ),
  ).toBe(200)
  const question = await harness.waitMessage(/\?/)
  expect(harness.state.registrations.some((r) => r.kind === "notes-publish")).toBe(false)
  expect(
    await harness.message(
      "One small decision is easier to understand and reverse, though each release needs attention. Focus on that tradeoff.",
      question.messageId,
    ),
  ).toBe(200)
  const findReview = (afterId = 0) =>
    harness.until(() =>
      harness.network.getState().telegramMessages.find((message) => {
        const buttons = message.replyMarkup?.inline_keyboard as Array<Array<{ text: string }>> | undefined
        return message.messageId > afterId && buttons?.flat().some((button) => button.text === "Add to queue")
          ? message
          : undefined
      }),
    )
  const initial = await findReview()
  expectConversationResponse(
    harness.network.getState().telegramMessages.filter((message) => message.messageId > question.messageId),
    "review",
    ["Timing:", "─── Note ───"],
  )
  expect(
    await harness.message("Make the opening more concrete. Keep the same idea and embedded card.", initial.messageId),
  ).toBe(200)
  const review = await findReview(initial.messageId)
  expect(review.text?.trim().length).toBeGreaterThan(0)
  expect(harness.state.bufferWrites).toHaveLength(0)
  expect(await harness.click(review, /^Add to queue$/, 90)).toBe(200)
  await harness.waitStatus("notes")
  expect(harness.state.bufferWrites).toHaveLength(1)
  expect(harness.state.bufferWrites[0]).toMatchObject({
    text: review.text?.split("\n\n─── Note ───\n\n").at(-1),
    mode: "addToQueue",
    saveToDraft: false,
    needsApproval: false,
    metadata: { substack: { linkAttachment: { url: "https://example.com/small-releases" } } },
  })
  const acceptance = await harness.waitMessage(/^Added to your Buffer queue/)
  expect(acceptance.text).toContain("2030-01-01 19:00 Asia/Kolkata")
  expect(harness.state.bufferWrites[0]).not.toHaveProperty("dueAt")
  expect(harness.state.failures).toEqual([])
}

/** Exercises real timing extraction and preservation, keeping provider account writes simulated. */
export async function notesScheduledJourney(harness: Harness): Promise<void> {
  await harness.message(
    "/note Small releases make feedback easier to act on. Schedule this Note for 2030-01-01 at 9am UTC.",
  )
  const findReview = (afterId = 0) =>
    harness.until(() =>
      harness.network.getState().telegramMessages.find((message) => {
        const buttons = message.replyMarkup?.inline_keyboard as Array<Array<{ text: string }>> | undefined
        return message.messageId > afterId &&
          (buttons?.flat().some((button) => ["Publish", "Schedule", "Add to queue"].includes(button.text)) ||
            harness.state.boundNotesMessages.includes(message.messageId))
          ? message
          : undefined
      }),
    )
  const initial = await findReview()
  const initialButtons = initial.replyMarkup?.inline_keyboard as Array<Array<{ text: string }>> | undefined
  expect(initialButtons?.flat().some((button) => button.text === "Schedule")).toBe(true)
  expect((await harness.waitMessage(/Timing:/)).text).toContain("2030-01-01 09:00")
  await harness.message("Make the opening more concrete. Keep the posting time unchanged.", initial.messageId)
  const review = await findReview(initial.messageId)
  await harness.click(review, /^Schedule$/)
  await harness.waitStatus("notes")
  expect(harness.state.bufferWrites).toHaveLength(1)
  expect(harness.state.bufferWrites[0]).toMatchObject({
    text: review.text?.split("\n\n─── Note ───\n\n").at(-1),
    mode: "customScheduled",
    dueAt: "2030-01-01T09:00:00.000Z",
    needsApproval: false,
    saveToDraft: false,
  })
  await harness.waitMessage(/^Scheduled with Buffer for 2030-01-01 09:00 /)
}
