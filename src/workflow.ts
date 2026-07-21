import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { createCritiqueAgent } from "./agent/critique"
import { createDraftAgent, createDraftConversation } from "./agent/draft"
import { createReviseAgent } from "./agent/revise"
import { createBacklogManager } from "./backlog/manager"
import { appendAssistant, appendHumanFeedback, assertStepOutputSize } from "./conversation"
import { createGitHubClient } from "./integrations/github"
import { createLinkedInClient, getLinkedInToken, LinkedInError } from "./integrations/linkedin"
import { createTelegramClient } from "./integrations/telegram"
import { computeCost, formatCostLine } from "./pricing"
import { DEFAULT_STYLE_PROMPT } from "./prompts/defaults"
import { readPrompt } from "./prompts/resolver"
import { createGenerator, type GenerateFn, resolveModel } from "./providers"
import type { Env, LLMUsage, WorkflowParams } from "./types"

function withUsageAccumulator(gen: GenerateFn): { gen: GenerateFn; getUsage: () => LLMUsage } {
  const cumulative: LLMUsage = { inputTokens: 0, outputTokens: 0 }
  const wrapped: GenerateFn = async (opts) => {
    const res = await gen(opts)
    cumulative.inputTokens += res.usage.inputTokens
    cumulative.outputTokens += res.usage.outputTokens
    return res
  }
  return { gen: wrapped, getUsage: () => ({ ...cumulative }) }
}

