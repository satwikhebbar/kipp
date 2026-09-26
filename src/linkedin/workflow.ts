import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { appendLinkedInFeedback, createLinkedInConversation, runLinkedInToolSession } from "../agent/linkedin"
import { promptForActions } from "../core/action-prompt"
import { assertStepOutputSize } from "../core/conversation"
import { computeCost, formatCostLine } from "../core/cost"
import { createInteractionRouter, type InteractionRegistration } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND, type LLMUsage, type WorkflowParams } from "../core/types"
import { createGitHubClient } from "../integrations/github"
import { createLinkedInClient, getLinkedInToken, LinkedInError } from "../integrations/linkedin"
import { createNotionClient } from "../integrations/notion"
import { createTelegramClient, TELEGRAM_NOTIFY_TIMEOUT_MS } from "../integrations/telegram"
import { createToolProvider, resolveModel } from "../providers"
import { logRuntime } from "../runtime/logging"
import { userFacingFailureMessage } from "../runtime/user-failures"
import { createIdeaManager } from "./ideas/manager"
import { DEFAULT_STYLE_PROMPT } from "./prompts/defaults"
import { resolvePrompt } from "./prompts/resolver"

const DEFAULT_WAIT_FOR_FEEDBACK_HOURS = 12
const MAX_FEEDBACK_ROUNDS = 4
const HOURS_TO_MS = 3_600_000 // ponytail: precomputed 60 * 60 * 1000
const MINUTES_TO_MS = 60_000
const SECONDS_TO_MS = 1_000
const CLOUDFLARE_MAX_WORKFLOW_DURATION_HOURS = 12
const WORKFLOW_TIMEOUT_SAFETY_MARGIN_MINUTES = 15
const CLOUDFLARE_MAX_WORKFLOW_DURATION_MS = CLOUDFLARE_MAX_WORKFLOW_DURATION_HOURS * HOURS_TO_MS
const WORKFLOW_TIMEOUT_SAFETY_MARGIN_MS = WORKFLOW_TIMEOUT_SAFETY_MARGIN_MINUTES * MINUTES_TO_MS
const MAX_FEEDBACK_SESSION_DURATION_MS = CLOUDFLARE_MAX_WORKFLOW_DURATION_MS - WORKFLOW_TIMEOUT_SAFETY_MARGIN_MS
const DEFAULT_LLM_RETRIES = 3
const TELEGRAM_MAX_MESSAGE_CHARS = 4096
const TELEGRAM_CHUNK_MARGIN_CHARS = 128 // headroom under Telegram's hard message cap
const LINKEDIN_RECONNECT_TTL_MINUTES = 15
const LINKEDIN_RECONNECT_TTL_MS = LINKEDIN_RECONNECT_TTL_MINUTES * MINUTES_TO_MS
const MAX_LINKEDIN_PUBLISH_ATTEMPTS = 3
const LINKEDIN_UNAUTHORIZED_STATUS = 401

type PipelineWorkflowOutcome =
  | { outcome: "published"; linkedInDraftUrn?: string }
  | { outcome: "publish-failed" }
  | { outcome: "not-configured" }
  | { outcome: "feedback-expired" }

/**
 * Keeps user-feedback waits within one Cloudflare Workflow execution.
 *
 * Cloudflare terminates an execution at 12 hours, so a feedback session must
 * finish before then for the normal timeout path to persist its terminal state.
 */
export function resolveFeedbackDeadline(startedAtMs: number, configuredHours: string | undefined): number {
  const requestedHours = Number(configuredHours || DEFAULT_WAIT_FOR_FEEDBACK_HOURS)
  const requestedDurationMs = Number.isFinite(requestedHours) && requestedHours > 0 ? requestedHours * HOURS_TO_MS : 0
  const sessionDurationMs = Math.min(
    requestedDurationMs || MAX_FEEDBACK_SESSION_DURATION_MS,
    MAX_FEEDBACK_SESSION_DURATION_MS,
  )
  return startedAtMs + sessionDurationMs
}

/** Returns a whole-second Workflow duration that does not extend past the deadline. */
export function remainingFeedbackTimeoutSeconds(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.floor((deadlineMs - nowMs) / SECONDS_TO_MS))
}

