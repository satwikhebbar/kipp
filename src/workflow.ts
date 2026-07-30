import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { appendLinkedInFeedback, createLinkedInConversation, runLinkedInToolSession } from "./agent/linkedin"
import { createBacklogManager } from "./backlog/manager"
import { assertStepOutputSize } from "./conversation"
import { createGitHubClient } from "./integrations/github"
import { createLinkedInClient, getLinkedInToken, LinkedInError } from "./integrations/linkedin"
import { createTelegramClient } from "./integrations/telegram"
import { createInteractionRouter, type InteractionRegistration } from "./interaction-router-client"
import { computeCost, formatCostLine } from "./pricing"
import { DEFAULT_STYLE_PROMPT } from "./prompts/defaults"
import { resolvePrompt } from "./prompts/resolver"
import { createToolProvider, resolveModel } from "./providers"
import { logRuntime } from "./runtime/logging"
import { type Env, INTERACTION_KIND, type LLMUsage, type WorkflowParams } from "./types"

const DEFAULT_WAIT_FOR_FEEDBACK_HOURS = 12
const MAX_FEEDBACK_ROUNDS = 4
const HOURS_TO_MS = 3_600_000 // ponytail: precomputed 60 * 60 * 1000
const DEFAULT_LLM_RETRIES = 3

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

