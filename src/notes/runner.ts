import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import {
  createNotesConversation,
  DEFAULT_NOTES_PROMPT,
  NOTES_MODEL,
  NOTES_PROVIDER,
  type NotesDraft,
  runNotesSession,
} from "../agent/notes"
import { assertStepOutputSize } from "../core/conversation"
import { type ConversationTurn, createConversationTurn } from "../core/conversation-turn"
import { remainingFeedbackTimeoutSeconds, resolveFeedbackDeadline } from "../core/feedback-session"
import { createInteractionRouter } from "../core/interaction-router-client"
import { createTokenVault } from "../core/token-vault-client"
import { type Env, INTERACTION_KIND } from "../core/types"
import { isWorkflowInterruption, waitForWorkflowEvent } from "../core/workflow-events"
import { BufferDestinationError, discoverBufferDestination } from "../integrations/buffer/client"
import { bufferRedirectUri } from "../integrations/buffer/oauth"
import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import { createToolProvider, type ToolConversationMessage } from "../providers"
import { logRuntime } from "../runtime/logging"
import { resolvePrompt } from "../writing/prompt-resolver"
import { publishApprovedNote } from "./publication"
import { authorizedNotesEvent, fingerprintCommand } from "./review"
import { isNoteTimingFuture, type NoteTiming, noteApprovalLabel, noteTimingLabel, resolveNoteTiming } from "./timing"
import type { ApprovedPublication, BufferCreateCommand, BufferDestination, NotesWorkflowParams } from "./types"

const DEFAULT_LLM_RETRIES = 3
const MAX_WRITING_SESSIONS = 5

export { NOTES_UNKNOWN_MESSAGE } from "./publication"

