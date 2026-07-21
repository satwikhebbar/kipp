import { nextId } from "../backlog/id-generator"
import { parseIdeas, serializeIdeas } from "../backlog/parser"
import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import type { Env } from "../types"

interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
}

interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string }
  text?: string
  reply_to_message?: {
    message_id: number
    from?: TelegramUser
  }
}

interface TelegramCallbackQuery {
  id: string
  from: { id: number }
  message?: { message_id: number; chat: { id: number } }
  data?: string
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

function verifyUser(env: Env, userId: number): boolean {
  if (!env.TELEGRAM_ALLOWED_USER_ID) return true
  return String(userId) === env.TELEGRAM_ALLOWED_USER_ID
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 })

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return new Response("invalid body", { status: 400 })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Response("invalid body", { status: 400 })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return new Response("invalid body", { status: 400 })
  const update = parsed as TelegramUpdate

  if (update.callback_query) {
    const cq = update.callback_query
    if (!verifyUser(env, cq.from.id)) return new Response("Forbidden", { status: 403 })

    const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
    await tg.answerCallbackQuery(cq.id)

    if (cq.data?.startsWith("confirm:") && cq.message) {
      const workflowId = cq.data.slice("confirm:".length)
      if (workflowId) {
        const instance = await env.PIPELINE_WORKFLOW.get(workflowId)
        await instance.sendEvent({ type: "telegram-reply", payload: { userId: cq.from.id, text: "__approve__" } })
      }
    } else if (cq.data?.startsWith("revise:") && cq.message) {
      const workflowId = cq.data.slice("revise:".length)
      if (workflowId) {
        const chatId = cq.message.chat.id
        const client = createGitHubClient(env)
        await client.mutateFile("ideas.md", (c) => {
          const all = parseIdeas(c)
          const idx = all.findIndex((i) => i.correlation?.workflowInstanceId === workflowId)
          if (idx !== -1) {
            all[idx] = {
              ...all[idx],
              correlation: { ...all[idx].correlation, pendingRevision: String(chatId) },
            }
          }
          return serializeIdeas(all)
        })
        await tg.sendMessage(chatId, "Type your revision feedback.")
      }
    }

    return new Response("OK")
  }

  if (update.message) {
    return handleMessage(update.message, env)
  }

  return new Response("OK")
}

async function handleMessage(msg: TelegramMessage, env: Env): Promise<Response> {
  if (!msg.text || !msg.from || msg.from.is_bot) return new Response("OK")
  if (!verifyUser(env, msg.from.id)) return new Response("Forbidden", { status: 403 })

  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)

  if (msg.reply_to_message?.from?.is_bot) {
    const client = createGitHubClient(env)
    const ideas = parseIdeas((await client.readFile("ideas.md")).content)
    const idea = ideas.find((i) => i.correlation?.botMessageId === msg.reply_to_message?.message_id)
    if (idea?.correlation?.workflowInstanceId) {
      const instance = await env.PIPELINE_WORKFLOW.get(idea.correlation.workflowInstanceId)
      await instance.sendEvent({
        type: "telegram-reply",
        payload: { userId: msg.from.id, text: msg.text },
      })
    }
    return new Response("OK")
  }

  if (msg.text === "/generate") {
    const client = createGitHubClient(env)
    const ideas = parseIdeas((await client.readFile("ideas.md")).content)
    const rawIdeas = ideas.filter((i) => i.status === "raw")
    if (rawIdeas.length === 0) {
      await tg.sendMessage(msg.chat.id, "No raw ideas to generate from.")
      return new Response("OK")
    }
    const raw = rawIdeas.sort((a, b) => Number(a.id) - Number(b.id))[0]
    await env.PIPELINE_WORKFLOW.create({
      params: { ideaId: raw.id, ideaTitle: raw.title, ideaBody: raw.body },
    })
    const label = raw.title ?? raw.body.slice(0, 80)
    await tg.sendMessage(msg.chat.id, `Started workflow for idea #${raw.id}: ${label}`)
    return new Response("OK")
  }

  {
    const client = createGitHubClient(env)
    const text = msg.text

    if (text.startsWith("/add")) {
      let savedId = ""
      await client.mutateFile("ideas.md", (c) => {
        const items = parseIdeas(c)
        savedId = String(nextId(items))
        items.push({
          id: savedId,
          status: "raw" as const,
          created: new Date().toISOString(),
          source: "telegram" as const,
          body: text.slice(5).trim(),
          correlation: { telegramChatId: String(msg.chat.id) },
        })
        return serializeIdeas(items)
      })
      await tg.sendMessage(msg.chat.id, `Saved as idea #${savedId}.`)
      return new Response("OK")
    }

    if (text.startsWith("/")) {
      await tg.sendMessage(msg.chat.id, "Unknown command. Use /add <text>, /generate, or tap inline buttons.")
      return new Response("OK")
    }

    const all = parseIdeas((await client.readFile("ideas.md")).content)
    const pendingIdea = all.find((i) => i.correlation?.pendingRevision === String(msg.chat.id))

    if (pendingIdea?.correlation?.workflowInstanceId) {
      const instance = await env.PIPELINE_WORKFLOW.get(pendingIdea.correlation.workflowInstanceId)
      await instance.sendEvent({ type: "telegram-reply", payload: { userId: msg.from.id, text } })
      const ideaId = pendingIdea.id
      await client.mutateFile("ideas.md", (c) => {
        const items = parseIdeas(c)
        const idx = items.findIndex((i) => i.id === ideaId)
        if (idx !== -1) {
          const corr = items[idx].correlation
          const { pendingRevision: _, ...rest } = corr || {}
          items[idx] = { ...items[idx], correlation: rest }
        }
        return serializeIdeas(items)
      })
      return new Response("OK")
    }

    await tg.sendMessage(msg.chat.id, "Unknown command. Use /add <text>, /generate, or tap inline buttons.")
    return new Response("OK")
  }
}
