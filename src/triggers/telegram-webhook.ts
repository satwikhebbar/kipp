import { nextId } from "../backlog/id-generator"
import { parseIdeas, serializeIdeas } from "../backlog/parser"
import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import { createInteractionRouter } from "../interaction-router-client"
import { type Env, INTERACTION_KIND } from "../types"

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

    if (cq.data && cq.message)
      await dispatchRoutedInteraction(env, cq.message.chat.id, cq.from.id, {
        telegramUpdateId: update.update_id,
        callbackToken: cq.data,
      })

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
    await dispatchRoutedInteraction(env, msg.chat.id, msg.from.id, {
      telegramUpdateId: msg.message_id,
      replyToMessageId: msg.reply_to_message.message_id,
      text: msg.text,
    })
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

    const routed = await dispatchRoutedInteraction(env, msg.chat.id, msg.from.id, {
      telegramUpdateId: msg.message_id,
      text,
    })
    if (routed) return new Response("OK")

    await tg.sendMessage(msg.chat.id, "Unknown command. Use /add <text>, /generate, or tap inline buttons.")
    return new Response("OK")
  }
}

async function dispatchRoutedInteraction(
  env: Env,
  chatId: number,
  userId: number,
  input: { telegramUpdateId: number; callbackToken?: string; replyToMessageId?: number; text?: string },
): Promise<boolean> {
  const router = createInteractionRouter(env.INTERACTION_ROUTER, chatId)
  const { interaction } = await router.resolve(input)
  if (!interaction) return false
  const instance = await env.PIPELINE_WORKFLOW.get(interaction.workflowId)
  await instance.sendEvent({
    type: "telegram-reply",
    payload: {
      userId,
      text:
        interaction.kind === INTERACTION_KIND.APPROVE
          ? "__approve__"
          : interaction.kind === INTERACTION_KIND.REVISE
            ? "__revise__"
            : interaction.text,
      interactionId: interaction.interactionId,
      interactionVersion: interaction.version,
      interactionKind: interaction.kind,
      telegramUpdateId: interaction.telegramUpdateId,
    },
  })
  return true
}