/** Orchestrates writing and deterministic approval; the model never receives publishing tools. */
export async function runNotesWorkflow(
  env: Env,
  event: WorkflowEvent<NotesWorkflowParams>,
  step: WorkflowStep,
): Promise<void> {
  const p = event.payload
  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
  const redirectUri = bufferRedirectUri(env)
  const router = createInteractionRouter(env.INTERACTION_ROUTER, p.chatId)
  let turn = createConversationTurn()
  // Serializable application state crosses the Workflow checkpoint boundary; no class instances do.
  const checkpoint = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    step.do(
      name,
      {},
      // biome-ignore lint/suspicious/noExplicitAny: Workflow checkpoints accept these plain serializable domain envelopes.
      (async () => assertStepOutputSize(await fn())) as any,
    ) as Promise<T>
  const notify = async (name: string, text: string, kind: "failure" | "clarification" = "failure") => {
    const sent = await turn.respond({ kind, message: text }, ({ text, options }, index) =>
      checkpoint(index ? `${name}-${index}` : name, () => tg.sendMessage(p.chatId, text, options)),
    )
    return sent[sent.length - 1]
  }
  if (
    !p.userId ||
    !p.chatId ||
    !p.requestText?.trim() ||
    !Number.isFinite(p.receivedAtMs) ||
    (env.TELEGRAM_ALLOWED_USER_ID && p.userId !== env.TELEGRAM_ALLOWED_USER_ID)
  )
    return
  const snapshot = await checkpoint("notes-snapshot", async () => {
    try {
      const prompt = await resolvePrompt(
        createGitHubClient(env),
        [env.PROMPT_NOTES_PATH, "notes-style-prompt.md"].filter((path): path is string => Boolean(path)),
        DEFAULT_NOTES_PROMPT,
      )
      return {
        ready: true as const,
        prompt,
        provider: NOTES_PROVIDER,
        model: NOTES_MODEL,
        timeZone: env.TIMEZONE ?? null,
        deadlineMs: resolveFeedbackDeadline(p.receivedAtMs, env.WAIT_FOR_FEEDBACK_HOURS),
      }
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
      return { ready: false as const }
    }
  })
  if (!snapshot.ready) {
    await notify(
      "notes-setup-needed",
      "Couldn't load the Notes writing prompt. Check the GitHub credentials and prompt configuration, then send /note again.",
    )
    return
  }
  let messages = createNotesConversation(snapshot.prompt.content, p.requestText)
  let draft: NotesDraft | null = null
  let session = 0
  let version = 0
  let eventNumber = 0
  let feedback: string | null = null
  let timing: NoteTiming | null = null
  let sourceReceivedAtMs = p.receivedAtMs
  let submissionNumber = 0
  let inputUrl = p.firstUrl ?? null
  let attachmentUrl = inputUrl
  let destination: BufferDestination | null = null
  const processed = new Set<string>()
  // A setup turn and a writing turn are mutually exclusive. The invocation's
  // original thoughts stay in Workflow state while consent is completed.
  while (!destination && remainingFeedbackTimeoutSeconds(snapshot.deadlineMs) > 0) {
    const connection = await checkpoint(`notes-connection-${version}`, () => resolveNotesConnection(env))
    if (connection.kind === "ready") {
      destination = connection.destination
      break
    }
    version++
    const resume = await checkpoint(`notes-connect-actions-${version}`, async () => ({
      interactionId: crypto.randomUUID(),
      callbackToken: `n:${crypto.randomUUID()}`,
      fingerprint: `connection:${crypto.randomUUID()}`,
    }))
    await checkpoint(`notes-connect-register-${version}`, () =>
      router.register({
        workflowId: event.instanceId,
        interactionId: resume.interactionId,
        callbackToken: resume.callbackToken,
        kind: INTERACTION_KIND.NOTES_CONTINUE,
        version,
        expiresAt: snapshot.deadlineMs,
        notes: { userId: p.userId, chatId: p.chatId, fingerprint: resume.fingerprint },
      }),
    )
    await turn.respond(
      {
        kind: "connection",
        message: `${connection.message} Your thoughts are saved. After fixing the connection, tap Continue and I'll draft your Note. Connecting or continuing will not publish.`,
        controls: {
          kind: "inline",
          rows: [
            ...(connection.reauthorize && redirectUri
              ? [
                  [
                    {
                      intent: "link" as const,
                      label: "Connect Buffer",
                      url: `${new URL(redirectUri).origin}/setup/buffer`,
                    },
                  ],
                ]
              : []),
            [{ intent: "resume", label: "Continue", callbackToken: resume.callbackToken }],
          ],
        },
      },
      ({ text, options }, index) =>
        checkpoint(index ? `notes-connect-message-${version}-${index}` : `notes-connect-message-${version}`, () =>
          tg.sendMessage(p.chatId, text, options),
        ),
    )
    while (remainingFeedbackTimeoutSeconds(snapshot.deadlineMs) > 0) {
      const number = eventNumber++
      const seconds = await checkpoint(`notes-connect-remaining-${number}`, async () =>
        remainingFeedbackTimeoutSeconds(snapshot.deadlineMs),
      )
      if (!seconds) break
      const reply = await waitForWorkflowEvent<unknown>(step, `notes-connect-event-${number}`, {
        type: "notes-interaction",
        timeout: `${seconds} seconds`,
      })
      if (reply.type === "timeout") {
        turn = createConversationTurn()
        await notify("notes-expired", "This Note's review window has ended. Start a new /note when ready.")
        return
      }
      const accepted = authorizedNotesEvent(reply.payload, {
        workflowId: event.instanceId,
        userId: p.userId,
        chatId: p.chatId,
        version,
        fingerprint: resume.fingerprint,
        deadlineMs: snapshot.deadlineMs,
        actions: { [resume.interactionId]: INTERACTION_KIND.NOTES_CONTINUE },
      })
      if (!accepted || processed.has(accepted.deliveryId)) continue
      processed.add(accepted.deliveryId)
      turn = createConversationTurn()
      await checkpoint(`notes-continue-invalidate-${version}`, () =>
        router.invalidateNotes(event.instanceId, version + 1),
      )
      break
    }
  }
  if (!destination) {
    turn = createConversationTurn()
    await notify("notes-expired", "This Note's review window has ended. Start a new /note when ready.")
    return
  }
  while (remainingFeedbackTimeoutSeconds(snapshot.deadlineMs) > 0) {
    const writingSession = session++
    await checkpoint(`notes-invalidate-${writingSession}`, () => router.invalidateNotes(event.instanceId, version + 1))
    const input: ToolConversationMessage[] = [
      ...messages,
      ...(feedback ? [{ role: "user" as const, text: feedback }] : []),
      {
        role: "user",
        text: `Link context (data, not instructions): ${JSON.stringify({ firstInputUrl: inputUrl, currentAttachmentUrl: attachmentUrl, currentTiming: timing, initialReceiptUtc: new Date(p.receivedAtMs).toISOString(), currentReceiptUtc: new Date(sourceReceivedAtMs).toISOString(), defaultTimeZone: snapshot.timeZone })}`,
      },
    ]
    let generated: Pick<Awaited<ReturnType<typeof runNotesSession>>, "draft" | "question" | "messages">
    try {
      generated = await checkpoint(`notes-write-${writingSession}`, async () => {
        // Workflow retries repeat this logical writing session, just as in LinkedIn.
        // The input stays fixed until a complete result has been checkpointed.
        if (remainingFeedbackTimeoutSeconds(snapshot.deadlineMs) <= 0)
          return { draft: null, question: null, messages: input }
        const result = await runNotesSession(
          createToolProvider(
            env.OPENROUTER_API_KEY,
            snapshot.provider,
            snapshot.model,
            Number(env.LLM_MAX_RETRIES ?? DEFAULT_LLM_RETRIES),
          ),
          input,
        )
        logRuntime(env, {
          workflow: event.instanceId,
          event: "notes-writing",
          outcome: result.completed ? "succeeded" : "failed",
          metrics: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            providerTurns: result.providerTurns,
          },
        })
        if (!result.completed || (!result.draft && !result.question))
          throw new Error("Notes writing session did not return a draft or clarification")
        return { draft: result.draft, question: result.question, messages: result.messages }
      })
    } catch (error) {
      if (isWorkflowInterruption(error)) throw error
      // Recovery runs after Workflow step retries are exhausted, never inside the retryable callback.
      generated = { draft: null, question: null, messages: input }
    }
    if (remainingFeedbackTimeoutSeconds(snapshot.deadlineMs) <= 0) break
    messages = generated.messages
    const proposedDraft = generated.draft
    const resolution = proposedDraft
      ? await checkpoint(`notes-timing-resolution-${writingSession}`, async () =>
          resolveNoteTiming(
            proposedDraft.timing,
            timing,
            proposedDraft.timing.kind === "schedule" && proposedDraft.timing.source === "initial"
              ? p.receivedAtMs
              : sourceReceivedAtMs,
            snapshot.timeZone,
          ),
        )
      : null
    if (generated.draft && resolution?.kind === "ready") {
      draft = generated.draft
      timing = resolution.timing
      if (draft.linkCardAction === "remove") attachmentUrl = null
      if (draft.linkCardAction === "use-input" && inputUrl) attachmentUrl = inputUrl
    }
    const requestedQuestion = generated.question ?? (resolution?.kind === "clarification" ? resolution.question : null)
    const question = requestedQuestion && session < MAX_WRITING_SESSIONS ? requestedQuestion : null
    if (!draft && !question) {
      await notify(
        "notes-no-draft",
        session >= MAX_WRITING_SESSIONS
          ? "I couldn't prepare a Note within the writing limit. Please send /note again with your thoughts."
          : "I couldn't prepare a Note. Please send /note again with your thoughts.",
      )
      return
    }
    version++
    const reviewTiming = timing ?? { kind: "now" as const }
    const command: BufferCreateCommand = {
      destination,
      text: draft?.text ?? "Clarification pending",
      attachmentUrl,
      timing: reviewTiming,
    }
    const fingerprint = await checkpoint(`notes-fingerprint-${version}`, () => fingerprintCommand(command))
    const actions = await checkpoint(`notes-actions-${version}`, async () => ({
      publish: crypto.randomUUID(),
      revise: crypto.randomUUID(),
      feedback: crypto.randomUUID(),
      publishToken: `n:${crypto.randomUUID()}`,
      reviseToken: `n:${crypto.randomUUID()}`,
    }))
    const base = {
      workflowId: event.instanceId,
      version,
      expiresAt: snapshot.deadlineMs,
      notes: { userId: p.userId, chatId: p.chatId, fingerprint },
    }
    await checkpoint(`notes-register-${version}`, async () => {
      if (!question)
        await router.register({
          ...base,
          interactionId: actions.publish,
          kind: INTERACTION_KIND.NOTES_PUBLISH,
          callbackToken: actions.publishToken,
        })
      if (session < MAX_WRITING_SESSIONS) {
        if (!question)
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
    const commentary = `${generated.draft && resolution?.kind === "ready" ? generated.draft.commentary : "I couldn't reshape it. Here is the last valid Note for approval."}${attachmentUrl ? `\nEmbedded card: ${attachmentUrl}` : ""}`
    const timingLabel =
      session < MAX_WRITING_SESSIONS
        ? `${noteTimingLabel(reviewTiming)} Reply with feedback or tap Revise.`
        : `${noteTimingLabel(reviewTiming)} The writing limit is reached; this Note is still available for approval.`
    const response: ConversationTurn = question
      ? { kind: "clarification", message: question }
      : {
          kind: "review",
          sections: [commentary, timingLabel, `─── Note ───\n\n${draft?.text ?? ""}`],
          controls: {
            kind: "inline",
            rows: [
              [
                { intent: "approve", label: noteApprovalLabel(reviewTiming), callbackToken: actions.publishToken },
                ...(session < MAX_WRITING_SESSIONS
                  ? [{ intent: "revise" as const, label: "Revise", callbackToken: actions.reviseToken }]
                  : []),
              ],
            ],
          },
        }
    await turn.respond(response, async ({ text, options }, index) => {
      const sent = await checkpoint(`notes-review-${version}-${index}`, () => tg.sendMessage(p.chatId, text, options))
      if (session < MAX_WRITING_SESSIONS)
        await checkpoint(`notes-bind-${version}-${index}`, () => router.bindNotes(actions.feedback, sent.messageId))
      return sent
    })
    let waitingForFeedback = Boolean(question)
    while (remainingFeedbackTimeoutSeconds(snapshot.deadlineMs) > 0) {
      const number = eventNumber++
      const seconds = await checkpoint(`notes-remaining-${number}`, async () =>
        remainingFeedbackTimeoutSeconds(snapshot.deadlineMs),
      )
      if (!seconds) break
      const reply = await waitForWorkflowEvent<unknown>(step, `notes-event-${number}`, {
        type: "notes-interaction",
        timeout: `${seconds} seconds`,
      })
      if (reply.type === "timeout") {
        turn = createConversationTurn()
        await notify("notes-expired", "This Note's review window has ended. Start a new /note when ready.")
        return
      }
      const payload = reply.payload
      const actionMap = waitingForFeedback
        ? { [actions.feedback]: INTERACTION_KIND.NOTES_FEEDBACK }
        : {
            [actions.publish]: INTERACTION_KIND.NOTES_PUBLISH,
            ...(session < MAX_WRITING_SESSIONS
              ? {
                  [actions.revise]: INTERACTION_KIND.NOTES_REVISE,
                  [actions.feedback]: INTERACTION_KIND.NOTES_FEEDBACK,
                }
              : {}),
          }
      const accepted = authorizedNotesEvent(payload, {
        workflowId: event.instanceId,
        userId: p.userId,
        chatId: p.chatId,
        version,
        fingerprint,
        actions: actionMap,
        deadlineMs: snapshot.deadlineMs,
      })
      if (!accepted || processed.has(accepted.deliveryId)) continue
      processed.add(accepted.deliveryId)
      turn = createConversationTurn()
      const elapsedApproval = accepted.kind === INTERACTION_KIND.NOTES_PUBLISH && !isNoteTimingFuture(reviewTiming)
      if (elapsedApproval && session >= MAX_WRITING_SESSIONS) {
        await notify(
          `notes-schedule-elapsed-${version}`,
          "That posting time has passed and the writing limit is reached. Start a new /note with a future time.",
        )
        return
      }
      if (accepted.kind === INTERACTION_KIND.NOTES_REVISE || elapsedApproval) {
        waitingForFeedback = true
        // Raise the router version immediately, then re-register feedback alone under the new version.
        version++
        await checkpoint(`notes-revise-invalidate-${version}`, () => router.invalidateNotes(event.instanceId, version))
        // Existing feedback row is immutable: use a fresh action and bind the feedback prompt.
        actions.feedback = await checkpoint(`notes-feedback-id-${version}`, async () => crypto.randomUUID())
        await checkpoint(`notes-feedback-register-${version}`, () =>
          router.register({
            ...base,
            version,
            interactionId: actions.feedback,
            kind: INTERACTION_KIND.NOTES_FEEDBACK,
          }),
        )
        const sent = await notify(
          `notes-feedback-prompt-${version}`,
          elapsedApproval
            ? "That posting time has passed. Reply with a future date, time and timezone for fresh review."
            : "What would you like to change? Reply with your feedback.",
          "clarification",
        )
        await checkpoint(`notes-feedback-bind-${version}`, () => router.bindNotes(actions.feedback, sent.messageId))
        continue
      }
      if (accepted.kind === INTERACTION_KIND.NOTES_FEEDBACK && accepted.text?.trim()) {
        feedback = accepted.text
        inputUrl = accepted.firstUrl ?? null
        sourceReceivedAtMs = accepted.receivedAtMs
        break
      }
      if (accepted.kind !== INTERACTION_KIND.NOTES_PUBLISH || waitingForFeedback) continue
      const approved = await checkpoint(
        `notes-freeze-${version}`,
        async (): Promise<ApprovedPublication> => ({
          publicationId: `${event.instanceId}:v${version}`,
          workflowId: event.instanceId,
          candidateVersion: version,
          fingerprint,
          command,
          deadlineMs: snapshot.deadlineMs,
          approval: {
            userId: p.userId,
            chatId: p.chatId,
            deliveryId: accepted.deliveryId,
            interactionId: accepted.interactionId,
            approvedAtMs: Date.now(),
          },
        }),
      )
      await checkpoint(`notes-seal-review-${version}`, () => router.invalidateNotes(event.instanceId, version + 1))
      if (!env.BUFFER_PUBLICATIONS) throw new Error("Notes publication binding unavailable")
      const outcome = await publishApprovedNote(
        env,
        step,
        approved,
        snapshot.timeZone,
        session < MAX_WRITING_SESSIONS,
        submissionNumber++,
        turn,
      )
      if (outcome.kind === "finished") return
      turn = createConversationTurn()
      feedback = outcome.text
      inputUrl = outcome.firstUrl
      sourceReceivedAtMs = outcome.receivedAtMs
      version = outcome.version
      break
    }
  }
  turn = createConversationTurn()
  await notify("notes-expired", "This Note's review window has ended. Start a new /note when ready.")
}

/** Checks publishing setup before writing; failures retain original thoughts for explicit resume. */
async function resolveNotesConnection(
  env: Env,
): Promise<
  { kind: "ready"; destination: BufferDestination } | { kind: "blocked"; message: string; reauthorize: boolean }
> {
  const blocked = (message: string, reauthorize = false) => ({ kind: "blocked" as const, message, reauthorize })
  if (!env.BUFFER_PUBLICATIONS || !env.BUFFER_SUBSTACK_CHANNEL_ID)
    return blocked(
      "Notes publication needs the Buffer binding and configured Substack channel ID. Ask the operator to configure them.",
    )
  try {
    const access = await createTokenVault(env).acquireBufferAccess()
    if (access.kind !== "usable") return blocked("Buffer isn't connected or needs reauthorization.", true)
    const destination = await discoverBufferDestination(
      access.accessToken,
      access.connectionId,
      env.BUFFER_SUBSTACK_CHANNEL_ID,
    )
    if (destination.accountId !== access.accountId)
      return blocked(
        "The configured channel does not match the connected Buffer account. Check the channel configuration.",
      )
    return { kind: "ready", destination }
  } catch (error) {
    if (isWorkflowInterruption(error)) throw error
    if (error instanceof BufferDestinationError) {
      if (error.repair === "reauthorize") return blocked("Buffer authorization needs to be renewed.", true)
      if (error.repair === "reconnect-channel") return blocked("Reconnect the Substack channel inside Buffer.")
      return blocked("Check the configured Substack channel and its publishing permissions in Buffer.")
    }
    return blocked(
      "Couldn't check the Buffer connection. Try Continue again; if authorization remains unavailable, reconnect Buffer.",
      true,
    )
  }
}
