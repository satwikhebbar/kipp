import type { LLMUsage, WorkflowCost } from "./types"

type ModelPricing = { inputCacheMissPer1M: number; outputPer1M: number }

const PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-flash": { inputCacheMissPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-chat": { inputCacheMissPer1M: 0.27, outputPer1M: 1.1 },
  "gemini-2.0-flash": { inputCacheMissPer1M: 0.1, outputPer1M: 0.4 },
}

export function computeCost(usage: LLMUsage, model: string): WorkflowCost {
  const p = PRICING[model]
  const totalCostUsd = p
    ? (usage.inputTokens / 1_000_000) * p.inputCacheMissPer1M + (usage.outputTokens / 1_000_000) * p.outputPer1M
    : null
  return {
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    totalCostUsd,
    model,
  }
}

export function formatCostLine(cost: WorkflowCost): string {
  if (cost.totalCostUsd === null) return `\n\n_Model "${cost.model}" not in pricing table — no cost estimate_`
  return (
    `\n\n_Est. cost: ~$${cost.totalCostUsd.toFixed(4)} ` +
    `(upper bound; ${cost.totalInputTokens} in / ${cost.totalOutputTokens} out, ${cost.model})_`
  )
}
