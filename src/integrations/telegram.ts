const TELEGRAM_API = "https://api.telegram.org"

/** Creates a Telegram Bot API client. */
export function createTelegramClient(token: string) {
  async function call<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw new Error(`Telegram API error ${res.status} on ${method}: ${await res.text()}`)
    return (await res.json()) as T
  }

  async function sendMessage(
    chatId: number | string,
    text: string,
    opts?: { replyMarkup?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<{ messageId: number }> {
    const data = await call<{ result: { message_id: number } }>(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      },
      opts?.signal,
    )
    return { messageId: data.result.message_id }
  }

  async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    })
  }

  return { sendMessage, answerCallbackQuery }
}
