import type { DecisionsClient, DecisionUsage } from "../providers/openrouter-decisions"
import { findProhibitedEasyBuys } from "./easy-buys"

/** Default probability above which an easy buy is accepted as ordinary; caller-overridable. */
export const DEFAULT_ORDINARY_EASY_BUY_THRESHOLD = 0.8

const MIN_THRESHOLD = 0.5
const EASY_BUY_POLICY = `Easy buys are the short list of ordinary ingredients a household adds for the week: staples, all-season vegetables and fruits, and everyday items from a neighborhood grocery. Long-shelf and specialty items — dry fruits, nuts, seeds, jaggery, paneer, and comparable categories — are never ordinary easy buys; when the plan needs one it must already be on hand.`

/** One easy buy the classifier judged not ordinary, with a repair-facing detail. */
export interface NonOrdinaryEasyBuy {
  item: string
  detail: string
}

export interface EasyBuyClassification {
  nonOrdinaryEasyBuys: NonOrdinaryEasyBuy[]
  usage: DecisionUsage
}

export interface EasyBuyClassifier {
  classify(easyBuys: readonly string[]): Promise<EasyBuyClassification>
}

const ZERO_USAGE: DecisionUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

/**
 * Creates a semantic easy-buy classifier over one batched Decisions request. It
 * is the open-vocabulary complement to the deterministic whole-word token list:
 * items already rejected deterministically are skipped, and every remaining
 * item becomes one `noul` question. A `Noul` probability of yes means "ordinary";
 * `p >= threshold` accepts, `p <= 1 - threshold` rejects, and the band between
 * is an uncertain rejection so an unverified item can never persist.
 */
export function createEasyBuyClassifier(
  decisions: DecisionsClient,
  options: { threshold?: number } = {},
): EasyBuyClassifier {
  const threshold = clampThreshold(options.threshold)
  return {
    async classify(easyBuys) {
      const deterministic = new Set(findProhibitedEasyBuys(easyBuys))
      const candidates = easyBuys.filter((buy) => !deterministic.has(buy))
      if (candidates.length === 0) return { nonOrdinaryEasyBuys: [], usage: ZERO_USAGE }
      const questions = Object.fromEntries(
        candidates.map((item, index) => [
          `easy_buy_${index}`,
          {
            type: "noul" as const,
            instructions: `Is "${item}" an ordinary grocery item (a staple, all-season produce, or everyday neighborhood-grocery item) rather than a long-shelf or specialty item such as a dry fruit, nut, seed, jaggery, or paneer?`,
            criteria: {
              true: "An ordinary staple, all-season produce, or everyday neighborhood-grocery item.",
              false: "A long-shelf or specialty item such as a dry fruit, nut, seed, jaggery, paneer, or comparable.",
            },
          },
        ]),
      )
      const result = await decisions.decide({ state: EASY_BUY_POLICY, questions })
      const nonOrdinaryEasyBuys: NonOrdinaryEasyBuy[] = []
      candidates.forEach((item, index) => {
        const answer = result.answers[`easy_buy_${index}`]
        if (answer?.type !== "noul") return
        if (answer.noul <= 1 - threshold) {
          nonOrdinaryEasyBuys.push({
            item,
            detail: `easy buy "${item}" is a long-shelf or specialty item, not an ordinary grocery item`,
          })
        } else if (answer.noul < threshold) {
          nonOrdinaryEasyBuys.push({
            item,
            detail: `easy buy "${item}" could not be confirmed as an ordinary grocery item`,
          })
        }
      })
      return { nonOrdinaryEasyBuys, usage: result.usage }
    },
  }
}

/** Keeps the threshold in `(0.5, 1]`; anything else falls back to the default. */
function clampThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= MIN_THRESHOLD || value > 1)
    return DEFAULT_ORDINARY_EASY_BUY_THRESHOLD
  return value
}
