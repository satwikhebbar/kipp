import type { LLMUsage, WorkflowCost } from "./types"

type ModelPricing = { inputCacheMissPer1M: number; outputPer1M: number }

// Input is always priced at the cache-miss rate, so estimates are honest
// upper bounds (formatCostLine says so). deepseek-* are DeepSeek-direct
// prices (LinkedIn/calendar call DeepSeek directly, not via OpenRouter).
// openai/gpt-5.6-luna and google/gemini-2.5-flash verified 2026-09-08 against
// the OpenRouter models API. The deepseek rows predate this change and match
// DeepSeek's direct pricing; api-docs.deepseek.com is client-rendered, so
// re-confirm them against platform.deepseek.com before relying on a tight
// estimate.
const PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-flash": { inputCacheMissPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-chat": { inputCacheMissPer1M: 0.27, outputPer1M: 1.1 },
  "openai/gpt-5.6-luna": { inputCacheMissPer1M: 0.2, outputPer1M: 1.2 },
  "gemini-2.5-flash": { inputCacheMissPer1M: 0.3, outputPer1M: 2.5 },
}

const TOKENS_PER_MILLION = 1_000_000
const COST_DECIMAL_PLACES = 4

/** Computes the estimated USD cost for an LLM usage record against known model pricing. */
export function computeCost(usage: LLMUsage, model: string): WorkflowCost {
  const p = PRICING[model]
  const totalCostUsd = p
    ? (usage.inputTokens / TOKENS_PER_MILLION) * p.inputCacheMissPer1M +
      (usage.outputTokens / TOKENS_PER_MILLION) * p.outputPer1M
    : null
  return {
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    totalCostUsd,
    model,
  }
}

/** Usage attributed to a single model, used to price cumulative multi-model totals. */
export interface ModelUsage extends LLMUsage {
  model: string
}

/**
 * Computes the estimated cost across usage grouped by model, pricing each group
 * at its own model's rate so a plan that spans a model change stays accurate.
 * The returned `model` label joins the distinct models.
 */
export function computeCostByModel(groups: ModelUsage[]): WorkflowCost {
  let totalCostUsd: number | null = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const models: string[] = []
  for (const group of groups) {
    const groupCost = computeCost(group, group.model)
    if (groupCost.totalCostUsd === null || totalCostUsd === null) {
      totalCostUsd = null
    } else {
      totalCostUsd += groupCost.totalCostUsd
    }
    totalInputTokens += group.inputTokens
    totalOutputTokens += group.outputTokens
    if (!models.includes(group.model)) models.push(group.model)
  }
  return { totalInputTokens, totalOutputTokens, totalCostUsd, model: models.join(" + ") }
}

/** Formats a cost object as a Markdown line for display. */
export function formatCostLine(cost: WorkflowCost): string {
  if (cost.totalCostUsd === null) return `\n\n_Model "${cost.model}" not in pricing table — no cost estimate_`
  return (
    `\n\n_Est. cost: ~$${cost.totalCostUsd.toFixed(COST_DECIMAL_PLACES)} ` +
    `(upper bound; ${cost.totalInputTokens} in / ${cost.totalOutputTokens} out, ${cost.model})_`
  )
}