/** Generates a unique interaction ID. */
function interactionId(): string {
  return crypto.randomUUID()
}

/** Creates approve/revise/revision-feedback interaction registrations for a draft message. */
function createDraftInteractions(
  messageId: number,
  workflowId: string,
  version: number,
  expiresAt: number,
): InteractionRegistration[] {
  return [
    {
      interactionId: interactionId(),
      version,
      workflowId,
      kind: INTERACTION_KIND.APPROVE,
      callbackToken: interactionId(),
      botMessageId: messageId,
      expiresAt,
    },
    {
      interactionId: interactionId(),
      version,
      workflowId,
      kind: INTERACTION_KIND.REVISE,
      callbackToken: interactionId(),
      botMessageId: messageId,
      expiresAt,
    },
    {
      interactionId: interactionId(),
      version,
      workflowId,
      kind: INTERACTION_KIND.REVISION_FEEDBACK,
      botMessageId: messageId,
      expiresAt,
    },
  ]
}

/** Builds a Telegram inline keyboard markup from approve/revise interactions. */
function interactionKeyboard(interactions: InteractionRegistration[]): Record<string, unknown> {
  const approve = interactions.find((interaction) => interaction.kind === INTERACTION_KIND.APPROVE)
  const revise = interactions.find((interaction) => interaction.kind === INTERACTION_KIND.REVISE)
  if (!approve?.callbackToken || !revise?.callbackToken) throw new Error("Missing draft interaction callback token")
  return {
    inline_keyboard: [
      [
        { text: "Approve ✓", callback_data: approve.callbackToken },
        { text: "Revise More", callback_data: revise.callbackToken },
      ],
    ],
  }
}

/** Returns the configured browser URL that starts LinkedIn OAuth for this deployment. */
function linkedinSetupUrl(env: Env, setupOrigin?: string): string {
  const origin = env.LINKEDIN_REDIRECT_ORIGIN?.trim() || setupOrigin?.trim()
  return origin ? `${origin.replace(/\/+$/, "")}/setup/linkedin` : "/setup/linkedin"
}

type ReconnectDecision = "retry" | "cancel" | "timeout"

/** Prompts the operator to restore LinkedIn authorization and returns their Retry/Cancel choice. */
async function promptForLinkedInReconnect(options: {
  env: Env
  step: WorkflowStep
  instanceId: string
  chatId: number | string
  ideaId: string
  setupOrigin?: string
  round: number
  attempt: number
}): Promise<ReconnectDecision> {
  const { env, step, instanceId, chatId, ideaId, setupOrigin, round, attempt } = options
  const response = await promptForActions({
    env,
    step,
    instanceId,
    chatId,
    version: round + 1,
    name: `linkedin-reconnect-${round}-${attempt}`,
    message: `LinkedIn authorization is missing or expired. Open ${linkedinSetupUrl(env, setupOrigin)} to authorize, then tap Retry to publish draft #${ideaId}.`,
    actions: [
      ["Retry", INTERACTION_KIND.LINKEDIN_RETRY],
      ["Cancel", INTERACTION_KIND.LINKEDIN_CANCEL],
    ],
    ttlMs: LINKEDIN_RECONNECT_TTL_MS,
  })
  if (response.type === "action" && response.kind === INTERACTION_KIND.LINKEDIN_RETRY) return "retry"
  if (response.type === "action" && response.kind === INTERACTION_KIND.LINKEDIN_CANCEL) return "cancel"
  return "timeout"
}

/** Minimal Telegram client surface used by draft notifications. */
interface TelegramMessenger {
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: { replyMarkup?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<{ messageId: number }>
}

/** Splits text at newline boundaries so every part fits Telegram's message-length cap. */
function chunkTelegramText(
  text: string,
  maxChars = TELEGRAM_MAX_MESSAGE_CHARS - TELEGRAM_CHUNK_MARGIN_CHARS,
): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars)
    if (cut < 0) cut = rest.lastIndexOf(" ", maxChars)
    if (cut < 0) cut = maxChars
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * Sends a draft review to Telegram. A single message is used when the combined
 * response + post fits Telegram's cap; otherwise the conversational response
 * is streamed in chunks and the post text goes last as the message that
 * carries the Approve/Revise keyboard.
 */
