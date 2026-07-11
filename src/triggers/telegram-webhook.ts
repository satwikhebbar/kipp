import { nextId } from "../backlog/id-generator"
import { parseIdeas, serializeIdeas } from "../backlog/parser"
import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import type { Env, Idea } from "../types"

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

  const update: TelegramUpdate = await request.json()

  if (update.callback_query) {
    const cq = update.callback_query
    if (!verifyUser(env, cq.from.id)) return new Response("Forbidden", { status: 403 })

    const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
    await tg.answerCallbackQuery(cq.id)

    if (cq.data?.startsWith("confirm:") && cq.message) {
      const workflowId = cq.data.slice("confirm:".length)
      if (workflowId) {
        const instance = await env.PIPELINE_WORKFLOW.get(workflowId)
        await instance.sendEvent({ type: "confirmation", payload: { userId: cq.from.id } })
      }
    } else if (cq.data?.startsWith("revise:") && cq.message) {
      const workflowId = cq.data.slice("revise:".length)
      if (workflowId) {
        const instance = await env.PIPELINE_WORKFLOW.get(workflowId)
        await instance.sendEvent({ type: "revision", payload: { userId: cq.from.id } })
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
    await tg.sendMessage(msg.chat.id, `Started workflow for idea #${raw.id}: ${raw.title}`)
    return new Response("OK")
  }

  {
    const client = createGitHubClient(env)
    const text = msg.text
    let savedId = ""
    await client.mutateFile("ideas.md", (c) => {
      const ideas = parseIdeas(c)
      savedId = String(nextId(ideas))
      const idea: Idea = {
        id: savedId,
        title: text.slice(0, 80),
        status: "raw" as const,
        created: new Date().toISOString(),
        source: "telegram" as const,
        body: text,
      }
      return serializeIdeas([...ideas, idea])
    })
    await tg.sendMessage(msg.chat.id, `Saved as idea #${savedId}.`)
    return new Response("OK")
  }
}
