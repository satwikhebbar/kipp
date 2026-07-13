import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { createCritiqueAgent } from "./agent/critique"
import { createDraftAgent } from "./agent/draft"
import { createReviseAgent } from "./agent/revise"
import { createBacklogManager } from "./backlog/manager"
import { createGitHubClient } from "./integrations/github"
import { createLinkedInClient } from "./integrations/linkedin"
import { createTelegramClient } from "./integrations/telegram"
import { createGenerator } from "./providers"
import type { Env, WorkflowParams } from "./types"

export class PipelineWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { ideaId, ideaTitle, ideaBody, substackBody } = event.payload

    const state = await step.do("generate", async () => {
      const gen = createGenerator(this.env.LLM_API_KEY, this.env.LLM_PROVIDER)
      const client = createGitHubClient(this.env)
      const manager = createBacklogManager(client)

      const { content: stylePrompt } = await client.readFile("style-prompt.md")
      const draftAgent = createDraftAgent(gen, stylePrompt)
      const critiqueAgent = createCritiqueAgent(gen)
      const reviseAgent = createReviseAgent(gen)

      let draft = await draftAgent({ title: ideaTitle, body: ideaBody, substackBody })
      for (let i = 0; i < 4; i++) {
        const items = await critiqueAgent(draft)
        if (items.every((c) => c.passed)) break
        draft = await reviseAgent({ draft, failedItems: items.filter((c) => !c.passed) })
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

      return { draft, chatId }
    })

    if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
      await step.do("notify", async () => {
        const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
        const preview = state.draft.slice(0, 200)
        const result = await tg.sendMessage(
          state.chatId,
          `*Draft for idea #${ideaId}*\n\n${preview}...\n\nReply with feedback or tap below.`,
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
        const client = createGitHubClient(this.env)
        const manager = createBacklogManager(client)
        const ideas = await manager.readIdeas()
        const idea = ideas.find((i) => i.id === ideaId)
        if (idea) {
          await manager.updateIdea(ideaId, {
            correlation: { ...idea.correlation, botMessageId: result.messageId },
          })
        }
      })
    }

    let currentDraft = state.draft
    for (let i = 0; i < 4; i++) {
      const timeoutHours = this.env.WAIT_FOR_FEEDBACK_HOURS || "168"
      const reply = await step.waitForEvent<{ text?: string }>(`feedback-${i}`, {
        type: "telegram-reply",
        timeout: `${timeoutHours} hours` as any,
      })
      if (reply.type === "timeout") {
        await step.do(`timeout-${i}`, async () => {
          const client = createGitHubClient(this.env)
          const manager = createBacklogManager(client)
          await manager.updateIdea(ideaId, { status: "awaiting-feedback-expired" })
        })
        return
      }

      const text = reply.payload?.text ?? ""
      if (text === "__approve__") {
        if (this.env.LINKEDIN_ACCESS_TOKEN && this.env.LINKEDIN_AUTHOR_URN) {
          try {
            await step.do("linkedin-publish", async () => {
              const li = createLinkedInClient(this.env.LINKEDIN_ACCESS_TOKEN)
              await li.createDraftPost(this.env.LINKEDIN_AUTHOR_URN, currentDraft)
            })
          } catch (err) {
            if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
              await step.do("notify-publish-failed", async () => {
                const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
                await tg.sendMessage(state.chatId, `❌ LinkedIn publish failed: ${err}`)
              })
            }
            return
          }
        } else {
          if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
            await step.do("notify-not-configured", async () => {
              const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
              await tg.sendMessage(state.chatId, "❌ Cannot publish: LinkedIn not configured. Configure credentials and re-approve.")
            })
          }
          return
        }
        await step.do("archive", async () => {
          const client = createGitHubClient(this.env)
          const manager = createBacklogManager(client)
          const ideas = await manager.readIdeas()
          const idea = ideas.find((i) => i.id === ideaId)
          if (idea) await manager.moveToArchive(idea)
        })
        if (state.chatId && this.env.TELEGRAM_BOT_TOKEN) {
          await step.do("notify-published", async () => {
            const tg = createTelegramClient(this.env.TELEGRAM_BOT_TOKEN)
            await tg.sendMessage(state.chatId, "✅ Draft posted to LinkedIn!")
          })
        }
        return
      }

      currentDraft = await step.do(`revise-${i}`, async () => {
        const gen = createGenerator(this.env.LLM_API_KEY, this.env.LLM_PROVIDER)
        const agent = createReviseAgent(gen)
        const feedback = text === "__revise__" ? undefined : text
        const revised = await agent({ draft: currentDraft, failedItems: [], humanFeedback: feedback })
        const client = createGitHubClient(this.env)
        const manager = createBacklogManager(client)
        await manager.updateIdea(ideaId, { draft: revised })
        return revised
      })
    }
  }
}