export class PipelineWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    logRuntime(this.env, { workflow: event.instanceId, event: "workflow-run", outcome: "started" })
    try {
      const result = await this._run(event, step)
      logRuntime(this.env, { workflow: event.instanceId, event: "workflow-run", outcome: "succeeded" })
      return result
    } catch (err) {
      logRuntime(this.env, { workflow: event.instanceId, event: "workflow-run", outcome: "failed" })
      console.error(new Date().toISOString(), `[workflow ${event.instanceId}] unhandled error:`, err)
      throw err
    }
  }

  private async _run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { ideaId, ideaTitle, ideaBody, substackBody } = event.payload

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
      const manager = createBacklogManager(client)

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
      const initialMessages = createLinkedInConversation(stylePrompt, {
        title: ideaTitle,
        body: ideaBody,
        substackBody,
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
      if (!session.response) throw new Error(`LinkedIn tool session failed: ${session.failureReason ?? "no-response"}`)
      const draft = session.response
      const messages = session.messages

      const ideas = await manager.readIdeas()
      const idea = ideas.find((i) => i.id === ideaId)
      if (!idea) throw new Error(`Idea ${ideaId} not found`)

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
        messages,
        chatId,
        costInputTokens: usage.inputTokens,
        costOutputTokens: usage.outputTokens,
        costLine,
        model,
      })
      await manager.updateIdea(ideaId, {
        draft,
        status: "awaiting-feedback",
        correlation: { ...idea.correlation, workflowInstanceId: event.instanceId },
        costUsd: cost.totalCostUsd ?? undefined,
        costInputTokens: usage.inputTokens,
        costOutputTokens: usage.outputTokens,
        costModel: model,
      })
      return nextState
    })

    if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
      const notification = await stepDo("notify", async () => {
        const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
        const expiresAt =
          Date.now() + Number(this.env.WAIT_FOR_FEEDBACK_HOURS || DEFAULT_WAIT_FOR_FEEDBACK_HOURS) * HOURS_TO_MS
        const interactions = createDraftInteractions(0, event.instanceId, 1, expiresAt)
        const result = await tg.sendMessage(
          state.chatId,
          `*Draft for idea #${ideaId}*\n\n${state.draft}\n\nReply with feedback or tap below.${state.costLine}`,
          { replyMarkup: interactionKeyboard(interactions) },
        )
        return { interactions: interactions.map((interaction) => ({ ...interaction, botMessageId: result.messageId })) }
      })
      await stepDo("register-notify-interactions", async () => {
        const router = createInteractionRouter(this.env.INTERACTION_ROUTER, state.chatId)
        await Promise.all(notification.interactions.map((interaction) => router.register(interaction)))
      })
    }

    let currentDraft = state.draft
    let currentMessages = state.messages
    for (let i = 0; i < MAX_FEEDBACK_ROUNDS; i++) {
      const timeoutHours = this.env.WAIT_FOR_FEEDBACK_HOURS || String(DEFAULT_WAIT_FOR_FEEDBACK_HOURS)
      const reply = await step.waitForEvent<{ text?: string }>(`feedback-${i}`, {
        type: "telegram-reply",
        // biome-ignore lint/suspicious/noExplicitAny: WorkflowSleepDuration doesn't accept computed strings
        timeout: `${timeoutHours} hours` as any,
      })
      if (reply.type === "timeout") {
        await stepDo(`timeout-${i}`, async () => {
          const client = createGitHubClient(this.env)
          const manager = createBacklogManager(client)
          await manager.updateIdea(ideaId, { status: "awaiting-feedback-expired" })
        })
        return
      }

      const text = (reply.payload?.text as string) ?? ((reply as Record<string, unknown>)?.text as string) ?? ""
      if (text === "__revise__") {
        if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
          const feedbackInteraction = await stepDo(`notify-revision-prompt-${i}`, async () => {
            const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
            await tg.sendMessage(state.chatId, "Type your revision feedback.")
            return {
              interactionId: interactionId(),
              version: i + 1,
              workflowId: event.instanceId,
              kind: INTERACTION_KIND.REVISION_FEEDBACK,
              expiresAt:
                Date.now() + Number(this.env.WAIT_FOR_FEEDBACK_HOURS || DEFAULT_WAIT_FOR_FEEDBACK_HOURS) * HOURS_TO_MS,
            }
          })
          await stepDo(`register-revision-feedback-${i}`, async () => {
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

        let publishToken: string
        try {
          logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-token-read", outcome: "started" })
          publishToken = await getLinkedInToken(this.env)
          logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-token-read", outcome: "succeeded" })
        } catch (err) {
          logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-token-read", outcome: "failed" })
          await notifyPublishFailure(err)
          return
        }

        if (!publishToken || !this.env.LINKEDIN_AUTHOR_URN) {
          logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-approval", outcome: "not-configured" })
          if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
            await stepDo("notify-not-configured", async () => {
              const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
              await tg.sendMessage(
                state.chatId,
                "❌ Cannot publish: LinkedIn not configured. Configure credentials and re-approve.",
              )
            })
          }
          return
        }

        try {
          await stepDo("linkedin-publish", async () => {
            const li = createLinkedInClient(publishToken)
            await li.createDraftPost(this.env.LINKEDIN_AUTHOR_URN, currentDraft)
          })
        } catch (err) {
          await notifyPublishFailure(err)
          return
        }

        const finalCostLine = await stepDo("archive", async () => {
          const client = createGitHubClient(this.env)
          const manager = createBacklogManager(client)
          const ideas = await manager.readIdeas()
          const idea = ideas.find((i) => i.id === ideaId)
          let line = ""
          if (idea) {
            const model = idea.costModel ?? state.model ?? ""
            if (model) {
              const cost = computeCost(
                { inputTokens: idea.costInputTokens ?? 0, outputTokens: idea.costOutputTokens ?? 0 },
                model,
              )
              line = formatCostLine(cost)
            }
            await manager.moveToArchive(idea)
          }
          return line
        })
        if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
          await stepDo("notify-published", async () => {
            const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
            await tg.sendMessage(state.chatId, `✅ Draft posted to LinkedIn!${finalCostLine}`)
          })
        }
        logRuntime(this.env, { workflow: event.instanceId, event: "linkedin-approval", outcome: "succeeded" })
        return
      }

      const revised = await stepDo(`revise-${i}`, async () => {
        const provider = createToolProvider(
          this.env.LLM_API_KEY,
          this.env.LLM_PROVIDER,
          this.env.LLM_MODEL,
          Number(this.env.LLM_MAX_RETRIES ?? DEFAULT_LLM_RETRIES),
        )
        const model = state.model ?? resolveModel(this.env.LLM_PROVIDER, this.env.LLM_MODEL)
        const feedback = text === "__revise__" ? undefined : text
        const messages = feedback ? appendLinkedInFeedback(currentMessages, feedback) : currentMessages
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
        if (!session.response)
          throw new Error(`LinkedIn tool session failed: ${session.failureReason ?? "no-response"}`)
        const nextDraft = session.response
        const client = createGitHubClient(this.env)
        const manager = createBacklogManager(client)
        const ideas = await manager.readIdeas()
        const idea = ideas.find((i) => i.id === ideaId)
        const prevInput = idea?.costInputTokens ?? state.costInputTokens ?? 0
        const prevOutput = idea?.costOutputTokens ?? state.costOutputTokens ?? 0
        const stepUsage = session.usage
        const cumulativeUsage: LLMUsage = {
          inputTokens: prevInput + stepUsage.inputTokens,
          outputTokens: prevOutput + stepUsage.outputTokens,
        }
        const cost = computeCost(cumulativeUsage, model)
        const costLine = formatCostLine(cost)
        const nextState = assertStepOutputSize({
          draft: nextDraft,
          messages: session.messages,
          costInputTokens: cumulativeUsage.inputTokens,
          costOutputTokens: cumulativeUsage.outputTokens,
          costLine,
          model,
        })
        await manager.updateIdea(ideaId, {
          draft: nextDraft,
          costUsd: cost.totalCostUsd ?? undefined,
          costInputTokens: cumulativeUsage.inputTokens,
          costOutputTokens: cumulativeUsage.outputTokens,
          costModel: model,
        })
        return nextState
      })
      currentDraft = revised.draft
      currentMessages = revised.messages

      if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
        const notification = await stepDo(`notify-revised-${i}`, async () => {
          const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
          const expiresAt =
            Date.now() + Number(this.env.WAIT_FOR_FEEDBACK_HOURS || DEFAULT_WAIT_FOR_FEEDBACK_HOURS) * HOURS_TO_MS
          const interactions = createDraftInteractions(0, event.instanceId, i + 2, expiresAt)
          const result = await tg.sendMessage(
            state.chatId,
            `*Revised draft for idea #${ideaId}*\n\n${currentDraft}\n\nReply with feedback or tap below.${revised.costLine}`,
            { replyMarkup: interactionKeyboard(interactions) },
          )
          return {
            interactions: interactions.map((interaction) => ({ ...interaction, botMessageId: result.messageId })),
          }
        })
        await stepDo(`register-notify-revised-interactions-${i}`, async () => {
          const router = createInteractionRouter(this.env.INTERACTION_ROUTER, state.chatId)
          await Promise.all(notification.interactions.map((interaction) => router.register(interaction)))
        })
      }
    }
  }
}
