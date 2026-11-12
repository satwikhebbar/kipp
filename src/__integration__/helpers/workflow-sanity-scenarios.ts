import { expect } from "vitest"
import { type createWorkflowSanity, type ScriptedModel, toolResponse, type WireBody } from "./workflow-sanity"

type Harness = Awaited<ReturnType<typeof createWorkflowSanity>>

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
  const initial = await harness.waitMessage(/^\*Draft for idea/)
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
  const revised = await harness.waitMessage(/^\*Revised draft for idea/, initial.messageId)
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
  await harness.until(() =>
    harness.state.registrations.find((registration) => registration.kind === "calendar-clarification"),
  )
  expect(harness.state.calendarWrites).toHaveLength(0)
  expect(await harness.message("7pm, in Asia/Kolkata.", question.messageId)).toBe(200)
  await harness.waitStatus("calendar")
  expect(harness.state.calendarWrites).toHaveLength(1)
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
