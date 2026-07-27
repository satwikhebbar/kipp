import { nextId } from "../backlog/id-generator"
import { parseIdeas, serializeIdeas } from "../backlog/parser"
import { CALENDAR_HELP } from "../calendar-messages"
import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import { createInteractionRouter } from "../interaction-router-client"
import { logRuntime } from "../runtime/logging"
import { type Env, INTERACTION_KIND } from "../types"

const LABEL_TRUNCATE_LENGTH = 80
const ADD_COMMAND_PREFIX_LENGTH = 5

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

/** Checks if a Telegram user ID is allowed, or allows all if no restriction is configured. */
function verifyUser(env: Env, userId: number): boolean {
  if (!env.TELEGRAM_ALLOWED_USER_ID) return true
  return String(userId) === env.TELEGRAM_ALLOWED_USER_ID
}

/** Handles an incoming Telegram webhook update. */
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
  logRuntime(env, { event: "telegram-update", outcome: "started" })

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

    logRuntime(env, { event: "telegram-callback", outcome: "succeeded" })
    return new Response("OK")
  }

  if (update.message) {
    return handleMessage(update.message, env)
  }

  return new Response("OK")
}

/** Processes a Telegram message: commands, replies, and routed interactions. */
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
    logRuntime(env, { event: "linkedin-generation-request", outcome: "started" })
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
    const label = raw.title ?? raw.body.slice(0, LABEL_TRUNCATE_LENGTH)
    await tg.sendMessage(msg.chat.id, `Started workflow for idea #${raw.id}: ${label}`)
    logRuntime(env, { event: "linkedin-generation-request", outcome: "succeeded" })
    return new Response("OK")
  }

  if (msg.text === "/calendar") {
    await tg.sendMessage(msg.chat.id, CALENDAR_HELP)
    return new Response("OK")
  }

  if (msg.text.startsWith("/calendar ")) {
    const requestText = msg.text.slice("/calendar ".length).trim()
    if (!requestText) {
      await tg.sendMessage(msg.chat.id, CALENDAR_HELP)
      return new Response("OK")
    }
    if (!env.CALENDAR_WORKFLOW) {
      await tg.sendMessage(msg.chat.id, "Calendar scheduling is not configured yet.")
      return new Response("OK")
    }
    await env.CALENDAR_WORKFLOW.create({
      params: { chatId: String(msg.chat.id), requestText, telegramMessageId: msg.message_id },
    })
    await tg.sendMessage(msg.chat.id, "Scheduling that now.")
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
          body: text.slice(ADD_COMMAND_PREFIX_LENGTH).trim(),
          correlation: { telegramChatId: String(msg.chat.id) },
        })
        return serializeIdeas(items)
      })
      await tg.sendMessage(msg.chat.id, `Saved as idea #${savedId}.`)
      return new Response("OK")
    }

    if (text.startsWith("/")) {
      await tg.sendMessage(
        msg.chat.id,
        "Unknown command. Use /add <text>, /generate, /calendar <request>, or tap inline buttons.",
      )
      return new Response("OK")
    }

    const routed = await dispatchRoutedInteraction(env, msg.chat.id, msg.from.id, {
      telegramUpdateId: msg.message_id,
      text,
    })
    if (routed) return new Response("OK")

    await tg.sendMessage(
      msg.chat.id,
      "Unknown command. Use /add <text>, /generate, /calendar <request>, or tap inline buttons.",
    )
    return new Response("OK")
  }
}

/** Resolves a routed interaction and sends an event to the workflow instance. */
async function dispatchRoutedInteraction(
  env: Env,
  chatId: number,
  userId: number,
  input: { telegramUpdateId: number; callbackToken?: string; replyToMessageId?: number; text?: string },
): Promise<boolean> {
  const router = createInteractionRouter(env.INTERACTION_ROUTER, chatId)
  const { interaction } = await router.resolve(input)
  if (!interaction) return false
  const workflow = interaction.kind.startsWith("calendar-") ? env.CALENDAR_WORKFLOW : env.PIPELINE_WORKFLOW
  if (!workflow) return false
  const instance = await workflow.get(interaction.workflowId)
  const interactionText =
    interaction.text ??
    (interaction.kind === INTERACTION_KIND.APPROVE
      ? "__approve__"
      : interaction.kind === INTERACTION_KIND.REVISE
        ? "__revise__"
        : `__${interaction.kind}__`)
  await instance.sendEvent({
    type: "telegram-reply",
    payload: {
      userId,
      text: interactionText,
      interactionId: interaction.interactionId,
      interactionVersion: interaction.version,
      interactionKind: interaction.kind,
      telegramUpdateId: interaction.telegramUpdateId,
    },
  })
  return true
}