export class PipelineWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    try {
      return await this._run(event, step)
    } catch (err) {
      console.error(`[workflow ${event.instanceId}] unhandled error:`, err)
      throw err
    }
  }

  private async _run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { ideaId, ideaTitle, ideaBody, substackBody } = event.payload

    const stepDo = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const wrapped: () => Promise<T> = async () => {
        try {
          return await fn()
        } catch (err) {
          console.error(`[workflow ${event.instanceId}] step "${name}" failed:`, err)
          throw err
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: step.do requires Rpc.Serializable<T>, but callbacks return valid types
      return step.do(name, wrapped as any) as Promise<T>
    }

    const state = await stepDo("generate", async () => {
      const rawGen = createGenerator(
        this.env.LLM_API_KEY,
        this.env.LLM_PROVIDER,
        this.env.LLM_MODEL,
        Number(this.env.LLM_MAX_RETRIES ?? 3),
      )
      const { gen, getUsage } = withUsageAccumulator(rawGen)
      const model = resolveModel(this.env.LLM_PROVIDER, this.env.LLM_MODEL)

      const client = createGitHubClient(this.env)
      const manager = createBacklogManager(client)

      const stylePaths = [this.env.PROMPT_STYLE_PATH, "style-prompt.md"].filter(Boolean) as string[]
      const stylePrompt = await readPrompt(client, stylePaths, DEFAULT_STYLE_PROMPT)
      const draftAgent = createDraftAgent(gen, stylePrompt)
      const critiqueAgent = createCritiqueAgent(gen)
      const reviseAgent = createReviseAgent(gen)

      let messages = createDraftConversation(stylePrompt, { title: ideaTitle, body: ideaBody, substackBody })
      let draft = await draftAgent({ title: ideaTitle, body: ideaBody, substackBody })
      messages = appendAssistant(messages, draft)
      for (let i = 0; i < 4; i++) {
        const items = await critiqueAgent(draft)
        if (items.every((c) => c.passed)) break
        draft = await reviseAgent({ messages, failedItems: items.filter((c) => !c.passed) })
        messages = appendAssistant(messages, draft)
      }

      const ideas = await manager.readIdeas()
      const idea = ideas.find((i) => i.id === ideaId)
      if (!idea) throw new Error(`Idea ${ideaId} not found`)

      const usage = getUsage()
      const cost = computeCost(usage, model)
      const costLine = formatCostLine(cost)

      const chatId = idea.correlation?.telegramChatId ?? this.env.TELEGRAM_ALLOWED_USER_ID
      if (!chatId)
        console.log(
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
      await stepDo("notify", async () => {
        const client = createGitHubClient(this.env)
        const manager = createBacklogManager(client)
        const ideas = await manager.readIdeas()
        const idea = ideas.find((i) => i.id === ideaId)
        const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
        const result = await tg.sendMessage(
          state.chatId,
          `*Draft for idea #${ideaId}*\n\n${state.draft}\n\nReply with feedback or tap below.${state.costLine}`,
          {
            replyMarkup: {
              inline_keyboard: [
                [
                  { text: "Approve \u2713", callback_data: `confirm:${event.instanceId}` },
                  { text: "Revise More", callback_data: `revise:${event.instanceId}` },
                ],
              ],
            },
          },
        )
        if (idea) {
          try {
            await manager.updateIdea(ideaId, {
              correlation: { ...idea.correlation, botMessageId: result.messageId },
            })
          } catch {
            console.warn(`[workflow ${event.instanceId}] failed to save botMessageId for idea ${ideaId}`)
          }
        }
      })
    }

    let currentDraft = state.draft
    let currentMessages = state.messages
    for (let i = 0; i < 4; i++) {
      const timeoutHours = this.env.WAIT_FOR_FEEDBACK_HOURS || "12"
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
      if (text === "__approve__") {
        const publishToken = await getLinkedInToken(this.env)
        if (publishToken && this.env.LINKEDIN_AUTHOR_URN) {
          try {
            await stepDo("linkedin-publish", async () => {
              const li = createLinkedInClient(publishToken)
              await li.createDraftPost(this.env.LINKEDIN_AUTHOR_URN, currentDraft)
            })
          } catch (err) {
            console.error(`[workflow ${event.instanceId}] linkedin-publish failed:`, err)
            if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
              await stepDo("notify-publish-failed", async () => {
                const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
                const safe =
                  err instanceof LinkedInError
                    ? `❌ LinkedIn publish failed (HTTP ${err.status})`
                    : `❌ LinkedIn publish failed`
                await tg.sendMessage(state.chatId, safe)
              })
            }
            return
          }
        } else {
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
        return
      }

      const revised = await stepDo(`revise-${i}`, async () => {
        const rawGen = createGenerator(
          this.env.LLM_API_KEY,
          this.env.LLM_PROVIDER,
          this.env.LLM_MODEL,
          Number(this.env.LLM_MAX_RETRIES ?? 3),
        )
        const { gen, getUsage } = withUsageAccumulator(rawGen)
        const model = state.model ?? resolveModel(this.env.LLM_PROVIDER, this.env.LLM_MODEL)
        const agent = createReviseAgent(gen)
        const feedback = text === "__revise__" ? undefined : text
        let messages = feedback ? appendHumanFeedback(currentMessages, feedback) : currentMessages
        const nextDraft = await agent({ messages, failedItems: [] })
        messages = appendAssistant(messages, nextDraft)
        const client = createGitHubClient(this.env)
        const manager = createBacklogManager(client)
        const ideas = await manager.readIdeas()
        const idea = ideas.find((i) => i.id === ideaId)
        const prevInput = idea?.costInputTokens ?? state.costInputTokens ?? 0
        const prevOutput = idea?.costOutputTokens ?? state.costOutputTokens ?? 0
        const stepUsage = getUsage()
        const cumulativeUsage: LLMUsage = {
          inputTokens: prevInput + stepUsage.inputTokens,
          outputTokens: prevOutput + stepUsage.outputTokens,
        }
        const cost = computeCost(cumulativeUsage, model)
        const costLine = formatCostLine(cost)
        const nextState = assertStepOutputSize({
          draft: nextDraft,
          messages,
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
        await stepDo(`notify-revised-${i}`, async () => {
          const client = createGitHubClient(this.env)
          const manager = createBacklogManager(client)
          const ideas = await manager.readIdeas()
          const idea = ideas.find((i) => i.id === ideaId)
          const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
          const result = await tg.sendMessage(
            state.chatId,
            `*Revised draft for idea #${ideaId}*\n\n${currentDraft}\n\nReply with feedback or tap below.${revised.costLine}`,
            {
              replyMarkup: {
                inline_keyboard: [
                  [
                    { text: "Approve \u2713", callback_data: `confirm:${event.instanceId}` },
                    { text: "Revise More", callback_data: `revise:${event.instanceId}` },
                  ],
                ],
              },
            },
          )
          if (idea) {
            try {
              await manager.updateIdea(ideaId, {
                correlation: { ...idea.correlation, botMessageId: result.messageId },
              })
            } catch {
              console.warn(
                `[workflow ${event.instanceId}] failed to save botMessageId for idea ${ideaId} (notify-revised)`,
              )
            }
          }
        })
      }
    }
  }
}
