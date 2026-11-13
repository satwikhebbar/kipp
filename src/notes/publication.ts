import type { WorkflowStep } from "cloudflare:workers"
import { assertStepOutputSize } from "../core/conversation"
import { presentConversationTurn } from "../core/conversation-presenter"
import {
  type ConnectionAction,
  type ConversationTurnCoordinator,
  createConversationTurn,
} from "../core/conversation-turn"
import { createInteractionRouter } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND } from "../core/types"
import { isWorkflowInterruption, waitForWorkflowEvent } from "../core/workflow-events"
import { createBufferPublication, MAX_BUFFER_ATTEMPTS, NOTES_REPAIR_WAIT_MS } from "../integrations/buffer/publication"
import { createTelegramClient } from "../integrations/telegram"
import { authorizedNotesEvent } from "./review"
import { formatNoteInstant, isNoteTimingFuture } from "./timing"
import type { ApprovedPublication, BufferCreateResult } from "./types"

export const NOTES_UNKNOWN_MESSAGE =
  "I couldn't confirm submission to Buffer. The Note may already have been received; Kipp hasn't sent another attempt. The approved text remains above for you to use independently."
const MILLISECONDS_PER_SECOND = 1000

/** Confirms Buffer acceptance without promising downstream delivery or inventing a queue time. */
export function notePublicationMessage(
  result: BufferCreateResult,
  approved: ApprovedPublication,
  zone: string | null,
): string {
  if (result.kind === "accepted") {
    const timing = approved.command.timing
    const message =
      timing.kind === "queue"
        ? `Added to your Buffer queue.${result.dueAt ? `\nScheduled for ${formatNoteInstant(result.dueAt, zone)}.` : ""}`
        : timing.kind === "schedule"
          ? `Scheduled with Buffer for ${formatNoteInstant(timing.dueAt, timing.timeZone)}.`
          : "Sent to Buffer for publication."
    return `${message}${result.link ? `\n${result.link}` : ""}`
  }
  if (result.kind === "created-unexpected")
    return "Buffer created a post with unexpected settings. Kipp hasn't sent another attempt. Check Buffer; the approved text remains above."
  if (result.kind === "rejected")
    return "The Note wasn't submitted. The text remains above; start a new /note when ready."
  return NOTES_UNKNOWN_MESSAGE
}

type PublicationOutcome =
  | { kind: "finished" }
  | { kind: "revise"; text: string; firstUrl: string | null; receivedAtMs: number; version: number }

