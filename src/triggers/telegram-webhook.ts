import { CALENDAR_HELP } from "../calendar/messages"
import { createInteractionRouter } from "../core/interaction-router-client"
import { type Env, INTERACTION_KIND } from "../core/types"
import { createGitHubClient } from "../integrations/github"
import { createTelegramClient } from "../integrations/telegram"
import { nextId } from "../linkedin/backlog/id-generator"
import { parseIdeas, serializeIdeas } from "../linkedin/backlog/parser"
import { logRuntime } from "../runtime/logging"

const LABEL_TRUNCATE_LENGTH = 80
const ASCII_SPACE_CODE_POINT = 32

interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
}

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
  entities?: TelegramMessageEntity[]
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

interface TelegramCommand {
  name: string
  argument: string
}

const KNOWN_TELEGRAM_COMMANDS = new Set(["add", "generate", "calendar"])

/** Reads a Telegram slash command from its bot_command entity, with a text fallback for test and legacy updates. */
function telegramCommand(message: TelegramMessage): TelegramCommand | null {
  const text = message.text
  if (!text) return null
  const entity = message.entities?.find((candidate) => candidate.type === "bot_command" && candidate.offset === 0)
  const token = entity ? text.slice(0, entity.length) : text.match(/^\/[^\s]+/u)?.[0]
  if (!token) return null
  const parsed = token.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?$/iu)
  if (!parsed) return null
  const remainder = text.slice(token.length)
  if (remainder && !/^\s/u.test(remainder)) return null
  return { name: parsed[1].toLowerCase(), argument: remainder.trim() }
}

/** Produces privacy-safe command-boundary metadata without retaining message text or command arguments. */
function telegramIngressDetails(
  message: TelegramMessage,
  command: TelegramCommand | null,
): Readonly<Record<string, string | number | boolean>> {
  const text = message.text ?? ""
  const commandEntity = message.entities?.find((candidate) => candidate.type === "bot_command")
  const fallbackTokenLength = text.match(/^\/[^\s]+/u)?.[0].length ?? 0
  const tokenLength = commandEntity?.offset === 0 ? commandEntity.length : fallbackTokenLength
  const separatorCodePoint = tokenLength > 0 && tokenLength < text.length ? (text.codePointAt(tokenLength) ?? -1) : -1
  const separatorKind =
    separatorCodePoint === -1
      ? "end-or-unavailable"
      : separatorCodePoint === ASCII_SPACE_CODE_POINT
        ? "ascii-space"
        : /^\s$/u.test(String.fromCodePoint(separatorCodePoint))
          ? "other-whitespace"
          : "non-whitespace"
  const commandToken = tokenLength > 0 ? text.slice(0, tokenLength) : ""
  return {
    messageId: message.message_id,
    chatType: message.chat.type,
    textLength: text.length,
    startsWithSlash: text.startsWith("/"),
    commandEntityPresent: Boolean(commandEntity),
    commandEntityOffset: commandEntity?.offset ?? -1,
    commandEntityLength: commandEntity?.length ?? 0,
    botAddressed: commandToken.includes("@"),
    separatorKind,
    separatorCodePoint,
    parsedCommand: command ? (KNOWN_TELEGRAM_COMMANDS.has(command.name) ? command.name : "other") : "none",
    calendarParsed: command?.name === "calendar",
    replyToBot: message.reply_to_message?.from?.is_bot === true,
  }
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
    return handleMessage(update.message, env, new URL(request.url).origin)
  }

  return new Response("OK")
}

/** Processes a Telegram message: commands, replies, and routed interactions. */
async function handleMessage(msg: TelegramMessage, env: Env, setupOrigin: string): Promise<Response> {
  if (!msg.text || !msg.from || msg.from.is_bot) return new Response("OK")
  if (!verifyUser(env, msg.from.id)) return new Response("Forbidden", { status: 403 })

  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN)
  const command = telegramCommand(msg)
  logRuntime(env, {
    event: "telegram-message-ingress",
    outcome: "started",
    details: telegramIngressDetails(msg, command),
  })

  if (msg.reply_to_message?.from?.is_bot) {
    await dispatchRoutedInteraction(env, msg.chat.id, msg.from.id, {
      telegramUpdateId: msg.message_id,
      replyToMessageId: msg.reply_to_message.message_id,
      text: msg.text,
    })
    return new Response("OK")
  }

  if (command?.name === "generate" && !command.argument) {
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

  if (command?.name === "calendar" && !command.argument) {
    await tg.sendMessage(msg.chat.id, CALENDAR_HELP)
    return new Response("OK")
  }

  if (command?.name === "calendar") {
    const requestText = command.argument
    if (!env.CALENDAR_WORKFLOW) {
      await tg.sendMessage(msg.chat.id, "Calendar scheduling is not configured yet.")
      return new Response("OK")
    }
    await env.CALENDAR_WORKFLOW.create({
      params: { chatId: String(msg.chat.id), requestText, telegramMessageId: msg.message_id, setupOrigin },
    })
    await tg.sendMessage(msg.chat.id, "Scheduling that now.")
    return new Response("OK")
  }

  {
    const client = createGitHubClient(env)
    const text = msg.text

    if (command?.name === "add") {
      let savedId = ""
      await client.mutateFile("ideas.md", (c) => {
        const items = parseIdeas(c)
        savedId = String(nextId(items))
        items.push({
          id: savedId,
          status: "raw" as const,
          created: new Date().toISOString(),
          source: "telegram" as const,
          body: command.argument,
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
  const inputKind = input.callbackToken ? "callback" : input.replyToMessageId !== undefined ? "reply" : "plain-text"
  if (!interaction) {
    logRuntime(env, { event: "telegram-interaction-route", outcome: "ignored", details: { inputKind } })
    return false
  }
  const workflow = interaction.kind.startsWith("calendar-") ? env.CALENDAR_WORKFLOW : env.PIPELINE_WORKFLOW
  if (!workflow) {
    logRuntime(env, {
      workflow: interaction.workflowId,
      interactionId: interaction.interactionId,
      event: "telegram-interaction-route",
      outcome: "not-configured",
      details: { inputKind, interactionKind: interaction.kind },
    })
    return false
  }
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
  logRuntime(env, {
    workflow: interaction.workflowId,
    interactionId: interaction.interactionId,
    event: "telegram-interaction-route",
    outcome: "succeeded",
    details: {
      inputKind,
      interactionKind: interaction.kind,
      workflowType: interaction.kind.startsWith("calendar-") ? "calendar" : "linkedin",
    },
  })
  return true
}
