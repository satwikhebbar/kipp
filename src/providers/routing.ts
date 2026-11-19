/** Maps configured model names to OpenRouter IDs while retaining the selected model family. */
export function resolveOpenRouterModel(provider: string, modelName?: string): string {
  const defaults: Record<string, string> = {
    gemini: "gemini-2.5-flash",
    deepseek: "deepseek-flash",
    openrouter: "~openai/gpt-luna-latest",
  }
  const model = modelName || defaults[provider || "gemini"]
  if (!model) throw new Error(`Unknown LLM provider: "${provider}"`)
  if (model.includes("/")) return model
  if (model === "deepseek-flash") return "~deepseek/deepseek-flash-latest"
  if (model.startsWith("deepseek-")) return `deepseek/${model}`
  if (model.startsWith("gemini-")) return `google/${model}`
  throw new Error(`Configure LLM_MODEL with an OpenRouter model ID for "${model}"`)
}
