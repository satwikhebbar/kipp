import type { DecisionQuestion, DecisionsClient, DecisionUsage } from "../providers/openrouter-decisions"
import { findProhibitedEasyBuys } from "./easy-buys"
import type { PolicyOutcomeValue, WeeklyInventory } from "./types"

/** Default probability above which an easy buy is accepted as ordinary; caller-overridable. */
export const DEFAULT_ORDINARY_EASY_BUY_THRESHOLD = 0.8

const MIN_THRESHOLD = 0.5
const CLASSIFICATION_POLICY = `Answer each question using its question-specific criteria and only the supplied item, meal, policy, outcome, feedback, and plan facts. Judge packed-meal questions about the actual meal in its stated slot. Judge feedback from the authoritative request and scoped before-and-after plan evidence; a changed cell alone does not prove the request was satisfied.`

/** One easy buy the classifier judged not ordinary, with a repair-facing detail. */
export interface NonOrdinaryEasyBuy {
  item: string
  detail: string
}

export interface EasyBuyClassification {
  nonOrdinaryEasyBuys: NonOrdinaryEasyBuy[]
  unsuitablePackedMeals: PackedMealClassification[]
  unverifiedPackedMeals: PackedMealClassification[]
  unsupportedPolicyOutcomes: PersistentPolicyClassification[]
  unverifiedPolicyOutcomes: PersistentPolicyClassification[]
  unaddressedFeedback: FeedbackClassification[]
  unverifiedFeedback: FeedbackClassification[]
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

/** A persistent outcome claim and the complete hydrated plan evidence used to judge it. */
export interface PersistentPolicyCheck {
  policyId: string
  label: string
  value: string
  outcome: "satisfied" | "trade-off"
  rationale: string
  easyBuys: readonly string[]
  weeklyInventory: WeeklyInventory
  planCells: readonly {
    day: string
    slot: string
    dish: string
    ingredients: readonly string[]
    cookMinutes: number
    priorNightPrep: boolean
  }[]
}

export interface PersistentPolicyClassification {
  policyId: string
  label: string
  detail: string
}

/** An authoritative feedback request that could not be semantically verified. */
export interface FeedbackClassification {
  feedbackId: string
  detail: string
}

/** A scoped before-and-after cell change supplied for an authoritative feedback check. */
export interface FeedbackPlanChange {
  day: string
  slot: string
  before: FeedbackPlanCell | null
  after: FeedbackPlanCell | null
}

export interface FeedbackPlanCell {
  dish: string
  ingredients: readonly string[]
  cookMinutes: number
  priorNightPrep: boolean
}

export interface FeedbackCheck {
  feedbackId: string
  text: string
  scope: { day?: string; slot?: string }
  changes: readonly FeedbackPlanChange[]
  citedOutcomes: readonly FeedbackCitedOutcome[]
  easyBuys: readonly string[]
  reviewedEasyBuys: readonly string[]
  addedEasyBuys: readonly string[]
  removedEasyBuys: readonly string[]
  hasReferenceCells: boolean
  hasCandidateCells: boolean
}

export interface FeedbackCitedOutcome {
  policyId: string
  policyLabel: string
  policy: string
  outcome: PolicyOutcomeValue
  rationale: string
}

export interface EasyBuyClassifier {
  classify(
    easyBuys: readonly string[],
    packedMeals?: readonly PackedMealCheck[],
    persistentPolicies?: readonly PersistentPolicyCheck[],
    feedbackChecks?: readonly FeedbackCheck[],
  ): Promise<EasyBuyClassification>
}

const ZERO_USAGE: DecisionUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

/**
 * Creates a batched semantic classifier for easy buys, packed meals, and
 * persistent-policy outcome claims. Deterministically rejected easy buys are
 * skipped; each remaining check becomes a separate `noul` question. A `noul`
 * probability above the threshold accepts; a low or uncertain probability
 * never permits unverified evidence.
 */
export function createEasyBuyClassifier(
  decisions: DecisionsClient,
  options: { threshold?: number } = {},
): EasyBuyClassifier {
  const threshold = clampThreshold(options.threshold)
  return {
    async classify(easyBuys, packedMeals = [], persistentPolicies = [], feedbackChecks = []) {
      const deterministic = new Set(findProhibitedEasyBuys(easyBuys))
      const candidates = easyBuys.filter((buy) => !deterministic.has(buy))
      if (
        candidates.length === 0 &&
        packedMeals.length === 0 &&
        persistentPolicies.length === 0 &&
        feedbackChecks.length === 0
      )
        return {
          nonOrdinaryEasyBuys: [],
          unsuitablePackedMeals: [],
          unverifiedPackedMeals: [],
          unsupportedPolicyOutcomes: [],
          unverifiedPolicyOutcomes: [],
          unaddressedFeedback: [],
          unverifiedFeedback: [],
          usage: ZERO_USAGE,
        }
      const questions: Record<string, DecisionQuestion> = {}
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
      persistentPolicies.forEach((policy, index) => {
        questions[`persistent_policy_${index}`] = {
          type: "noul",
          instructions: {
            question: `Does the hydrated plan support the recorded ${policy.outcome} claim for persistent policy "${policy.label}"? For satisfied, check that the plan meets the policy. For trade-off, check that the plan and rationale accurately describe a real compromise. Judge the claim against the policy text and rationale; do not treat the existence of a rationale as proof.`,
            policyId: policy.policyId,
            policy: policy.value,
            recordedOutcome: policy.outcome,
            rationale: policy.rationale,
            easyBuys: policy.easyBuys,
            weeklyInventory: policy.weeklyInventory,
            planCells: policy.planCells,
          },
          criteria: {
            true: "The hydrated plan evidence supports the recorded outcome and rationale for this persistent policy.",
            false: "The hydrated plan contradicts or does not support the recorded outcome or rationale.",
          },
        }
      })
      feedbackChecks.forEach((check, index) => {
        questions[`feedback_${index}`] = {
          type: "noul",
          instructions: {
            question: `Does the final plan satisfy this authoritative feedback request? Compare before-and-after cells only within the supplied scope, including whether any reference or candidate cell exists there. Compare the reviewed and final easy-buy lists and their additions/removals against the request. Evaluate any cited policy outcome and rationale against the request, inventory facts, and plan. A cell change or a rationale that only cites the feedback id is not sufficient.`,
            feedback: check.text,
            scope: check.scope,
            beforeAfter: check.changes,
            citedOutcomes: check.citedOutcomes,
            easyBuys: check.easyBuys,
            reviewedEasyBuys: check.reviewedEasyBuys,
            addedEasyBuys: check.addedEasyBuys,
            removedEasyBuys: check.removedEasyBuys,
            hasReferenceCells: check.hasReferenceCells,
            hasCandidateCells: check.hasCandidateCells,
          },
          criteria: {
            true: "The after-plan evidence satisfies the authoritative feedback request for its scope.",
            false: "The after-plan evidence does not satisfy the request, even if a scoped cell changed.",
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
      const unsupportedPolicyOutcomes: PersistentPolicyClassification[] = []
      const unverifiedPolicyOutcomes: PersistentPolicyClassification[] = []
      persistentPolicies.forEach((policy, index) => {
        const base = { policyId: policy.policyId, label: policy.label }
        const answer = result.answers[`persistent_policy_${index}`]
        if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          unverifiedPolicyOutcomes.push({
            ...base,
            detail: `outcome "${policy.outcome}" for persistent policy "${policy.label}" could not be verified`,
          })
        } else if (answer.noul <= 1 - threshold) {
          unsupportedPolicyOutcomes.push({
            ...base,
            detail: `outcome "${policy.outcome}" for persistent policy "${policy.label}" is not supported by the hydrated plan`,
          })
        } else if (answer.noul < threshold) {
          unverifiedPolicyOutcomes.push({
            ...base,
            detail: `outcome "${policy.outcome}" for persistent policy "${policy.label}" could not be verified`,
          })
        }
      })
      const unaddressedFeedback: FeedbackClassification[] = []
      const unverifiedFeedback: FeedbackClassification[] = []
      feedbackChecks.forEach((check, index) => {
        const answer = result.answers[`feedback_${index}`]
        if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          unverifiedFeedback.push({
            feedbackId: check.feedbackId,
            detail: `authoritative feedback "${check.feedbackId}" could not be verified against its scoped before-and-after plan evidence`,
          })
        } else if (answer.noul <= 1 - threshold) {
          unaddressedFeedback.push({
            feedbackId: check.feedbackId,
            detail: `authoritative feedback "${check.feedbackId}" is not satisfied by the after-plan evidence in its scope`,
          })
        } else if (answer.noul < threshold) {
          unverifiedFeedback.push({
            feedbackId: check.feedbackId,
            detail: `authoritative feedback "${check.feedbackId}" could not be verified against its scoped before-and-after plan evidence`,
          })
        }
      })
      return {
        nonOrdinaryEasyBuys,
        unsuitablePackedMeals,
        unverifiedPackedMeals,
        unsupportedPolicyOutcomes,
        unverifiedPolicyOutcomes,
        unaddressedFeedback,
        unverifiedFeedback,
        usage: result.usage,
      }
    },
  }
}

/** Keeps the threshold in `(0.5, 1]`; anything else falls back to the default. */
function clampThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= MIN_THRESHOLD || value > 1)
    return DEFAULT_ORDINARY_EASY_BUY_THRESHOLD
  return value
}
