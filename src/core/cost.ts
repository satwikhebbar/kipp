import type { LLMUsage, WorkflowCost } from "./types"

type ModelPricing = { inputCacheMissPer1M: number; outputPer1M: number }

// Input is priced at the cache-miss rate. deepseek-* are DeepSeek-direct
// prices (LinkedIn/calendar call DeepSeek directly, not via OpenRouter).
// ~openai/gpt-luna-latest verified 2026-09-23 against the OpenRouter model page.
// deepseek-flash is DeepSeek-V4.1-Flash's exact API model name; its peak
// cache-miss and output rates were verified 2026-09-23 against the DeepSeek
// pricing page. Legacy rows remain so historical usage records stay priced.
const PRICING: Record<string, ModelPricing> = {
  "deepseek-flash": { inputCacheMissPer1M: 0.3, outputPer1M: 1.2 },
  "deepseek-v4-flash": { inputCacheMissPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-chat": { inputCacheMissPer1M: 0.27, outputPer1M: 1.1 },
  "~openai/gpt-luna-latest": { inputCacheMissPer1M: 0.1, outputPer1M: 0.5 },
  "openai/gpt-6-luna": { inputCacheMissPer1M: 0.1, outputPer1M: 0.5 },
  "openai/gpt-5.6-luna": { inputCacheMissPer1M: 0.2, outputPer1M: 1.2 },
  "gemini-2.5-flash": { inputCacheMissPer1M: 0.3, outputPer1M: 2.5 },
}

const CURRENT_PRICING_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
}

const TOKENS_PER_MILLION = 1_000_000
const COST_DECIMAL_PLACES = 4

/** Combines reported amounts without treating a partial sum as complete. */
export function addReportedCostUsd(
  left: number | null | undefined,
  right: number | null | undefined,
  hasLeftUsage: boolean,
): number | null | undefined {
  if (!hasLeftUsage) return right
  if (left === undefined && right === undefined) return undefined
  if (typeof left === "number" && typeof right === "number") return left + right
  return null
}

/** Uses a reported USD amount when present, otherwise estimates from known model pricing. */
export function computeCost(usage: LLMUsage, model: string): WorkflowCost {
  const p = PRICING[model]
  const reportedCostUsd = usage.reportedCostUsd
  const hasReportedCost = reportedCostUsd !== undefined
  const totalCostUsd = hasReportedCost
    ? reportedCostUsd
    : p
      ? (usage.inputTokens / TOKENS_PER_MILLION) * p.inputCacheMissPer1M +
        (usage.outputTokens / TOKENS_PER_MILLION) * p.outputPer1M
      : null
  return {
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    totalCostUsd,
    model,
    costKind:
      reportedCostUsd === null ? "unavailable" : hasReportedCost ? "reported" : p ? "estimated" : "unknown-model",
  }
}

/** Usage attributed to one model and its reported-cost availability. */
export interface ModelUsage extends LLMUsage {
  model: string
}

/**
 * Computes cost across usage groups, using reported amounts where available
 * and model pricing for legacy or non-reporting groups. The returned `model`
 * label joins the distinct models.
 */
export function computeCostByModel(groups: ModelUsage[]): WorkflowCost {
  let totalCostUsd: number | null = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const models: string[] = []
  let hasReported = false
  let hasEstimate = false
  let hasUnavailable = false
  let hasUnknownModel = false
  for (const group of groups) {
    const groupCost = computeCost(group, group.model)
    hasReported ||= groupCost.costKind === "reported"
    hasEstimate ||= groupCost.costKind === "estimated"
    hasUnavailable ||= groupCost.costKind === "unavailable"
    hasUnknownModel ||= groupCost.costKind === "unknown-model"
    if (groupCost.totalCostUsd === null || totalCostUsd === null) {
      totalCostUsd = null
    } else {
      totalCostUsd += groupCost.totalCostUsd
    }
    totalInputTokens += group.inputTokens
    totalOutputTokens += group.outputTokens
    if (!models.includes(group.model)) models.push(group.model)
  }
  const costKind = hasUnavailable
    ? "unavailable"
    : hasUnknownModel
      ? "unknown-model"
      : hasEstimate || !hasReported
        ? "estimated"
        : "reported"
  return { totalInputTokens, totalOutputTokens, totalCostUsd, model: models.join(" + "), costKind }
}

/** Formats a cost object as a Markdown line for display. */
export function formatCostLine(cost: WorkflowCost, options: { preserveHistoricalPricing?: boolean } = {}): string {
  if (cost.totalCostUsd === null) {
    if (cost.costKind === "unavailable")
      return (
        `\n\n_Cost unavailable: OpenRouter did not report the complete usage cost ` +
        `(${cost.totalInputTokens} in / ${cost.totalOutputTokens} out, ${cost.model})_`
      )
    return (
      `\n\n_Model "${cost.model}" not in pricing table — no cost estimate ` +
      `(${cost.totalInputTokens} in / ${cost.totalOutputTokens} out)_`
    )
  }
  const currentPricingModel = CURRENT_PRICING_ALIASES[cost.model]
  const currentPricing = currentPricingModel ? PRICING[currentPricingModel] : undefined
  const totalCostUsd =
    currentPricing && !options.preserveHistoricalPricing && cost.costKind !== "reported"
      ? (cost.totalInputTokens / TOKENS_PER_MILLION) * currentPricing.inputCacheMissPer1M +
        (cost.totalOutputTokens / TOKENS_PER_MILLION) * currentPricing.outputPer1M
      : cost.totalCostUsd
  const costLabel = cost.costKind === "reported" ? "Cost: $" : "Est. cost: ~$"
  return (
    `\n\n_${costLabel}${totalCostUsd.toFixed(COST_DECIMAL_PLACES)} ` +
    `(${cost.totalInputTokens} in / ${cost.totalOutputTokens} out, ${cost.model})_`
  )
}
