import type { DecisionsClient, DecisionUsage } from "../providers/openrouter-decisions"
import { findProhibitedEasyBuys } from "./easy-buys"

/** Default probability above which an easy buy is accepted as ordinary; caller-overridable. */
export const DEFAULT_ORDINARY_EASY_BUY_THRESHOLD = 0.8

const MIN_THRESHOLD = 0.5
const CLASSIFICATION_POLICY = `Answer each question using its question-specific criteria and only the supplied item or meal facts. Treat packed-meal questions as judgments about the actual meal in its stated slot.`

/** One easy buy the classifier judged not ordinary, with a repair-facing detail. */
export interface NonOrdinaryEasyBuy {
  item: string
  detail: string
}

export interface EasyBuyClassification {
  nonOrdinaryEasyBuys: NonOrdinaryEasyBuy[]
  unsuitablePackedMeals: PackedMealClassification[]
  unverifiedPackedMeals: PackedMealClassification[]
  usage: DecisionUsage
}

/** Meal and slot facts sent to the semantic packed-food suitability check. */
export interface PackedMealCheck {
  day: string
  slot: string
  dish: string
  ingredients: readonly string[]
  drySlot: boolean
}

export interface PackedMealClassification {
  day: string
  slot: string
  dish: string
  detail: string
}

export interface EasyBuyClassifier {
  classify(easyBuys: readonly string[], packedMeals?: readonly PackedMealCheck[]): Promise<EasyBuyClassification>
}

const ZERO_USAGE: DecisionUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

/**
 * Creates a batched semantic classifier for easy buys and packed meals. It is
 * the open-vocabulary complement to deterministic easy-buy token matching:
 * items already rejected deterministically are skipped, and remaining checks
 * become separate `noul` questions. A `noul` probability above the threshold
 * accepts; a low or uncertain probability never permits unverified evidence.
 */
export function createEasyBuyClassifier(
  decisions: DecisionsClient,
  options: { threshold?: number } = {},
): EasyBuyClassifier {
  const threshold = clampThreshold(options.threshold)
  return {
    async classify(easyBuys, packedMeals = []) {
      const deterministic = new Set(findProhibitedEasyBuys(easyBuys))
      const candidates = easyBuys.filter((buy) => !deterministic.has(buy))
      if (candidates.length === 0 && packedMeals.length === 0)
        return { nonOrdinaryEasyBuys: [], unsuitablePackedMeals: [], unverifiedPackedMeals: [], usage: ZERO_USAGE }
      const questions: Record<
        string,
        { type: "noul"; instructions: string; criteria: { true: string; false: string } }
      > = {}
      candidates.forEach((item, index) => {
        questions[`easy_buy_${index}`] = {
          type: "noul",
          instructions: `Is "${item}" an ordinary grocery item (a staple, all-season produce, or everyday neighborhood-grocery item) rather than a long-shelf or specialty item such as a dry fruit, nut, seed, jaggery, or paneer?`,
          criteria: {
            true: "An ordinary staple, all-season produce, or everyday neighborhood-grocery item.",
            false: "A long-shelf or specialty item such as a dry fruit, nut, seed, jaggery, paneer, or comparable.",
          },
        }
      })
      packedMeals.forEach((meal, index) => {
        questions[`packed_meal_${index}`] = {
          type: "noul",
          instructions: `Is the meal "${meal.dish}" with ingredients [${meal.ingredients.join(", ")}] suitable for ${meal.day} ${meal.slot} in an ordinary school lunchbox? It must travel safely without likely spilling or leaking, be independently edible by hand or ordinary spoon, and require no reheating, cooking, assembly, or special equipment.${meal.drySlot ? " This is a dry slot, so the food must also be dry and spill-resistant." : ""}`,
          criteria: {
            true: "The actual meal meets every stated transport, eating, preparation, and slot requirement.",
            false: "The actual meal violates any stated transport, eating, preparation, or slot requirement.",
          },
        }
      })
      const result = await decisions.decide({ state: CLASSIFICATION_POLICY, questions })
      const nonOrdinaryEasyBuys: NonOrdinaryEasyBuy[] = []
      candidates.forEach((item, index) => {
        const answer = result.answers[`easy_buy_${index}`]
        // A missing or non-`noul` answer never judged the item; treat it as
        // uncertain so an unverified easy buy can never persist.
        if (answer?.type !== "noul") {
          nonOrdinaryEasyBuys.push({
            item,
            detail: `easy buy "${item}" could not be confirmed as an ordinary grocery item`,
          })
          return
        }
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
      const unsuitablePackedMeals: PackedMealClassification[] = []
      const unverifiedPackedMeals: PackedMealClassification[] = []
      packedMeals.forEach((meal, index) => {
        const base = { day: meal.day, slot: meal.slot, dish: meal.dish }
        const answer = result.answers[`packed_meal_${index}`]
        if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          unverifiedPackedMeals.push({
            ...base,
            detail: `packed meal "${meal.dish}" could not be verified as suitable for ${meal.slot}`,
          })
        } else if (answer.noul <= 1 - threshold) {
          unsuitablePackedMeals.push({
            ...base,
            detail: `packed meal "${meal.dish}" is not suitable for ${meal.slot}`,
          })
        } else if (answer.noul < threshold) {
          unverifiedPackedMeals.push({
            ...base,
            detail: `packed meal "${meal.dish}" could not be verified as suitable for ${meal.slot}`,
          })
        }
      })
      return { nonOrdinaryEasyBuys, unsuitablePackedMeals, unverifiedPackedMeals, usage: result.usage }
    },
  }
}

/** Keeps the threshold in `(0.5, 1]`; anything else falls back to the default. */
function clampThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= MIN_THRESHOLD || value > 1)
    return DEFAULT_ORDINARY_EASY_BUY_THRESHOLD
  return value
}
