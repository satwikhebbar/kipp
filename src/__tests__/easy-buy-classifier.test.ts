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

  it("honors a caller threshold override", async () => {
    const classifier = createEasyBuyClassifier(decisionsReturning([0.7]), { threshold: 0.6 })
    const result = await classifier.classify(["curd"])
    expect(result.nonOrdinaryEasyBuys).toEqual([])
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
