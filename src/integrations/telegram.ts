const TELEGRAM_API = "https://api.telegram.org"

export function createTelegramClient(token: string) {
  async function call(method: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Telegram API error ${res.status} on ${method}`)
  }

  async function sendMessage(
    chatId: number | string,
    text: string,
    opts?: { replyMarkup?: Record<string, unknown> },
  ): Promise<void> {
    await call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    })
  }

  async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    })
  }

  return { sendMessage, answerCallbackQuery }
}
