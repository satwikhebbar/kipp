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
import { remainingFeedbackTimeoutSeconds, resolveFeedbackDeadline } from "../core/feedback-session"
import { createInteractionRouter } from "../core/interaction-router-client"
import { createTokenVault } from "../core/token-vault-client"
import { type Env, INTERACTION_KIND } from "../core/types"
import { isWorkflowInterruption, waitForWorkflowEvent } from "../core/workflow-events"
import { discoverBufferDestination } from "../integrations/buffer/client"
import { createBufferPublication } from "../integrations/buffer/publication"
import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import { createToolProvider, type ToolConversationMessage } from "../providers"
import { logRuntime } from "../runtime/logging"
import { resolvePrompt } from "../writing/prompt-resolver"
import { authorizedNotesEvent, fingerprintCommand, splitNote } from "./review"
import type { ApprovedPublication, BufferCreateCommand, NotesWorkflowParams } from "./types"

const DEFAULT_LLM_RETRIES = 3
const MAX_WRITING_SESSIONS = 5
const PLAIN = { plainText: true, disableLinkPreview: true } as const
export const NOTES_UNKNOWN_MESSAGE =
  "I couldn't confirm submission to Buffer. The Note may already have been received; Kipp hasn't sent another attempt. The approved text remains above for you to use independently."

