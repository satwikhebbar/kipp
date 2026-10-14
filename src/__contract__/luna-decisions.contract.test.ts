import { describe, expect, it } from "vitest"
import { createEasyBuyClassifier } from "../meal-planning/easy-buy-classifier"
import { createOpenRouterDecisionsClient } from "../providers/openrouter-decisions"

declare const process: { env: Record<string, string | undefined> }

const apiKey = process.env.OPENROUTER_API_KEY ?? ""
const enabled = (process.env.DECISIONS_CONTRACT === "1" || process.env.LIVE_CONTRACT === "1") && Boolean(apiKey)
const CONTRACT_TIMEOUT_MS = 120_000
const contractIt = enabled
  ? (name: string, fn: () => void | Promise<void>) => it(name, fn, CONTRACT_TIMEOUT_MS)
  : (name: string) => it.skip(name, () => {})

const MODEL = process.env.DECISIONS_MODEL ?? "openai/gpt-6-luna-decisions"
const REFUND_PROBABILITY_FLOOR = 0.5

/** Live contract for the OpenRouter Decisions endpoint (`/api/alpha/decisions`). */
describe("OpenRouter Decisions live contract", () => {
  contractIt("answers noul, choice, and score questions in one request", async () => {
    const client = createOpenRouterDecisionsClient(apiKey, MODEL)
    const result = await client.decide({
      state: { ticket: "I was charged twice for order A-4471; please refund the duplicate payment." },
      questions: {
        is_refund: { type: "noul", instructions: "Is the customer asking for money back?" },
        team: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { billing: "Payments and refunds.", technical: "Bugs.", other: "None of these." },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this ticket?",
          criteria: ["Can wait", "This week", "Blocking revenue now"],
        },
      },
    })
    expect(result.answers.is_refund.type).toBe("noul")
    if (result.answers.is_refund.type === "noul")
      expect(result.answers.is_refund.noul).toBeGreaterThan(REFUND_PROBABILITY_FLOOR)
    expect(result.answers.team.type).toBe("choice")
    expect(result.answers.urgency.type).toBe("score")
    expect(result.usage.costUsd).toBeGreaterThan(0)
  })

  contractIt("classifies an ordinary staple and a dried fruit in one batched call", async () => {
    const classifier = createEasyBuyClassifier(createOpenRouterDecisionsClient(apiKey, MODEL))
    const { nonOrdinaryEasyBuys, usage } = await classifier.classify(["carrot", "dried apricots", "spinach"])
    const flagged = nonOrdinaryEasyBuys.map((entry) => entry.item)
    expect(flagged).toContain("dried apricots")
    expect(flagged).not.toContain("carrot")
    expect(usage.costUsd).toBeGreaterThan(0)
  })
})
