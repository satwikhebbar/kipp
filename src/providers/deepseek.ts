import type { LLMResponse } from "../types"
import type { GenerateOptions } from "./llm"

export function createDeepseekGenerator(apiKey: string, modelName = "deepseek-chat") {
  return async ({ messages }: GenerateOptions): Promise<LLMResponse> => {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelName, messages }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`DeepSeek API error ${res.status}: ${body}`)
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    if (!data.choices?.length) {
      throw new Error("DeepSeek returned empty choices")
    }

    return {
      text: data.choices[0].message.content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    }
  }
}