async function sendDraftReview(
  tg: TelegramMessenger,
  chatId: number | string,
  header: string,
  response: string,
  post: string,
  costLine: string,
  replyMarkup: Record<string, unknown>,
): Promise<number> {
  const intro = `${header}\n\n`
  const postBlock = `Will be posted as a LinkedIn draft:\n\n${post}\n\nReply with feedback or tap below.${costLine}`
  if (intro.length + response.length + postBlock.length <= TELEGRAM_MAX_MESSAGE_CHARS) {
    const result = await tg.sendMessage(chatId, `${intro}${response}\n\n${postBlock}`, { replyMarkup })
    return result.messageId
  }
  const chunks = chunkTelegramText(response)
  await tg.sendMessage(chatId, `${intro}${chunks[0] ?? ""}`)
  for (const chunk of chunks.slice(1)) await tg.sendMessage(chatId, chunk)
  const result = await tg.sendMessage(chatId, postBlock, { replyMarkup })
  return result.messageId
}

export class PipelineWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<PipelineWorkflowOutcome> {
    logRuntime(this.env, {
      workflow: event.instanceId,
      event: "workflow-run",
      outcome: "started",
      details: { workflowEventTimestamp: event.timestamp.toISOString() },
    })
    try {
      const result = await this._run(event, step)
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "workflow-run",
        outcome: "succeeded",
        details: {
          terminalOutcome: result.outcome,
          ...(result.outcome === "published" && result.linkedInDraftUrn
            ? { linkedInDraftUrn: result.linkedInDraftUrn }
            : {}),
        },
      })
      return result
    } catch (err) {
      logRuntime(this.env, { workflow: event.instanceId, event: "workflow-run", outcome: "failed" })
      console.error(new Date().toISOString(), `[workflow ${event.instanceId}] unhandled error:`, err)
      const chatId = event.payload.chatId ?? this.env.TELEGRAM_ALLOWED_USER_ID.trim()
      if (chatId && this.env.TELEGRAM_BOT_TOKEN) {
        await createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
          .sendMessage(chatId, userFacingFailureMessage(err), {
            signal: AbortSignal.timeout(TELEGRAM_NOTIFY_TIMEOUT_MS),
          })
          .catch(() => {})
      }
      throw err
    }
  }

  private async _run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<PipelineWorkflowOutcome> {
    const { pageId, ideaId } = event.payload
    const feedbackDeadlineMs = resolveFeedbackDeadline(event.timestamp.getTime(), this.env.WAIT_FOR_FEEDBACK_HOURS)

    const stepDo = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const wrapped: () => Promise<T> = async () => {
        const startedAt = Date.now()
        logRuntime(this.env, { workflow: event.instanceId, event: `step:${name}`, outcome: "started" })
        try {
          const result = await fn()
          logRuntime(this.env, {
            workflow: event.instanceId,
            event: `step:${name}`,
            outcome: "succeeded",
            durationMs: Date.now() - startedAt,
          })
          return result
        } catch (err) {
          logRuntime(this.env, {
            workflow: event.instanceId,
            event: `step:${name}`,
            outcome: "failed",
            durationMs: Date.now() - startedAt,
          })
          console.error(new Date().toISOString(), `[workflow ${event.instanceId}] step "${name}" failed:`, err)
          throw err
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: step.do requires Rpc.Serializable<T>, but callbacks return valid types
      return step.do(name, wrapped as any) as Promise<T>
    }

    const state = await stepDo("generate", async () => {
      const provider = createToolProvider(
        this.env.LLM_API_KEY,
        this.env.LLM_PROVIDER,
        this.env.LLM_MODEL,
        Number(this.env.LLM_MAX_RETRIES ?? DEFAULT_LLM_RETRIES),
      )
      const model = resolveModel(this.env.LLM_PROVIDER, this.env.LLM_MODEL)

      const client = createGitHubClient(this.env)
      const manager = createIdeaManager(createNotionClient(this.env))

      const stylePaths = [this.env.PROMPT_STYLE_PATH, "style-prompt.md"].filter(Boolean) as string[]
      const promptResolution = await resolvePrompt(client, stylePaths, DEFAULT_STYLE_PROMPT)
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "linkedin-style-prompt-resolved",
        outcome: "succeeded",
        details: {
          source: promptResolution.source,
          sha: promptResolution.sha ?? "built-in",
          length: promptResolution.content.length,
        },
      })
      const stylePrompt = promptResolution.content

      const idea = await manager.getIdea(pageId)
      const initialMessages = createLinkedInConversation(stylePrompt, {
        title: idea.title,
        body: idea.body,
      })
      const session = await runLinkedInToolSession(provider, initialMessages)
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "linkedin-tool-session",
        outcome: session.completed ? "succeeded" : "failed",
        metrics: {
          providerTurns: session.providerTurns,
          toolCallCount: session.toolCallCount,
          toolFailureCount: session.toolExecutions.filter((execution) => execution.outcome === "failed").length,
        },
      })
      if (!session.terminal) throw new Error(`LinkedIn tool session failed: ${session.failureReason ?? "no-response"}`)
      const draft = session.terminal.response
      const post = session.terminal.post
      const messages = session.messages

      const usage = session.usage
      const cost = computeCost(usage, model)
      const costLine = formatCostLine(cost)

      const chatId = idea.correlation?.telegramChatId ?? this.env.TELEGRAM_ALLOWED_USER_ID
      if (!chatId)
        console.log(
          new Date().toISOString(),
          `[workflow ${event.instanceId}] no chatId resolved for idea ${ideaId} — notify/approval steps will be silent`,
        )

      const nextState = assertStepOutputSize({
        draft,
        post,
        messages,
        chatId,
        costInputTokens: usage.inputTokens,
        costOutputTokens: usage.outputTokens,
        costLine,
        model,
      })
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "linkedin-workflow-state-persisted",
        outcome: "succeeded",
        details: {
          responseCharacters: draft.length,
          transcriptMessages: messages.length,
          transcriptCharacters: JSON.stringify(messages).length,
        },
      })
      await manager.updateIdea(pageId, { status: "awaiting-feedback" })
      return nextState
    })

    if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
      const notification = await stepDo("notify", async () => {
        const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
        const interactions = createDraftInteractions(0, event.instanceId, 1, feedbackDeadlineMs)
        const messageId = await sendDraftReview(
          tg,
          state.chatId,
          `*Draft for idea #${ideaId}*`,
          state.draft,
          state.post,
          state.costLine,
          interactionKeyboard(interactions),
        )
        return { interactions: interactions.map((interaction) => ({ ...interaction, botMessageId: messageId })) }
      })
      await stepDo("register-notify-interactions", async () => {
        const router = createInteractionRouter(this.env.INTERACTION_ROUTER, state.chatId)
        await Promise.all(notification.interactions.map((interaction) => router.register(interaction)))
      })
    }

    let currentDraft = state.draft
    let currentPost = state.post
    let currentMessages = state.messages
    let runningInputTokens = state.costInputTokens ?? 0
    let runningOutputTokens = state.costOutputTokens ?? 0
    let latestCostLine = state.costLine

    let revisionCount = 0
    let waitIndex = 0
    // Keep waiting until the deadline rather than a fixed event count, so the
    // final draft's Approve control stays actionable after the revision limit.
    while (true) {
      const round = waitIndex++
      const timeoutSeconds = remainingFeedbackTimeoutSeconds(feedbackDeadlineMs)
      if (timeoutSeconds === 0) {
        await stepDo(`timeout-${round}`, async () => {
          const manager = createIdeaManager(createNotionClient(this.env))
          await manager.updateIdea(pageId, { status: "awaiting-feedback-expired" })
        })
        return { outcome: "feedback-expired" }
      }
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "linkedin-feedback-wait",
        outcome: "started",
        details: { round, timeoutSeconds },
      })
      const reply = await step.waitForEvent<{ text?: string }>(`feedback-${round}`, {
        type: "telegram-reply",
        // biome-ignore lint/suspicious/noExplicitAny: WorkflowSleepDuration doesn't accept computed strings
        timeout: `${timeoutSeconds} seconds` as any,
      })
      const text = (reply.payload?.text as string) ?? ((reply as Record<string, unknown>)?.text as string) ?? ""
      logRuntime(this.env, {
        workflow: event.instanceId,
        event: "linkedin-feedback-wait",
        outcome: "succeeded",
        details: {
          round,
          result: reply.type === "timeout" ? "timeout" : "event",
          interaction: text === "__approve__" ? "approve" : text === "__revise__" ? "revise" : "feedback",
          responseCharacters: currentDraft.length,
          transcriptMessages: currentMessages.length,
          transcriptCharacters: JSON.stringify(currentMessages).length,
        },
      })
      if (reply.type === "timeout") {
        await stepDo(`timeout-${round}`, async () => {
          const manager = createIdeaManager(createNotionClient(this.env))
          await manager.updateIdea(pageId, { status: "awaiting-feedback-expired" })
        })
        return { outcome: "feedback-expired" }
      }

      if (text !== "__approve__" && revisionCount >= MAX_FEEDBACK_ROUNDS) {
        if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
          await stepDo(`notify-revision-limit-${round}`, async () => {
            const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
            await tg.sendMessage(
              state.chatId,
              "Revision limit reached. Approve the current draft to post it, or wait for the offer to expire.",
            )
          })
        }
        continue
      }

      if (text === "__revise__") {
        if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
          const feedbackInteraction = await stepDo(`notify-revision-prompt-${round}`, async () => {
            const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
            await tg.sendMessage(state.chatId, "Type your revision feedback.")
            return {
              interactionId: interactionId(),
              version: round + 1,
              workflowId: event.instanceId,
              kind: INTERACTION_KIND.REVISION_FEEDBACK,
              expiresAt: feedbackDeadlineMs,
            }
          })
          await stepDo(`register-revision-feedback-${round}`, async () => {
            const router = createInteractionRouter(this.env.INTERACTION_ROUTER, state.chatId)
            await router.register(feedbackInteraction)
          })
        }
        continue
      }
      if (text === "__approve__") {
        logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-approval", outcome: "started" })
        const notifyPublishFailure = async (err: unknown): Promise<void> => {
          logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-approval", outcome: "failed" })
          console.error(new Date().toISOString(), `[workflow ${event.instanceId}] linkedin-publish failed:`, err)
          if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
            await stepDo("notify-publish-failed", async () => {
              const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
              const safe =
                err instanceof LinkedInError
                  ? `❌ LinkedIn publish failed (HTTP ${err.status})`
                  : "❌ LinkedIn publish failed. Please try approving again."
              await tg.sendMessage(state.chatId, safe)
            })
          }
        }

        for (let attempt = 0; attempt < MAX_LINKEDIN_PUBLISH_ATTEMPTS; attempt++) {
          let publication: { kind: "ok"; urn: string } | { kind: "needs-auth" }
          try {
            publication = await stepDo(`linkedin-publish-${round}-${attempt}`, async () => {
              const publishToken = await getLinkedInToken(this.env)
              if (!publishToken || !this.env.LINKEDIN_AUTHOR_URN) return { kind: "needs-auth" as const }
              try {
                const li = createLinkedInClient(publishToken)
                const created = await li.createDraftPost(this.env.LINKEDIN_AUTHOR_URN, currentPost)
                return { kind: "ok" as const, urn: created.urn }
              } catch (err) {
                if (err instanceof LinkedInError && err.status === LINKEDIN_UNAUTHORIZED_STATUS) {
                  logRuntime(this.env, {
                    workflow: event.instanceId,
                    event: "linkedin-approval",
                    outcome: "failed",
                    failureCategory: "linkedin-authorization-expired",
                  })
                  return { kind: "needs-auth" as const }
                }
                throw err
              }
            })
          } catch (err) {
            await notifyPublishFailure(err)
            return { outcome: "publish-failed" }
          }

          if (publication.kind === "ok") {
            logRuntime(this.env, {
              workflow: event.instanceId,
              event: "linkedin-draft-created",
              outcome: "succeeded",
              details: { urn: publication.urn || "unavailable" },
            })

            await stepDo("archive", async () => {
              const manager = createIdeaManager(createNotionClient(this.env))
              await manager.updateIdea(pageId, { status: "finalized" })
            })
            if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
              await stepDo("notify-published", async () => {
                const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
                await tg.sendMessage(state.chatId, `✅ Draft posted to LinkedIn!${latestCostLine}`)
              })
            }
            const completion = await stepDo("workflow-complete", async () =>
              publication.urn
                ? { outcome: "published" as const, linkedInDraftUrn: publication.urn }
                : { outcome: "published" as const },
            )
            logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-approval", outcome: "succeeded" })
            return completion
          }

          if (!state.chatId || !this.env.TELEGRAM_BOT_TOKEN) return { outcome: "not-configured" }

          const decision = await promptForLinkedInReconnect({
            env: this.env,
            step,
            instanceId: event.instanceId,
            chatId: state.chatId,
            ideaId,
            setupOrigin: (reply.payload as { setupOrigin?: string } | undefined)?.setupOrigin,
            round,
            attempt,
          })
          if (decision === "retry") continue
          if (decision === "cancel") {
            await stepDo(`notify-publish-cancelled-${round}`, async () => {
              const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
              await tg.sendMessage(state.chatId, "Draft publish cancelled. No LinkedIn draft was created.")
            })
          }
          return { outcome: "not-configured" }
        }

        if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
          await stepDo(`notify-publish-attempts-exhausted-${round}`, async () => {
            const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
            await tg.sendMessage(
              state.chatId,
              "Draft publish didn't complete. Re-approve from the review message when LinkedIn is connected.",
            )
          })
        }
        return { outcome: "publish-failed" }
      }

      const revised = await stepDo(`revise-${revisionCount}`, async () => {
        const provider = createToolProvider(
          this.env.LLM_API_KEY,
          this.env.LLM_PROVIDER,
          this.env.LLM_MODEL,
          Number(this.env.LLM_MAX_RETRIES ?? DEFAULT_LLM_RETRIES),
        )
        const model = state.model ?? resolveModel(this.env.LLM_PROVIDER, this.env.LLM_MODEL)
        const messages = text ? appendLinkedInFeedback(currentMessages, text) : currentMessages
        const session = await runLinkedInToolSession(provider, messages)
        logRuntime(this.env, {
          workflow: event.instanceId,
          event: "linkedin-tool-session",
          outcome: session.completed ? "succeeded" : "failed",
          metrics: {
            providerTurns: session.providerTurns,
            toolCallCount: session.toolCallCount,
            toolFailureCount: session.toolExecutions.filter((execution) => execution.outcome === "failed").length,
          },
        })
        if (!session.terminal)
          throw new Error(`LinkedIn tool session failed: ${session.failureReason ?? "no-response"}`)
        const nextDraft = session.terminal.response
        const nextPost = session.terminal.post
        const stepUsage = session.usage
        const cumulativeUsage: LLMUsage = {
          inputTokens: runningInputTokens + stepUsage.inputTokens,
          outputTokens: runningOutputTokens + stepUsage.outputTokens,
        }
        const cost = computeCost(cumulativeUsage, model)
        const costLine = formatCostLine(cost)
        const nextState = assertStepOutputSize({
          draft: nextDraft,
          post: nextPost,
          messages: session.messages,
          costInputTokens: cumulativeUsage.inputTokens,
          costOutputTokens: cumulativeUsage.outputTokens,
          costLine,
          model,
        })
        return nextState
      })
      currentDraft = revised.draft
      currentPost = revised.post
      currentMessages = revised.messages
      runningInputTokens = revised.costInputTokens
      runningOutputTokens = revised.costOutputTokens
      latestCostLine = revised.costLine

      if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
        const notification = await stepDo(`notify-revised-${revisionCount}`, async () => {
          const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
          const interactions = createDraftInteractions(0, event.instanceId, revisionCount + 2, feedbackDeadlineMs)
          const messageId = await sendDraftReview(
            tg,
            state.chatId,
            `*Revised draft for idea #${ideaId}*`,
            currentDraft,
            currentPost,
            revised.costLine,
            interactionKeyboard(interactions),
          )
          return { interactions: interactions.map((interaction) => ({ ...interaction, botMessageId: messageId })) }
        })
        await stepDo(`register-notify-revised-interactions-${revisionCount}`, async () => {
          const router = createInteractionRouter(this.env.INTERACTION_ROUTER, state.chatId)
          await Promise.all(notification.interactions.map((interaction) => router.register(interaction)))
        })
      }
      revisionCount++
    }
  }
}
