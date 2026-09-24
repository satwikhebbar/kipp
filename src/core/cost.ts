import type { LLMUsage, WorkflowCost } from "./types"

type ModelPricing = { inputCacheMissPer1M: number; outputPer1M: number }

// Input is always priced at the cache-miss rate, so estimates are honest
// upper bounds (formatCostLine says so). deepseek-* are DeepSeek-direct
// prices (LinkedIn/calendar call DeepSeek directly, not via OpenRouter).
// openai/gpt-luna-latest verified 2026-09-23 against the OpenRouter model page.
// deepseek-flash is DeepSeek-V4.1-Flash's exact API model name; its peak
// cache-miss and output rates were verified 2026-09-23 against the DeepSeek
// pricing page. Legacy rows remain so historical usage records stay priced.
const PRICING: Record<string, ModelPricing> = {
  "deepseek-flash": { inputCacheMissPer1M: 0.3, outputPer1M: 1.2 },
  "deepseek-v4-flash": { inputCacheMissPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-chat": { inputCacheMissPer1M: 0.27, outputPer1M: 1.1 },
  "openai/gpt-luna-latest": { inputCacheMissPer1M: 0.125, outputPer1M: 0.5 },
  "openai/gpt-6-luna": { inputCacheMissPer1M: 0.1, outputPer1M: 0.5 },
  "openai/gpt-5.6-luna": { inputCacheMissPer1M: 0.2, outputPer1M: 1.2 },
  "gemini-2.5-flash": { inputCacheMissPer1M: 0.3, outputPer1M: 2.5 },
}

const CURRENT_PRICING_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
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
export function formatCostLine(cost: WorkflowCost, options: { preserveHistoricalPricing?: boolean } = {}): string {
  if (cost.totalCostUsd === null) return `\n\n_Model "${cost.model}" not in pricing table — no cost estimate_`
  const currentPricingModel = CURRENT_PRICING_ALIASES[cost.model]
  const currentPricing = currentPricingModel ? PRICING[currentPricingModel] : undefined
  const totalCostUsd =
    currentPricing && !options.preserveHistoricalPricing
      ? (cost.totalInputTokens / TOKENS_PER_MILLION) * currentPricing.inputCacheMissPer1M +
        (cost.totalOutputTokens / TOKENS_PER_MILLION) * currentPricing.outputPer1M
      : cost.totalCostUsd
  return (
    `\n\n_Est. cost: ~$${totalCostUsd.toFixed(COST_DECIMAL_PLACES)} ` +
    `(upper bound; ${cost.totalInputTokens} in / ${cost.totalOutputTokens} out, ${cost.model})_`
  )
}
