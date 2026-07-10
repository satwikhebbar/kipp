import type { LLMResponse } from "../types"
import type { GenerateOptions } from "./llm"

export function createDeepseekGenerator(apiKey: string) {
  return async ({ system, prompt }: GenerateOptions): Promise<LLMResponse> => {
    const messages: Array<{ role: string; content: string }> = []
    if (system) messages.push({ role: "system", content: system })
    messages.push({ role: "user", content: prompt })

    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "deepseek-chat", messages }),
    })

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      text: data.choices[0].message.content,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    }
  }
}