/** Owns explicit repair authority for proven no-create failures, never for uncertain submissions. */
export async function publishApprovedNote(
  env: Env,
  step: WorkflowStep,
  approved: ApprovedPublication,
  zone: string | null,
  canRevise: boolean,
  submissionNumber: number,
  turn: ConversationTurnCoordinator = createConversationTurn(),
): Promise<PublicationOutcome> {
  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
  const router = createInteractionRouter(env.INTERACTION_ROUTER, approved.approval.chatId)
  if (!env.BUFFER_PUBLICATIONS) throw new Error("Notes publication binding unavailable")
  const guard = createBufferPublication(env.BUFFER_PUBLICATIONS, approved.publicationId)
  const checkpoint = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    step.do(name, {}, (async () => assertStepOutputSize(await fn())) as never) as Promise<T>
  const prefix = `notes-publication-${approved.candidateVersion}`
  const notify = async (suffix: string, text: string, kind: "failure" | "confirmation" | "clarification") => {
    turn.claim(kind)
    const sent = await presentConversationTurn({ kind, message: text }, ({ text, options }, index) =>
      checkpoint(`${prefix}-${suffix}${index ? `-${index}` : ""}`, () =>
        tg.sendMessage(approved.approval.chatId, text, options),
      ),
    )
    return sent[sent.length - 1]
  }
  const guarded = async (operation: () => Promise<BufferCreateResult>): Promise<BufferCreateResult> => {
    try {
      return await operation()
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
      try {
        return await guard.inspect(approved.fingerprint)
      } catch (inspectionError) {
        if (isWorkflowInterruption(inspectionError)) throw inspectionError
        return { kind: "unknown", reason: "guard-unavailable" }
      }
    }
  }
  await checkpoint(`${prefix}-prepare`, () => guard.prepare(approved))
  let result = await checkpoint(submissionNumber === 0 ? "notes-submit" : `${prefix}-submit`, () =>
    guarded(() => guard.submit(approved.fingerprint)),
  )
  let version = approved.candidateVersion + 1
  let eventNumber = 0
  for (let attempt = 1; attempt <= MAX_BUFFER_ATTEMPTS; attempt++) {
    if (result.kind !== "rejected" || !result.attemptId || result.reason === "destination-changed") break
    const expectedAttemptId = result.attemptId
    const rejected = result
    const waitUntil = await checkpoint(`${prefix}-repair-deadline-${attempt}`, async () =>
      Math.min(approved.deadlineMs, Date.now() + NOTES_REPAIR_WAIT_MS),
    )
    if (Date.now() >= waitUntil) break
    const retryUntil =
      approved.command.timing.kind === "schedule"
        ? Math.min(waitUntil, Date.parse(approved.command.timing.dueAt))
        : waitUntil
    const retryEligible =
      attempt < MAX_BUFFER_ATTEMPTS &&
      rejected.repair !== "none" &&
      Date.now() < retryUntil &&
      isNoteTimingFuture(approved.command.timing)
    if (!retryEligible && !canRevise) break
    const actions = await checkpoint(`${prefix}-repair-actions-${attempt}`, async () => ({
      retry: crypto.randomUUID(),
      revise: crypto.randomUUID(),
      feedback: crypto.randomUUID(),
      retryToken: `n:${crypto.randomUUID()}`,
      reviseToken: `n:${crypto.randomUUID()}`,
    }))
    const base = {
      workflowId: approved.workflowId,
      version,
      expiresAt: waitUntil,
      notes: { userId: approved.approval.userId, chatId: approved.approval.chatId, fingerprint: approved.fingerprint },
    }
    await checkpoint(`${prefix}-repair-register-${attempt}`, async () => {
      await router.invalidateNotes(approved.workflowId, version)
      if (retryEligible)
        await router.register({
          ...base,
          expiresAt: retryUntil,
          interactionId: actions.retry,
          kind: INTERACTION_KIND.NOTES_RETRY,
          callbackToken: actions.retryToken,
        })
      if (canRevise) {
        await router.register({
          ...base,
          interactionId: actions.revise,
          kind: INTERACTION_KIND.NOTES_REVISE,
          callbackToken: actions.reviseToken,
        })
        await router.register({ ...base, interactionId: actions.feedback, kind: INTERACTION_KIND.NOTES_FEEDBACK })
      }
      return true
    })
    const origin = env.BUFFER_REDIRECT_ORIGIN
    const guidance =
      rejected.reason === "queue-paused"
        ? "Resume your queue in Buffer."
        : rejected.repair === "reauthorize"
          ? "Reconnect using Connect Buffer."
          : rejected.repair === "reconnect-channel"
            ? "Reconnect the Substack channel inside Buffer."
            : rejected.reason === "schedule-elapsed"
              ? "The posting time has passed. Revise it to choose a future time."
              : "Check your Buffer channel configuration."
    const buttons: ConnectionAction[] = [
      ...(rejected.repair === "reauthorize" && origin
        ? [{ intent: "link" as const, label: "Connect Buffer", url: `${origin}/setup/buffer` }]
        : []),
      ...(retryEligible ? [{ intent: "resume" as const, label: "Retry", callbackToken: actions.retryToken }] : []),
      ...(canRevise ? [{ intent: "revise" as const, label: "Revise", callbackToken: actions.reviseToken }] : []),
    ]
    const repairKind =
      rejected.repair === "reauthorize" || rejected.repair === "reconnect-channel" ? "connection" : "failure"
    turn.claim(repairKind)
    const sentParts = await presentConversationTurn(
      {
        kind: repairKind,
        message: `The Note wasn't submitted. ${guidance}${retryEligible ? " Then tap Retry to submit the unchanged Note." : ""}${canRevise ? " You can also reply with a change for fresh review." : ""}`,
        controls: { kind: "inline", rows: [buttons] },
      },
      ({ text, options }, index) =>
        checkpoint(`${prefix}-repair-message-${attempt}${index ? `-${index}` : ""}`, () =>
          tg.sendMessage(approved.approval.chatId, text, options),
        ),
    )
    const sent = sentParts[sentParts.length - 1]
    if (canRevise)
      await checkpoint(`${prefix}-repair-bind-${attempt}`, () => router.bindNotes(actions.feedback, sent.messageId))
    let waitingForFeedback = false
    while (Date.now() < waitUntil) {
      const number = eventNumber++
      const seconds = await checkpoint(`${prefix}-remaining-${number}`, async () =>
        Math.max(0, Math.floor((waitUntil - Date.now()) / MILLISECONDS_PER_SECOND)),
      )
      if (!seconds) break
      const response = await waitForWorkflowEvent<unknown>(step, `${prefix}-event-${number}`, {
        type: "notes-interaction",
        timeout: `${seconds} seconds`,
      })
      if (response.type === "timeout") break
      const accepted = authorizedNotesEvent(response.payload, {
        workflowId: approved.workflowId,
        userId: approved.approval.userId,
        chatId: approved.approval.chatId,
        version,
        fingerprint: approved.fingerprint,
        deadlineMs: waitUntil,
        actions: waitingForFeedback
          ? { [actions.feedback]: INTERACTION_KIND.NOTES_FEEDBACK }
          : {
              ...(retryEligible ? { [actions.retry]: INTERACTION_KIND.NOTES_RETRY } : {}),
              ...(canRevise
                ? {
                    [actions.revise]: INTERACTION_KIND.NOTES_REVISE,
                    [actions.feedback]: INTERACTION_KIND.NOTES_FEEDBACK,
                  }
                : {}),
            },
      })
      if (!accepted) continue
      turn = createConversationTurn()
      if (accepted.kind === INTERACTION_KIND.NOTES_REVISE) {
        version++
        waitingForFeedback = true
        actions.feedback = await checkpoint(`${prefix}-feedback-id-${number}`, async () => crypto.randomUUID())
        await checkpoint(`${prefix}-feedback-register-${number}`, async () => {
          await router.invalidateNotes(approved.workflowId, version)
          await router.register({
            ...base,
            version,
            interactionId: actions.feedback,
            kind: INTERACTION_KIND.NOTES_FEEDBACK,
          })
          return true
        })
        const prompt = await notify(
          `feedback-${number}`,
          "What would you like to change? Reply with your feedback.",
          "clarification",
        )
        await checkpoint(`${prefix}-feedback-bind-${number}`, () =>
          router.bindNotes(actions.feedback, prompt.messageId),
        )
        continue
      }
      if (accepted.kind === INTERACTION_KIND.NOTES_FEEDBACK && accepted.text?.trim()) {
        // Only a definitively rejected guard may be sealed before a replacement approval.
        await checkpoint(`${prefix}-supersede`, () => guard.supersedeRejected(approved.fingerprint, expectedAttemptId))
        await checkpoint(`${prefix}-seal-feedback`, () => router.invalidateNotes(approved.workflowId, version + 1))
        return {
          kind: "revise",
          text: accepted.text,
          firstUrl: accepted.firstUrl ?? null,
          receivedAtMs: accepted.receivedAtMs,
          version: version + 1,
        }
      }
      if (accepted.kind !== INTERACTION_KIND.NOTES_RETRY || Date.now() >= retryUntil) continue
      await checkpoint(`${prefix}-seal-retry-${attempt}`, () =>
        router.invalidateNotes(approved.workflowId, version + 1),
      )
      result = await checkpoint(`${prefix}-retry-${attempt}`, () =>
        guarded(() => guard.retryRejected(approved.fingerprint, expectedAttemptId, accepted)),
      )
      version++
      break
    }
    if (result === rejected) break
  }
  await checkpoint(`${prefix}-seal-result`, () => router.invalidateNotes(approved.workflowId, version + 1))
  const message =
    result.kind === "rejected" && result.reason === "destination-changed"
      ? "The Buffer account or channel changed. The Note wasn't submitted. Start a new /note for fresh destination review."
      : notePublicationMessage(result, approved, zone)
  if (turn.responded) turn = createConversationTurn() // The repair wait ended without another user response.
  await notify("result", message, result.kind === "accepted" ? "confirmation" : "failure")
  return { kind: "finished" }
}