/** Orchestrates writing and deterministic approval; the model never receives publishing tools. */
export async function runNotesWorkflow(
  env: Env,
  event: WorkflowEvent<NotesWorkflowParams>,
  step: WorkflowStep,
): Promise<void> {
  const p = event.payload
  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
  const router = createInteractionRouter(env.INTERACTION_ROUTER, p.chatId)
  // Serializable application state crosses the Workflow checkpoint boundary; no class instances do.
  const checkpoint = <T>(name: string, fn: () => Promise<T>, noRetry = false): Promise<T> =>
    step.do(
      name,
      noRetry ? { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" } : {},
      // biome-ignore lint/suspicious/noExplicitAny: Workflow checkpoints accept these plain serializable domain envelopes.
      (async () => assertStepOutputSize(await fn())) as any,
    ) as Promise<T>
  const notify = (name: string, text: string) => checkpoint(name, () => tg.sendMessage(p.chatId, text, PLAIN))
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
      if (!env.BUFFER_SUBSTACK_CHANNEL_ID || !env.BUFFER_PUBLICATIONS) return { ready: false as const }
      const access = await createTokenVault(env).acquireBufferAccess()
      if (access.kind !== "usable") return { ready: false as const }
      const destination = await discoverBufferDestination(
        access.accessToken,
        access.connectionId,
        env.BUFFER_SUBSTACK_CHANNEL_ID,
      )
      if (destination.accountId !== access.accountId) return { ready: false as const }
      const prompt = await resolvePrompt(
        createGitHubClient(env),
        [env.PROMPT_NOTES_PATH, "notes-style-prompt.md"].filter((path): path is string => Boolean(path)),
        DEFAULT_NOTES_PROMPT,
      )
      return {
        ready: true as const,
        destination,
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
      "Couldn't prepare Notes. Check the Notes prompt configuration, connect Buffer at /setup/buffer, and check the configured Substack channel. Then send /note again.",
    )
    return
  }
  let messages = createNotesConversation(snapshot.prompt.content, p.requestText)
  let draft: NotesDraft | null = null
  let session = 0
  let version = 0
  let eventNumber = 0
  let feedback: string | null = null
  const processed = new Set<string>()
  while (remainingFeedbackTimeoutSeconds(snapshot.deadlineMs) > 0) {
    const writingSession = session++
    await checkpoint(`notes-invalidate-${writingSession}`, () => router.invalidateNotes(event.instanceId, version + 1))
    const generated = await checkpoint(
      `notes-write-${writingSession}`,
      async () => {
        const input: ToolConversationMessage[] = feedback ? [...messages, { role: "user", text: feedback }] : messages
        try {
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
            outcome: result.draft ? "succeeded" : "failed",
            metrics: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              providerTurns: result.providerTurns,
            },
          })
          return { draft: result.draft, messages: result.messages }
        } catch (error) {
          if (isWorkflowInterruption(error)) throw error
          return { draft: null, messages: input }
        }
      },
      true,
    )
    messages = generated.messages
    if (generated.draft) draft = generated.draft
    if (!draft) {
      await notify("notes-no-draft", "I couldn't prepare a Note. Please send /note again with your thoughts.")
      return
    }
    version++
    const command: BufferCreateCommand = {
      destination: snapshot.destination,
      text: draft.text,
      attachmentUrl: null,
      timing: { kind: "now" },
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
      await router.register({
        ...base,
        interactionId: actions.publish,
        kind: INTERACTION_KIND.NOTES_PUBLISH,
        callbackToken: actions.publishToken,
      })
      if (session < MAX_WRITING_SESSIONS) {
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
    await notify(
      `notes-commentary-${version}`,
      generated.draft ? draft.commentary : "I couldn't reshape it. Here is the last valid Note for approval.",
    )
    await notify(
      `notes-timing-${version}`,
      session < MAX_WRITING_SESSIONS
        ? "Timing: publish immediately after approval. Reply with feedback or tap Revise."
        : "Timing: publish immediately after approval. The writing limit is reached; this Note is still available for approval.",
    )
    const chunks = splitNote(draft.text)
    for (const [index, chunk] of chunks.entries()) {
      const sent = await checkpoint(`notes-review-${version}-${index}`, () =>
        tg.sendMessage(p.chatId, chunk, {
          ...PLAIN,
          ...(index === chunks.length - 1
            ? {
                replyMarkup: {
                  inline_keyboard: [
                    [
                      { text: "Publish", callback_data: actions.publishToken },
                      ...(session < MAX_WRITING_SESSIONS
                        ? [{ text: "Revise", callback_data: actions.reviseToken }]
                        : []),
                    ],
                  ],
                },
              }
            : {}),
        }),
      )
      if (session < MAX_WRITING_SESSIONS)
        await checkpoint(`notes-bind-${version}-${index}`, () => router.bindNotes(actions.feedback, sent.messageId))
    }
    let waitingForFeedback = false
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
        await notify("notes-expired", "This Note's review window has ended. Start a new /note when ready.")
        return
      }
      const payload = reply.payload
      const actionMap = waitingForFeedback
        ? { [actions.feedback]: INTERACTION_KIND.NOTES_FEEDBACK }
        : {
            [actions.publish]: INTERACTION_KIND.NOTES_PUBLISH,
            ...(session < MAX_WRITING_SESSIONS
              ? { [actions.revise]: INTERACTION_KIND.NOTES_REVISE, [actions.feedback]: INTERACTION_KIND.NOTES_FEEDBACK }
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
      if (accepted.kind === INTERACTION_KIND.NOTES_REVISE) {
        waitingForFeedback = true
        // Raise the router version immediately, then re-register feedback alone under the new version.
        version++
        await checkpoint(`notes-revise-invalidate-${version}`, () => router.invalidateNotes(event.instanceId, version))
        // Existing feedback row is immutable: use a fresh action and bind the feedback prompt.
        actions.feedback = await checkpoint(`notes-feedback-id-${version}`, async () => crypto.randomUUID())
        await checkpoint(`notes-feedback-register-${version}`, () =>
          router.register({ ...base, version, interactionId: actions.feedback, kind: INTERACTION_KIND.NOTES_FEEDBACK }),
        )
        const sent = await notify(
          `notes-feedback-prompt-${version}`,
          "What would you like to change? Reply with your feedback.",
        )
        await checkpoint(`notes-feedback-bind-${version}`, () => router.bindNotes(actions.feedback, sent.messageId))
        continue
      }
      if (accepted.kind === INTERACTION_KIND.NOTES_FEEDBACK && accepted.text?.trim()) {
        feedback = accepted.text
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
      await checkpoint("notes-seal-review", () => router.invalidateNotes(event.instanceId, version + 1))
      if (!env.BUFFER_PUBLICATIONS) throw new Error("Notes publication binding unavailable")
      const guard = createBufferPublication(env.BUFFER_PUBLICATIONS, approved.publicationId)
      await checkpoint("notes-prepare-publication", () => guard.prepare(approved))
      const result = await checkpoint("notes-submit", async () => {
        try {
          return await guard.submit(fingerprint)
        } catch {
          // Inspect the durable evidence once; transport failure never authorizes a fresh create.
          try {
            return await guard.inspect(fingerprint)
          } catch {
            return { kind: "unknown" as const, reason: "guard-unavailable" }
          }
        }
      })
      const text =
        result.kind === "accepted"
          ? `Sent to Buffer for publication.${result.link ? `\n${result.link}` : ""}`
          : result.kind === "created-unexpected"
            ? "Buffer created a post with unexpected settings. Kipp hasn't sent another attempt. Check Buffer; the approved text remains above."
            : result.kind === "rejected"
              ? "The Note wasn't submitted. Check Buffer authorization and channel setup. The text remains above; start a new /note when ready."
              : NOTES_UNKNOWN_MESSAGE
      await notify("notes-result", text)
      return
    }
  }
  await notify("notes-expired", "This Note's review window has ended. Start a new /note when ready.")
}
