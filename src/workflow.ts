import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { createCritiqueAgent } from "./agent/critique"
import { createDraftAgent, createDraftConversation } from "./agent/draft"
import { createReviseAgent } from "./agent/revise"
import { createBacklogManager } from "./backlog/manager"
import { appendAssistant, appendHumanFeedback, assertStepOutputSize } from "./conversation"
import { createGitHubClient } from "./integrations/github"
import { createLinkedInClient, getLinkedInToken, LinkedInError } from "./integrations/linkedin"
import { createTelegramClient } from "./integrations/telegram"
import { DEFAULT_STYLE_PROMPT } from "./prompts/defaults"
import { readPrompt } from "./prompts/resolver"
import { createGenerator } from "./providers"
import type { Env, WorkflowParams } from "./types"

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
      const gen = createGenerator(
        this.env.LLM_API_KEY,
        this.env.LLM_PROVIDER,
        this.env.LLM_MODEL,
        Number(this.env.LLM_MAX_RETRIES ?? 3),
      )
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

      await manager.updateIdea(ideaId, {
        draft,
        status: "awaiting-feedback",
        correlation: { ...idea.correlation, workflowInstanceId: event.instanceId },
      })
      const chatId = idea.correlation?.telegramChatId ?? this.env.TELEGRAM_ALLOWED_USER_ID
      if (!chatId)
        console.log(
          `[workflow ${event.instanceId}] no chatId resolved for idea ${ideaId} — notify/approval steps will be silent`,
        )

      return assertStepOutputSize({ draft, messages, chatId })
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
          `*Draft for idea #${ideaId}*\n\n${state.draft}\n\nReply with feedback or tap below.`,
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
        await stepDo("archive", async () => {
          const client = createGitHubClient(this.env)
          const manager = createBacklogManager(client)
          const ideas = await manager.readIdeas()
          const idea = ideas.find((i) => i.id === ideaId)
          if (idea) await manager.moveToArchive(idea)
        })
        if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
          await stepDo("notify-published", async () => {
            const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
            await tg.sendMessage(state.chatId, "✅ Draft posted to LinkedIn!")
          })
        }
        return
      }

      const revised = await stepDo(`revise-${i}`, async () => {
        const gen = createGenerator(
          this.env.LLM_API_KEY,
          this.env.LLM_PROVIDER,
          this.env.LLM_MODEL,
          Number(this.env.LLM_MAX_RETRIES ?? 3),
        )
        const agent = createReviseAgent(gen)
        // __revise__ (Revise More button) adds no transcript message; only real Telegram feedback extends history.
        const feedback = text === "__revise__" ? undefined : text
        let messages = feedback ? appendHumanFeedback(currentMessages, feedback) : currentMessages
        const nextDraft = await agent({ messages, failedItems: [] })
        messages = appendAssistant(messages, nextDraft)
        const client = createGitHubClient(this.env)
        const manager = createBacklogManager(client)
        await manager.updateIdea(ideaId, { draft: nextDraft })
        return assertStepOutputSize({ draft: nextDraft, messages })
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
            `*Revised draft for idea #${ideaId}*\n\n${currentDraft}\n\nReply with feedback or tap below.`,
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
