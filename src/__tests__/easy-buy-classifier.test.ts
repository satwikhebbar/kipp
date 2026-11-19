import { describe, expect, it, vi } from "vitest"
import { createEasyBuyClassifier, DEFAULT_ORDINARY_EASY_BUY_THRESHOLD } from "../meal-planning/easy-buy-classifier"
import { findProhibitedEasyBuys } from "../meal-planning/easy-buys"
import type { DecisionAnswer, DecisionsClient } from "../providers/openrouter-decisions"

function decisionsReturning(probabilities: number[], seen: string[][] = []): DecisionsClient {
  return {
    async decide({ questions }) {
      const ids = Object.keys(questions)
      seen.push(ids)
      const answers: Record<string, DecisionAnswer> = {}
      ids.forEach((id, index) => {
        answers[id] = { type: "noul", noul: probabilities[index] ?? 0 }
      })
      return {
        id: "gen-dec",
        model: "openai/gpt-6-luna-decisions",
        provider: "OpenAI",
        answers,
        usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.0005 },
      }
    },
  }
}

describe("deterministic easy-buy token matching", () => {
  it("matches prohibited stems only as whole words", () => {
    expect(findProhibitedEasyBuys(["seedless grapes"])).toEqual([])
    expect(findProhibitedEasyBuys(["mixed seeds", "paneer"])).toEqual(["mixed seeds", "paneer"])
  })
})

describe("easy-buy classifier", () => {
  it("defaults the ordinary threshold to 0.8", () => {
    expect(DEFAULT_ORDINARY_EASY_BUY_THRESHOLD).toBe(0.8)
  })

  it("batch-classifies every unresolved easy buy in one request", async () => {
    const seen: string[][] = []
    const classifier = createEasyBuyClassifier(decisionsReturning([0.97, 0.05, 0.9], seen))
    const result = await classifier.classify(["carrot", "dried apricots", "spinach"])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(["easy_buy_0", "easy_buy_1", "easy_buy_2"])
    expect(result.nonOrdinaryEasyBuys.map((entry) => entry.item)).toEqual(["dried apricots"])
    expect(result.unsuitablePackedMeals).toEqual([])
    expect(result.unverifiedPackedMeals).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 0, costUsd: 0.0005 })
  })

  it("does not spend a question on an item the deterministic list already rejects", async () => {
    const seen: string[][] = []
    const classifier = createEasyBuyClassifier(decisionsReturning([0.95], seen))
    const result = await classifier.classify(["dates", "carrot"])
    expect(seen[0]).toEqual(["easy_buy_0"])
    expect(result.nonOrdinaryEasyBuys).toEqual([])
  })

  it("rejects both the prohibited and the uncertain probability band", async () => {
    const classifier = createEasyBuyClassifier(decisionsReturning([0.8, 0.79, 0.2, 0.5]))
    const result = await classifier.classify(["ordinary", "unsure", "banned", "coinflip"])
    expect(result.nonOrdinaryEasyBuys.map((entry) => entry.item)).toEqual(["unsure", "banned", "coinflip"])
  })

  it("treats a missing or non-noul answer as an uncertain rejection, not an ordinary item", async () => {
    const withAnswers = (answers: Record<string, DecisionAnswer>): DecisionsClient => ({
      async decide() {
        return {
          id: "gen-dec",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers,
          usage: { inputTokens: 3, outputTokens: 0, costUsd: 0.001 },
        }
      },
    })
    const missing = createEasyBuyClassifier(withAnswers({}))
    expect((await missing.classify(["carrot"])).nonOrdinaryEasyBuys.map((entry) => entry.item)).toEqual(["carrot"])
    const wrongType = createEasyBuyClassifier(withAnswers({ easy_buy_0: { type: "choice", choice: "ordinary" } }))
    expect((await wrongType.classify(["spinach"])).nonOrdinaryEasyBuys.map((entry) => entry.item)).toEqual(["spinach"])
  })

  it("honors a caller threshold override", async () => {
    const classifier = createEasyBuyClassifier(decisionsReturning([0.7]), { threshold: 0.6 })
    const result = await classifier.classify(["curd"])
    expect(result.nonOrdinaryEasyBuys).toEqual([])
  })

  it("batch-classifies packed meals with easy buys and separates fail from uncertain", async () => {
    const seen: string[][] = []
    const classifier = createEasyBuyClassifier(decisionsReturning([0.99, 0.55, 0.1], seen))
    const result = await classifier.classify(
      ["carrot"],
      [
        { day: "Mon", slot: "snack1", dish: "banana", ingredients: ["banana"], drySlot: true },
        { day: "Mon", slot: "school-lunch", dish: "wet curry", ingredients: ["rice", "curry"], drySlot: false },
      ],
    )
    expect(seen).toEqual([["easy_buy_0", "packed_meal_0", "packed_meal_1"]])
    expect(result.unsuitablePackedMeals).toMatchObject([{ dish: "wet curry", slot: "school-lunch" }])
    expect(result.unverifiedPackedMeals).toMatchObject([{ dish: "banana", slot: "snack1" }])
  })

  it("marks missing and malformed packed-meal answers as unverified", async () => {
    const decisions: DecisionsClient = {
      async decide() {
        return {
          id: "gen-dec",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers: { packed_meal_1: { type: "noul", noul: Number.NaN } },
          usage: { inputTokens: 3, outputTokens: 0, costUsd: 0.001 },
        }
      },
    }
    const result = await createEasyBuyClassifier(decisions).classify(
      [],
      [
        { day: "Mon", slot: "snack1", dish: "missing answer", ingredients: [], drySlot: true },
        { day: "Tue", slot: "snack1", dish: "malformed answer", ingredients: [], drySlot: true },
      ],
    )
    expect(result.unverifiedPackedMeals.map((meal) => meal.dish)).toEqual(["missing answer", "malformed answer"])
  })

  it("asks about ordinary lunchbox travel, independent eating, and preparation needs", async () => {
    let instructions = ""
    const decisions: DecisionsClient = {
      async decide({ questions }) {
        instructions = Object.values(questions)
          .filter((question) => question.type === "noul")
          .map((question) => question.instructions)
          .join(" ")
        return {
          id: "gen-dec",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers: { packed_meal_0: { type: "noul", noul: 0.99 } },
          usage: { inputTokens: 3, outputTokens: 0, costUsd: 0.001 },
        }
      },
    }
    await createEasyBuyClassifier(decisions).classify(
      [],
      [{ day: "Mon", slot: "snack1", dish: "fruit", ingredients: ["banana"], drySlot: true }],
    )
    expect(instructions).toContain("ordinary school lunchbox")
    expect(instructions).toContain("independently edible by hand or ordinary spoon")
    expect(instructions).toContain("no reheating, cooking, assembly, or special equipment")
    expect(instructions).toContain("dry and spill-resistant")
  })

  it("skips the model entirely when no item is unresolved", async () => {
    const decisions = decisionsReturning([])
    const spy = vi.spyOn(decisions, "decide")
    const classifier = createEasyBuyClassifier(decisions)
    const result = await classifier.classify(["dates"])
    expect(spy).not.toHaveBeenCalled()
    expect(result.nonOrdinaryEasyBuys).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
  })
})
