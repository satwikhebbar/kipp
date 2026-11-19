import { describe, expect, it, vi } from "vitest"
import {
  createEvaluateMealPlanTool,
  mealPlanSelectionCandidateFromWire,
  mealPlanSelectionCandidateToWire,
  mealPlanSelectionPatchToWire,
} from "../agent/meal-planning"
import { MEAL_PLANNING_AGENT_PROMPT, runMealPlanningAgentSession } from "../agent/meal-planning-session"
import { loadScenarios } from "../meal-planning/corpus/load"
import { createEasyBuyClassifier } from "../meal-planning/easy-buy-classifier"
import { evaluateMealPlan } from "../meal-planning/evaluation"
import type {
  MealCell,
  MealDefinition,
  MealGrid,
  MealPlanCandidate,
  MealPlanContext,
  MealPlanSelectionCandidate,
} from "../meal-planning/types"
import type { ToolProviderClient } from "../providers"
import { strictToolDeclaration } from "../providers/llm"
import type { DecisionsClient } from "../providers/openrouter-decisions"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SLOT_COOK: Record<string, number> = { breakfast: 15, snack1: 0, snack2: 0, "school-lunch": 20, "home-lunch": 20 }

function fixtureIngredients(dish: string, slot: string): string[] {
  if (dish === "paratha") return slot === "school-lunch" || slot === "home-lunch" ? ["rice"] : ["wheat flour"]
  if (dish === "rice and beans") return ["rice", "beans"]
  if (dish === "paneer paratha") return ["wheat flour", "paneer"]
  if (dish === "banana") return ["banana"]
  return ["rice"]
}

function fixtureDefinition(
  dish: string,
  slot: string,
  items = fixtureIngredients(dish, slot),
  cookMinutes = SLOT_COOK[slot],
): MealDefinition {
  return {
    id: `fixture_${dish.replaceAll(" ", "_")}_${slot}`,
    name: dish,
    principalIngredients: items,
    vegetarian: true,
    suitableSlots: [slot],
    packedFood: { suitable: true, dry: true },
    typicalCookMinutes: cookMinutes,
    priorNightPrep: "none",
    requiredIngredients: items,
    optionalIngredients: [],
    status: "established",
  }
}

const FIXTURE_DEFINITIONS = [
  "paratha",
  "poha",
  "banana",
  "rice and beans",
  "paneer paratha",
  "khichdi",
  "idli",
].flatMap((dish) => Object.keys(SLOT_COOK).map((slot) => fixtureDefinition(dish, slot)))

function selectionCandidate(candidate: MealPlanCandidate): MealPlanSelectionCandidate {
  return {
    ...candidate,
    grid: Object.fromEntries(
      Object.entries(candidate.grid).map(([day, slots]) => [
        day,
        Object.fromEntries(
          Object.entries(slots).map(([slot, cell]) => [
            slot,
            { mealDefinitionId: `fixture_${cell.dish.replaceAll(" ", "_")}_${slot}` },
          ]),
        ),
      ]),
    ),
  }
}

function contextWithCandidateDefinitions(context: MealPlanContext, candidate: MealPlanCandidate): MealPlanContext {
  const definitions = new Map<string, MealDefinition>()
  for (const slots of Object.values(candidate.grid)) {
    for (const [slot, cell] of Object.entries(slots)) {
      const id = `fixture_${cell.dish.replaceAll(" ", "_")}_${slot}`
      if (!definitions.has(id)) {
        definitions.set(id, {
          id,
          name: cell.dish,
          principalIngredients: cell.items,
          vegetarian: true,
          suitableSlots: [slot],
          packedFood: { suitable: true, dry: true },
          typicalCookMinutes: cell.cookMinutes,
          priorNightPrep: cell.priorNightPrep ? "required" : "none",
          requiredIngredients: cell.items,
          optionalIngredients: [],
          status: "established",
        })
      }
    }
  }
  return { ...context, profile: { ...context.profile, mealDefinitions: [...definitions.values()] } }
}

function cell(dish: string, items: string[], slot: string): MealCell {
  return { dish, vegetarian: true, items, cookMinutes: SLOT_COOK[slot], priorNightPrep: false }
}

function gridWith(day: string, slot: string, override: MealCell): MealGrid {
  const grid: MealGrid = {}
  for (const d of DAYS) {
    grid[d] = {}
    for (const s of Object.keys(SLOT_COOK)) {
      grid[d][s] = cell("paratha", s === "school-lunch" || s === "home-lunch" ? ["rice"] : ["wheat flour"], s)
    }
  }
  grid[day][slot] = override
  return grid
}

function passingCandidate(): MealPlanCandidate {
  return {
    grid: gridWith("Mon", "breakfast", cell("paratha", ["wheat flour"], "breakfast")),
    easyBuys: [],
    policyOutcomes: {},
  }
}

function failingCandidate(): MealPlanCandidate {
  return {
    grid: gridWith("Mon", "breakfast", cell("biryani", ["rice"], "breakfast")),
    easyBuys: [],
    policyOutcomes: {},
  }
}

function context(overrides: Partial<MealPlanContext> = {}): MealPlanContext {
  return {
    schedule: {
      days: DAYS,
      slots: [
        { id: "breakfast", name: "Breakfast", packed: false, dry: false, maxCookMinutes: null },
        { id: "snack1", name: "Snack 1", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "snack2", name: "Snack 2", packed: true, dry: true, maxCookMinutes: 0 },
        { id: "school-lunch", name: "School lunch", packed: true, dry: false, maxCookMinutes: null },
        { id: "home-lunch", name: "Home lunch", packed: false, dry: false, maxCookMinutes: null },
      ],
    },
    profile: {
      dietaryExclusions: [],
      dishRepertoire: ["paratha"],
      mealDefinitions: FIXTURE_DEFINITIONS,
      foodPreferences: { favourites: ["paratha"], avoid: [] },
      allowNewFoods: false,
      sensoryGuidelines: [],
      morningCookingBudgetMinutes: 40,
      priorNightPrepAllowed: false,
      pantryBaseline: ["wheat flour", "rice"],
    },
    customPolicies: [],
    weeklyInventory: { items: [], notes: [] },
    weeklyExceptions: { items: [] },
    request: { kind: "initial_plan", text: "plan the week" },
    ...overrides,
  }
}

function providerWith(...responses: Awaited<ReturnType<ToolProviderClient["generate"]>>[]): ToolProviderClient {
  return { generate: vi.fn().mockImplementation(async () => responses.shift()) }
}

function call(id: string, name: string, input: unknown) {
  return { id, name, input }
}

function evaluateResponse(candidate: unknown) {
  return {
    toolCalls: [
      call(
        "evaluate",
        "evaluate_meal_plan",
        mealPlanSelectionCandidateToWire(selectionCandidate(candidate as MealPlanCandidate)),
      ),
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

function evaluatePatchResponse(patch: unknown) {
  return {
    toolCalls: [
      call("evaluate", "evaluate_meal_plan", mealPlanSelectionPatchToWire(patch as MealPlanSelectionCandidate)),
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

function proposeResponse(input: unknown) {
  return { toolCalls: [call("propose", "propose_plan", input)], usage: { inputTokens: 0, outputTokens: 0 } }
}

function clarifyResponse(input: unknown) {
  return { toolCalls: [call("clarify", "needs_clarification", input)], usage: { inputTokens: 0, outputTokens: 0 } }
}

function updateWeekContextResponse(input: unknown) {
  return {
    toolCalls: [call("update-context", "update_week_context", input)],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

function proposeInput(candidate: unknown, feedbackItems?: unknown) {
  return {
    candidate: mealPlanSelectionCandidateToWire(selectionCandidate(candidate as MealPlanCandidate)),
    ...(feedbackItems ? { feedbackItems } : {}),
  }
}

function feedbackDecisions(options: { failFirst?: boolean } = {}): { client: DecisionsClient; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    client: {
      async decide({ questions }) {
        calls += 1
        if (options.failFirst && calls === 1) throw new Error("Decisions endpoint unavailable")
        const question = questions.feedback_0
        const instructions = question?.type === "noul" ? question.instructions : undefined
        const changes =
          instructions && typeof instructions !== "string"
            ? (instructions.beforeAfter as { after: { ingredients: string[] } | null }[])
            : []
        const requestStillViolated = changes.some(({ after }) => after?.ingredients.includes("paneer"))
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "noul" as const, noul: id === "feedback_0" && requestStillViolated ? 0.01 : 0.99 },
            ]),
          ),
          usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.005 },
        }
      },
    },
  }
}

function noPaneerRevision() {
  const base = passingCandidate()
  const candidate = structuredClone(base)
  candidate.grid.Wed["home-lunch"] = cell("paneer paratha", ["wheat flour", "paneer"], "home-lunch")
  const feedback = {
    id: "tg-no-paneer",
    text: "No paneer in Wednesday home lunch",
    target: { kind: "cell" as const, day: "Wed", slot: "home-lunch" },
    scope: { day: "Wed", slot: "home-lunch" },
  }
  const ctx = contextWithCandidateDefinitions(
    context({
      request: { kind: "revision", text: feedback.text },
      feedbackItems: [feedback],
      recentPlan: base.grid,
      feedbackReferencePlan: base.grid,
      profile: { ...context().profile, pantryBaseline: ["wheat flour", "rice", "paneer"] },
    }),
    candidate,
  )
  return { base, candidate, feedback, context: ctx }
}

describe("bounded meal-planning agent session", () => {
  it("accepts propose_plan only when the candidate passes evaluation", async () => {
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate())),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
    if (result.terminal?.kind === "propose_plan") expect(result.terminal.evaluation.pass).toBe(true)
  })

  it.each([0.002, null])("preserves classifier cost availability through a session (%s)", async (costUsd) => {
    const candidate: MealPlanCandidate = {
      ...passingCandidate(),
      grid: gridWith("Mon", "breakfast", cell("paratha", ["dried apricots"], "breakfast")),
    }
    const decisions: DecisionsClient = {
      async decide({ questions }) {
        const answers = Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "noul" as const, noul: id.startsWith("easy_buy_") ? 0.1 : 0.99 },
          ]),
        )
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers,
          usage: { inputTokens: 5, outputTokens: 0, costUsd },
        }
      },
    }
    const provider = providerWith(
      evaluateResponse(candidate),
      clarifyResponse({
        message: "Those are not ordinary groceries; which staples should I add?",
        reasonCodes: ["easy_buy_not_ordinary"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], {
      context: contextWithCandidateDefinitions(context(), candidate),
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["easy_buy_not_ordinary"] })
    expect(result.decisionUsage.costUsd).toBe(costUsd)
  })

  it("classifies a candidate's easy buys once across evaluate and propose", async () => {
    let decideCalls = 0
    const decisions: DecisionsClient = {
      async decide({ questions }) {
        decideCalls += 1
        const answers = Object.fromEntries(
          Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: 0.99 }]),
        )
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers,
          usage: { inputTokens: 5, outputTokens: 0, costUsd: 0.002 },
        }
      },
    }
    const candidate: MealPlanCandidate = {
      ...passingCandidate(),
      grid: gridWith("Mon", "breakfast", cell("paratha", ["ghee"], "breakfast")),
    }
    const provider = providerWith(evaluateResponse(candidate), proposeResponse(proposeInput(candidate)))
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], {
      context: contextWithCandidateDefinitions(context(), candidate),
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
    expect(decideCalls).toBe(1)
    expect(result.decisionUsage.costUsd).toBeCloseTo(0.002)
  })

  it("batches packed-meal checks with easy-buy questions and blocks an unsuitable packed meal", async () => {
    let classifiedQuestions: string[] = []
    const decisions: DecisionsClient = {
      async decide({ questions }) {
        classifiedQuestions = Object.keys(questions)
        const answers = Object.fromEntries(
          classifiedQuestions.map((id) => [id, { type: "noul" as const, noul: id === "packed_meal_0" ? 0.01 : 0.99 }]),
        )
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers,
          usage: { inputTokens: 5, outputTokens: 0, costUsd: 0.002 },
        }
      },
    }
    const candidate = passingCandidate()
    const provider = providerWith(
      evaluateResponse(candidate),
      clarifyResponse({
        message: "Please choose a different packed snack for Monday.",
        reasonCodes: ["packed_slot_semantically_unsuitable"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], {
      context: contextWithCandidateDefinitions(context(), candidate),
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })
    expect(classifiedQuestions).toContain("packed_meal_0")
    expect(classifiedQuestions).toContain("packed_meal_1")
    expect(result.terminal).toMatchObject({
      kind: "needs_clarification",
      reasonCodes: ["packed_slot_semantically_unsuitable"],
    })
    expect(result.decisionUsage.costUsd).toBeCloseTo(0.002)
  })

  it.each([
    "missing-answer",
    "request-failure",
  ] as const)("blocks packed meals when the classifier is unavailable (%s)", async (failureMode) => {
    const decisions: DecisionsClient = {
      async decide() {
        if (failureMode === "request-failure") throw new Error("provider unavailable")
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers: {},
          usage: { inputTokens: 1, outputTokens: 0, costUsd: 0.001 },
        }
      },
    }
    const candidate = passingCandidate()
    const provider = providerWith(
      evaluateResponse(candidate),
      clarifyResponse({
        message: "I could not verify the packed meals. Please choose a different option.",
        reasonCodes: ["packed_slot_unverified"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], {
      context: contextWithCandidateDefinitions(context(), candidate),
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["packed_slot_unverified"] })
    expect(result.decisionUsage.inputTokens).toBe(failureMode === "missing-answer" ? 1 : 0)
  })

  it("truncates an overlong debug justification without rejecting the terminal proposal", async () => {
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse({ ...proposeInput(passingCandidate()), justification: "x".repeat(700) }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.completed).toBe(true)
    if (result.terminal?.kind === "propose_plan") expect(result.terminal.justification).toHaveLength(500)
  })

  it("rejects propose_plan when the candidate fails evaluation", async () => {
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(failingCandidate())),
      clarifyResponse({
        message: "Biryani is not in the repertoire; keep a familiar dish?",
        reasonCodes: ["unknown_meal_definition"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal?.kind).toBe("needs_clarification")
  })

  it.each([
    ["unsuitable", "packed_slot_semantically_unsuitable"],
    ["unverifiable", "packed_slot_unverified"],
  ] as const)("rechecks changed packed-meal evidence at the proposal gate (%s)", async (outcome, expectedFailureCode) => {
    let decisionCalls = 0
    const decisions: DecisionsClient = {
      async decide({ questions }) {
        decisionCalls += 1
        const answers = Object.fromEntries(
          Object.keys(questions)
            .filter((id) => !(decisionCalls === 2 && outcome === "unverifiable" && id === "packed_meal_0"))
            .map((id) => [
              id,
              {
                type: "noul" as const,
                noul: decisionCalls === 2 && outcome === "unsuitable" && id === "packed_meal_0" ? 0.01 : 0.99,
              },
            ]),
        )
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers,
          usage: { inputTokens: 5, outputTokens: 0, costUsd: 0.002 },
        }
      },
    }
    const evaluatedCandidate = passingCandidate()
    const proposedCandidate = {
      ...evaluatedCandidate,
      grid: gridWith("Mon", "snack1", cell("poha", ["rice"], "snack1")),
    }
    const provider = providerWith(
      evaluateResponse(evaluatedCandidate),
      proposeResponse(proposeInput(proposedCandidate)),
      clarifyResponse({
        message: "Please choose a different packed meal that can be verified for this slot.",
        reasonCodes: [],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], {
      context: contextWithCandidateDefinitions(context(), proposedCandidate),
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })

    expect(decisionCalls).toBe(2)
    const proposalToolMessage = result.messages.find(
      (message) => message.role === "tool" && message.name === "propose_plan",
    )
    expect(proposalToolMessage?.role).toBe("tool")
    if (proposalToolMessage?.role === "tool")
      expect(proposalToolMessage.output).toMatchObject({
        ok: false,
        category: "invalid-state",
        rejectionCodes: [expectedFailureCode],
      })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal?.kind).toBe("needs_clarification")
    expect(result.terminal?.kind).not.toBe("propose_plan")
  })

  it.each([
    "supported",
    "unsupported",
  ] as const)("checks whether the plan supports a persistent-policy outcome (%s)", async (claim) => {
    const supported = claim === "supported"
    let decisionCalls = 0
    let policyEvidence: unknown
    const decisions: DecisionsClient = {
      async decide({ questions }) {
        decisionCalls += 1
        const policyQuestion = questions.persistent_policy_0
        let policySupportedFromEvidence = false
        if (policyQuestion?.type === "noul" && typeof policyQuestion.instructions !== "string") {
          policyEvidence = policyQuestion.instructions
          const cells = policyQuestion.instructions.planCells as { slot: string; priorNightPrep: boolean }[]
          policySupportedFromEvidence = cells
            .filter((cell) => cell.slot.startsWith("snack"))
            .every((cell) => !cell.priorNightPrep)
        }
        const answers = Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            {
              type: "noul" as const,
              noul: id === "persistent_policy_0" && !policySupportedFromEvidence ? 0.01 : 0.99,
            },
          ]),
        )
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers,
          usage: { inputTokens: 5, outputTokens: 0, costUsd: 0.002 },
        }
      },
    }
    const policy = {
      id: "snack-policy",
      label: "Quick school snacks",
      scope: "persistent" as const,
      value: "Every school snack requires no prior-night preparation.",
    }
    const candidate = passingCandidate()
    if (!supported) candidate.grid.Mon.snack1.priorNightPrep = true
    candidate.policyOutcomes[policy.id] = {
      outcome: "satisfied",
      rationale: "The planned snacks need no prior-night preparation.",
    }
    const responses = [evaluateResponse(candidate)]
    if (supported) responses.push(proposeResponse(proposeInput(candidate)))
    else {
      responses.push(proposeResponse(proposeInput(candidate)))
      responses.push(
        clarifyResponse({
          message: "Please revise the snack plan to meet the no-prior-prep policy.",
          reasonCodes: ["persistent_policy_outcome_unsubstantiated"],
          interaction: { kind: "reply" },
        }),
      )
    }
    const provider = providerWith(...responses)
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], {
      context: contextWithCandidateDefinitions(
        context({ customPolicies: [policy], profile: { ...context().profile, priorNightPrepAllowed: true } }),
        candidate,
      ),
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })

    expect(decisionCalls).toBe(1)
    expect(policyEvidence).toMatchObject({
      policyId: policy.id,
      policy: policy.value,
      recordedOutcome: "satisfied",
      rationale: "The planned snacks need no prior-night preparation.",
      easyBuys: [],
      planCells: expect.arrayContaining([
        expect.objectContaining({
          day: "Mon",
          slot: "snack1",
          dish: "paratha",
          ingredients: ["wheat flour"],
          cookMinutes: 0,
          priorNightPrep: !supported,
        }),
      ]),
    })
    expect(result.terminal?.kind).toBe(supported ? "propose_plan" : "needs_clarification")
    if (!supported) {
      const evaluationMessage = result.messages.find(
        (message) => message.role === "tool" && message.name === "evaluate_meal_plan",
      )
      if (evaluationMessage?.role === "tool")
        expect(evaluationMessage.output).toMatchObject({
          ok: true,
          output: {
            pass: false,
            failures: [
              expect.objectContaining({
                code: "persistent_policy_outcome_unsubstantiated",
                detail: expect.stringMatching(new RegExp(`${policy.label}.*${policy.id}`)),
              }),
            ],
          },
        })
      const proposalMessage = result.messages.find(
        (message) => message.role === "tool" && message.name === "propose_plan",
      )
      if (proposalMessage?.role === "tool")
        expect(proposalMessage.output).toMatchObject({
          ok: false,
          category: "invalid-state",
          rejectionCodes: ["persistent_policy_outcome_unsubstantiated"],
        })
    }
  })

  it("blocks a proposal when a persistent-policy outcome cannot be verified", async () => {
    let decisionCalls = 0
    const decisions: DecisionsClient = {
      async decide() {
        decisionCalls += 1
        throw new Error("Decisions endpoint unavailable")
      },
    }
    const policy = {
      id: "snack-policy",
      label: "Dry school snacks",
      scope: "persistent" as const,
      value: "Every school snack is dry.",
    }
    const candidate = passingCandidate()
    candidate.policyOutcomes[policy.id] = { outcome: "satisfied", rationale: "The planned snacks are dry." }
    const clarification = clarifyResponse({
      message: "I could not verify the dry-snack policy claim or packed meals. Please review the plan.",
      reasonCodes: ["persistent_policy_outcome_unverified", "packed_slot_unverified"],
      interaction: { kind: "reply" },
    })
    const responses = [evaluateResponse(candidate)]
    const provider: ToolProviderClient = {
      generate: vi.fn().mockImplementation(async () => responses.shift() ?? clarification),
    }
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], {
      context: contextWithCandidateDefinitions(context({ customPolicies: [policy] }), candidate),
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })
    expect(decisionCalls).toBe(1)
    expect(result.terminal).toMatchObject({
      kind: "needs_clarification",
      reasonCodes: ["persistent_policy_outcome_unverified", "packed_slot_unverified"],
    })
    const evaluationMessage = result.messages.find(
      (message) => message.role === "tool" && message.name === "evaluate_meal_plan",
    )
    if (evaluationMessage?.role === "tool")
      expect(evaluationMessage.output).toMatchObject({
        ok: true,
        output: {
          failures: expect.arrayContaining([
            expect.objectContaining({
              code: "persistent_policy_outcome_unverified",
              detail: expect.stringContaining(policy.id),
            }),
          ]),
        },
      })
  })

  it("requires needs_clarification to include every evaluator failure", async () => {
    const provider = providerWith(
      evaluateResponse(failingCandidate()),
      clarifyResponse({
        message: "What should lunch be?",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
      clarifyResponse({
        message: "Keep a familiar dish for the mornings.",
        reasonCodes: ["unknown_meal_definition"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "needs_clarification", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["unknown_meal_definition"] })
  })

  it("allows a targeted clarification with no evaluator failure for vague feedback", async () => {
    const provider = providerWith(
      clarifyResponse({
        message: "What should improve most: speed, nutrition, packing dryness, preference, or inventory use?",
        reasonCodes: [],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "Make this better." }], {
      context: context({
        request: { kind: "revision", text: "Make this better." },
        feedbackItems: [{ id: "tg-vague", text: "Make this better." }],
      }),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: [] })
  })

  it("rejects propose_plan when a revision's raw feedback is left unrepresented", async () => {
    const raw = [{ id: "tg-1", text: "Wed lunch: too oily" }]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate(), [{ id: "tg-other", text: "ignored" }])),
      clarifyResponse({
        message: "Which meal should change?",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "less oily" }], {
      context: context({ request: { kind: "revision", text: "less oily" }, feedbackItems: raw }),
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal?.kind).toBe("needs_clarification")
  })

  it("rejects a scoped revision that changes the cell but still violates authoritative feedback", async () => {
    const { candidate, feedback, context: revisionContext } = noPaneerRevision()
    expect(evaluateMealPlan(candidate, revisionContext).pass).toBe(true)
    const decisions = feedbackDecisions()
    const provider = providerWith(
      evaluateResponse(candidate),
      proposeResponse(proposeInput(candidate, [{ id: feedback.id, text: feedback.text, scope: feedback.scope }])),
      clarifyResponse({
        message: "The Wednesday home lunch still contains paneer. Please choose a paneer-free meal.",
        reasonCodes: ["unaddressed_feedback"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: feedback.text }], {
      context: revisionContext,
      easyBuyClassifier: createEasyBuyClassifier(decisions.client),
    })

    expect(decisions.calls()).toBe(1)
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["unaddressed_feedback"] })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    const proposalMessage = result.messages.find(
      (message) => message.role === "tool" && message.name === "propose_plan",
    )
    if (proposalMessage?.role === "tool")
      expect(proposalMessage.output).toMatchObject({
        ok: false,
        category: "invalid-state",
        rejectionCodes: ["unaddressed_feedback"],
      })
    expect(result.decisionUsage).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.005 })
  })

  it("retries an unavailable feedback classification and accounts for only successful usage", async () => {
    const { candidate, feedback, context: revisionContext } = noPaneerRevision()
    candidate.grid.Wed["home-lunch"] = cell("poha", ["rice"], "home-lunch")
    const decisions = feedbackDecisions({ failFirst: true })
    const provider = providerWith(
      evaluateResponse(candidate),
      proposeResponse(proposeInput(candidate, [{ id: feedback.id, text: feedback.text, scope: feedback.scope }])),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: feedback.text }], {
      context: contextWithCandidateDefinitions(revisionContext, candidate),
      easyBuyClassifier: createEasyBuyClassifier(decisions.client),
    })

    expect(decisions.calls()).toBe(2)
    expect(result.terminal?.kind).toBe("propose_plan")
    expect(result.decisionUsage).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.005 })
    const evaluationMessage = result.messages.find(
      (message) => message.role === "tool" && message.name === "evaluate_meal_plan",
    )
    expect(evaluationMessage?.role).toBe("tool")
    if (evaluationMessage?.role === "tool")
      expect(evaluationMessage.output).toMatchObject({
        ok: true,
        output: { failures: expect.arrayContaining([expect.objectContaining({ code: "feedback_unverified" })]) },
      })
  })

  it("does not reuse a feedback verdict when the scoped before-plan evidence changes", async () => {
    const base = passingCandidate()
    const candidate = structuredClone(base)
    candidate.grid.Wed["home-lunch"] = cell("poha", ["rice"], "home-lunch")
    const feedback = {
      id: "tg-replace-lunch",
      text: "Replace Wednesday home lunch paratha with poha",
      target: { kind: "cell" as const, day: "Wed", slot: "home-lunch" },
      scope: { day: "Wed", slot: "home-lunch" },
    }
    const revisionContext = contextWithCandidateDefinitions(
      context({
        request: { kind: "revision", text: feedback.text },
        feedbackItems: [feedback],
        recentPlan: base.grid,
        feedbackReferencePlan: structuredClone(base.grid),
      }),
      candidate,
    )
    let decisionCalls = 0
    const decisions: DecisionsClient = {
      async decide({ questions }) {
        decisionCalls += 1
        const question = questions.feedback_0
        const instructions = question?.type === "noul" ? question.instructions : undefined
        const changes =
          instructions && typeof instructions !== "string"
            ? (instructions.beforeAfter as { before: { dish: string } | null; after: { dish: string } | null }[])
            : []
        const supported = changes.some(({ before, after }) => before?.dish === "paratha" && after?.dish === "poha")
        return {
          id: "gen",
          model: "openai/gpt-6-luna-decisions",
          provider: "OpenAI",
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "noul" as const, noul: id === "feedback_0" && !supported ? 0.01 : 0.99 },
            ]),
          ),
          usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.005 },
        }
      },
    }
    let providerTurns = 0
    const clarification = clarifyResponse({
      message: "The before-plan changed, so I can no longer verify that request.",
      reasonCodes: ["unaddressed_feedback"],
      interaction: { kind: "reply" },
    })
    const provider: ToolProviderClient = {
      generate: vi.fn().mockImplementation(async () => {
        providerTurns += 1
        if (providerTurns === 1) return evaluateResponse(candidate)
        if (providerTurns === 2) {
          revisionContext.feedbackReferencePlan = structuredClone(candidate.grid)
          return proposeResponse(
            proposeInput(candidate, [{ id: feedback.id, text: feedback.text, scope: feedback.scope }]),
          )
        }
        return clarification
      }),
    }
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: feedback.text }], {
      context: revisionContext,
      easyBuyClassifier: createEasyBuyClassifier(decisions),
    })

    expect(decisionCalls).toBe(2)
    expect(result.terminal?.kind).toBe("needs_clarification")
    expect(result.decisionUsage).toEqual({ inputTokens: 20, outputTokens: 4, costUsd: 0.01 })
  })

  it("rejects propose_plan when a submitted feedback item alters the authoritative item", async () => {
    const raw = [{ id: "tg-1", text: "Wed lunch: too oily" }]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate(), [{ id: "tg-1", text: "rewritten: change dinner" }])),
      clarifyResponse({
        message: "Which meal should change?",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "less oily" }], {
      context: context({ request: { kind: "revision", text: "less oily" }, feedbackItems: raw }),
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal?.kind).toBe("needs_clarification")
  })

  it("rejects a model-added cell scope for authoritative plan-wide feedback", async () => {
    const raw = [{ id: "tg-1", text: "Move Monday lunch to Tuesday", target: { kind: "plan" as const } }]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(
        proposeInput(passingCandidate(), [
          { id: "tg-1", text: raw[0].text, scope: { day: "Mon", slot: "home-lunch" } },
        ]),
      ),
      clarifyResponse({
        message: "Please confirm which lunch should move.",
        reasonCodes: [],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: raw[0].text }], {
      context: context({ request: { kind: "revision", text: raw[0].text }, feedbackItems: raw }),
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification" })
  })

  it("rejects a model that widens an authoritative Mini App cell scope", async () => {
    const raw = [
      {
        id: "mini-1",
        text: "Use poha instead",
        target: { kind: "cell" as const, day: "Mon", slot: "breakfast" },
        scope: { day: "Mon", slot: "breakfast" },
      },
    ]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(
        proposeInput(passingCandidate(), [
          { id: "mini-1", text: raw[0].text, scope: { day: "Tue", slot: "breakfast" } },
        ]),
      ),
      clarifyResponse({
        message: "Please confirm the requested change.",
        reasonCodes: [],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: raw[0].text }], {
      context: context({ request: { kind: "revision", text: raw[0].text }, feedbackItems: raw }),
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification" })
  })

  it("accepts a concrete plan-wide move through both evaluation and proposal", async () => {
    const base = passingCandidate()
    base.grid.Mon["school-lunch"] = cell("tomato rice", ["rice"], "school-lunch")
    base.grid.Mon["home-lunch"] = cell("bhindi fry", ["rice"], "home-lunch")
    base.grid.Tue["school-lunch"] = cell("aloo paratha", ["rice"], "school-lunch")
    base.grid.Tue["home-lunch"] = cell("pumpkin subzi", ["rice"], "home-lunch")
    const candidate = structuredClone(base)
    candidate.grid.Mon["school-lunch"] = cell("aloo paratha", ["rice"], "school-lunch")
    candidate.grid.Mon["home-lunch"] = cell("pumpkin subzi", ["rice"], "home-lunch")
    candidate.grid.Tue["school-lunch"] = cell("tomato rice", ["rice"], "school-lunch")
    candidate.grid.Tue["home-lunch"] = cell("bhindi fry", ["rice"], "home-lunch")
    const feedback = [
      {
        id: "tg-move",
        text: "Replace Monday's lunches with Aloo Paratha and Pumpkin Subzi and move Tomato Rice and Bhindi Fry to Tuesday.",
        target: { kind: "plan" as const },
      },
    ]
    const ctx = contextWithCandidateDefinitions(
      context({
        request: { kind: "revision", text: feedback[0].text },
        recentPlan: base.grid,
        feedbackItems: feedback,
      }),
      candidate,
    )
    const provider = providerWith(
      evaluateResponse(candidate),
      proposeResponse(proposeInput(candidate, [{ id: feedback[0].id, text: feedback[0].text }])),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: feedback[0].text }], {
      context: ctx,
    })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "propose_plan", evaluation: { pass: true } })
    expect(provider.generate).toHaveBeenCalledTimes(2)
  })

  it("accepts a revision propose_plan when every raw feedback item is represented", async () => {
    const raw = [{ id: "tg-1", text: "Wed lunch: too oily" }]
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate(), raw)),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "less oily" }], {
      context: context({ request: { kind: "revision", text: "less oily" }, feedbackItems: raw }),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
    if (result.terminal?.kind === "propose_plan") expect(result.terminal.feedbackItems).toEqual(raw)
  })

  it("accepts a one-cell revision patch without asking the model to reconstruct untouched catalog ids", async () => {
    const base = passingCandidate()
    const raw = [{ id: "tg-1", text: "Use poha on Monday", scope: { day: "Mon", slot: "breakfast" } }]
    const patch = { grid: { Mon: { breakfast: { mealDefinitionId: "fixture_poha_breakfast" } } } }
    const provider = providerWith(
      evaluatePatchResponse(patch),
      proposeResponse({ candidate: mealPlanSelectionPatchToWire(patch) }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: raw[0].text }], {
      context: context({ request: { kind: "revision", text: raw[0].text }, feedbackItems: raw, recentPlan: base.grid }),
      revisionBaseCandidate: base,
    })
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
    if (result.terminal?.kind === "propose_plan") {
      expect(result.terminal.candidate.grid.Mon.breakfast.dish).toBe("poha")
      expect(result.terminal.candidate.grid.Tue.breakfast).toBe(base.grid.Tue.breakfast)
      expect(result.terminal.candidate.easyBuys).toEqual(base.easyBuys)
    }
  })

  it("evaluates a scoped authoritative feedback item even when the model omits it from the submission", async () => {
    const raw = [
      { id: "tg-A", text: "Wed lunch: prefer poha", scope: { day: "Wed", slot: "home-lunch" as const } },
      { id: "tg-B", text: "Wed snack: add banana", scope: { day: "Wed", slot: "snack1" as const } },
    ]
    const recentPlan = gridWith("Wed", "home-lunch", cell("khichdi", ["rice"], "home-lunch"))
    recentPlan.Wed.snack1 = cell("khichdi", ["rice"], "snack1")
    const candidate = gridWith("Wed", "home-lunch", cell("poha", ["rice"], "home-lunch"))
    candidate.Wed.snack1 = cell("banana", ["banana"], "snack1")
    const submission = {
      grid: candidate,
      easyBuys: [] as string[],
      policyOutcomes: { "household-rule": { outcome: "satisfied", rationale: "tg-A tg-B" } },
    }
    // The model submits only B; A is dropped from feedbackItems yet its target
    // cell (Wed home-lunch) is changed and its id appears in a rationale. The
    // evaluator must still see A so that cell change is recognized as scoped.
    const provider = providerWith(evaluateResponse(submission), proposeResponse(proposeInput(submission, [raw[1]])))
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "make these two changes" }], {
      context: context({
        request: { kind: "revision", text: "make these two changes" },
        feedbackItems: raw,
        recentPlan,
        profile: {
          ...context().profile,
          dishRepertoire: ["paratha", "poha", "banana"],
          pantryBaseline: ["wheat flour", "rice", "banana"],
        },
        customPolicies: [{ id: "household-rule", label: "Household rule", scope: "current_week", value: "" }],
      }),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal?.kind).toBe("propose_plan")
  })

  it("never exposes opaque feedback ids in a clarification message", async () => {
    const provider = providerWith(
      clarifyResponse({
        message: "Please confirm the tg-1 request",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
      clarifyResponse({
        message: "Please confirm the Wednesday lunch change",
        reasonCodes: ["missing_slot"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "less oily" }], {
      context: context({
        request: { kind: "revision", text: "less oily" },
        feedbackItems: [{ id: "tg-1", text: "Wed lunch: too oily" }],
      }),
    })
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "needs_clarification", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification" })
  })

  it("requires a terminal tool after a successful evaluation", async () => {
    const provider = providerWith(
      evaluateResponse(passingCandidate()),
      proposeResponse(proposeInput(passingCandidate())),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: "plan" }], { context: context() })
    expect(result.completed).toBe(true)
    expect(result.providerTurns).toBe(2)
    expect(result.toolExecutions).toEqual([
      { tool: "evaluate_meal_plan", outcome: "succeeded" },
      { tool: "propose_plan", outcome: "succeeded" },
    ])
    expect(result.terminal).toMatchObject({ kind: "propose_plan" })
    const generate = vi.mocked(provider.generate)
    expect(generate.mock.calls[1]?.[0].tools.map((tool) => tool.name)).toEqual(["propose_plan", "needs_clarification"])
    const propose = generate.mock.calls[1]?.[0].tools.find((tool) => tool.name === "propose_plan")
    expect(propose && strictToolDeclaration(propose).strict).toBe(true)
    expect(generate.mock.calls[1]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "user", text: expect.stringContaining("Evaluation passed") }),
    )
  })

  it("uses strict, map-free provider contracts while retaining map-shaped candidates internally", () => {
    const declaration = strictToolDeclaration(createEvaluateMealPlanTool(context()))
    expect(declaration.strict).toBe(true)
    const parameters = declaration.parameters as {
      properties: {
        days: { type: string; items: { properties: Record<string, unknown> } }
        policyOutcomes: { type: string }
      }
    }
    expect(parameters.properties.days.type).toBe("array")
    expect(parameters.properties.days.items.properties).toHaveProperty("cells")
    expect(parameters.properties.policyOutcomes.type).toBe("array")

    const internal = selectionCandidate(passingCandidate())
    expect(mealPlanSelectionCandidateToWire(internal).days[0]).toMatchObject({
      day: "Mon",
      cells: expect.arrayContaining([expect.objectContaining({ slot: "breakfast" })]),
    })
  })

  it("rejects duplicate and unknown map keys at the provider boundary", () => {
    const wire = mealPlanSelectionCandidateToWire(selectionCandidate(passingCandidate()))
    const firstDay = wire.days.at(0)
    if (!firstDay) throw new Error("expected fixture days")
    expect(() => mealPlanSelectionCandidateFromWire({ ...wire, days: [...wire.days, firstDay] }, [])).toThrow(
      "duplicate day",
    )
    expect(() =>
      mealPlanSelectionCandidateFromWire(
        { ...wire, policyOutcomes: [{ policyId: "not-in-context", outcome: "satisfied", rationale: "nope" }] },
        [],
      ),
    ).toThrow("unknown policy")
  })

  it("keeps the planning prompt policy-agnostic (no hardcoded custom-policy ids)", () => {
    for (const id of [
      "snack-policy",
      "ingredient-naming",
      "relevant-variety",
      "nutrition-target-fruit",
      "nutrition-target-nuts",
      "school-rule",
      "cheat-day",
    ]) {
      expect(MEAL_PLANNING_AGENT_PROMPT, `${id} must not be hardcoded`).not.toContain(id)
    }
    expect(MEAL_PLANNING_AGENT_PROMPT).toContain("Plans default to healthy, nutritious meals")
  })

  it("uses the authoritative context inventory rather than a terminal echo", async () => {
    const supplied = {
      items: [
        { name: "beans", status: "available" as const },
        { name: "carrots", status: "available" as const },
      ],
      notes: [],
    }
    const ctx = context({
      weeklyInventory: supplied,
      profile: { ...context().profile, dishRepertoire: ["paratha", "rice and beans"] },
      request: { kind: "initial_plan", text: "I have beans, carrots, bottle gourd, peas, bananas and apples." },
    })
    const candidate = {
      ...passingCandidate(),
      grid: gridWith("Mon", "home-lunch", cell("rice and beans", ["rice", "beans"], "home-lunch")),
      easyBuys: ["beans", "carrots"],
    }
    const provider = providerWith(evaluateResponse(candidate), proposeResponse(proposeInput(candidate)))
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: ctx.request.text }], {
      context: ctx,
    })
    expect(result.completed).toBe(true)
    if (result.terminal?.kind === "propose_plan")
      expect(result.terminal.weeklyInventory.items.map((item) => item.name)).toEqual(
        expect.arrayContaining(["beans", "carrots"]),
      )
  })

  it("rejects a proposal that resolves conflicting feedback by violating a hard exclusion", async () => {
    const ctx = context({
      profile: {
        ...context().profile,
        dishRepertoire: ["paratha", "paneer paratha"],
        dietaryExclusions: ["paneer"],
        pantryBaseline: [...context().profile.pantryBaseline, "paneer"],
      },
      request: { kind: "revision", text: "No dairy, but make lunch paneer" },
      feedbackItems: [{ id: "tg-1", text: "Make lunch paneer" }],
    })
    const candidate = {
      ...passingCandidate(),
      grid: gridWith("Mon", "school-lunch", cell("paneer paratha", ["wheat flour", "paneer"], "school-lunch")),
    }
    const provider = providerWith(
      evaluateResponse(candidate),
      proposeResponse(proposeInput(candidate, ctx.feedbackItems)),
      clarifyResponse({
        message: "Paneer is excluded this week — should lunch stay dairy-free?",
        reasonCodes: ["hard_exclusion"],
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: ctx.request.text }], {
      context: ctx,
    })
    expect(result.completed).toBe(true)
    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({ tool: "propose_plan", outcome: "failed", failureCategory: "invalid-state" }),
    )
    expect(result.terminal).toMatchObject({ kind: "needs_clarification", reasonCodes: ["hard_exclusion"] })
  })

  it("accepts a revision that declares a mid-week holiday and drops that day without a missing_slot", async () => {
    const ctx = context({
      request: { kind: "revision", text: "Tomorrow is a holiday" },
      weeklyExceptions: { items: [{ kind: "school_closed", appliesTo: { day: "Wed" }, instruction: "Holiday" }] },
    })
    const grid: MealGrid = {}
    for (const day of DAYS) {
      if (day === "Wed") continue
      grid[day] = {}
      for (const slot of Object.keys(SLOT_COOK)) {
        grid[day][slot] = cell(
          "paratha",
          slot === "school-lunch" || slot === "home-lunch" ? ["rice"] : ["wheat flour"],
          slot,
        )
      }
    }
    const candidate = { grid, easyBuys: [], policyOutcomes: {} }
    const provider = providerWith(evaluateResponse(candidate), proposeResponse(proposeInput(candidate)))
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: ctx.request.text }], {
      context: ctx,
    })
    expect(result.completed).toBe(true)
    if (result.terminal?.kind === "propose_plan")
      expect(result.terminal.evaluation.failures.filter((failure) => failure.day === "Wed")).toEqual([])
  })

  it("accepts a holiday-only week-context update without requiring a meal candidate", async () => {
    const ctx = context({ request: { kind: "revision", text: "Tomorrow is a holiday." } })
    const provider = providerWith(
      updateWeekContextResponse({
        inventoryChanges: [],
        exceptionAdds: [{ kind: "school_closed", appliesTo: { day: "Wed" }, instruction: "Tomorrow is a holiday." }],
        replan: false,
      }),
    )
    const result = await runMealPlanningAgentSession(provider, [{ role: "user", text: ctx.request.text }], {
      context: ctx,
      revisionBaseCandidate: passingCandidate(),
    })
    expect(result.completed).toBe(true)
    expect(result.terminal).toMatchObject({
      kind: "update_week_context",
      update: { replan: false, weeklyExceptions: { items: [{ kind: "school_closed", appliesTo: { day: "Wed" } }] } },
    })
    expect(result.toolNames).toEqual(["update_week_context"])
  })
})

describe("corpus-driven planning loop", () => {
  const scenarios = loadScenarios()

  it.each(
    scenarios.map((scenario) => [scenario.id, scenario] as const),
  )("accepts every passing candidate of %s", async (_id, scenario) => {
    for (const candidate of scenario.candidates.filter((entry) => entry.expect.pass)) {
      const provider = providerWith(
        evaluateResponse(candidate.plan),
        proposeResponse(proposeInput(candidate.plan, scenario.context.feedbackItems)),
      )
      const result = await runMealPlanningAgentSession(
        provider,
        [{ role: "user", text: scenario.context.request.text }],
        { context: contextWithCandidateDefinitions(scenario.context, candidate.plan) },
      )
      expect(result.completed, `${scenario.id}/${candidate.label}`).toBe(true)
      expect(result.terminal?.kind, `${scenario.id}/${candidate.label}`).toBe("propose_plan")
      if (result.terminal?.kind === "propose_plan")
        expect(result.terminal.evaluation.pass, `${scenario.id}/${candidate.label}`).toBe(true)
    }
  })

  it.each(
    scenarios
      .filter((scenario) => scenario.behavior?.expectsClarification)
      .map((scenario) => [scenario.id, scenario] as const),
  )("ends a clarification scenario in needs_clarification with the expected policy outcomes", async (_id, scenario) => {
    const driving = scenario.candidates.find((candidate) => !candidate.expect.pass) ?? scenario.candidates[0]
    if (!driving) throw new Error(`${scenario.id} has no candidate to drive a clarification`)
    const evaluation = evaluateMealPlan(driving.plan, scenario.context)
    const reasonCodes = [...new Set(evaluation.failures.map((failure) => failure.code))]
    if (reasonCodes.length === 0)
      throw new Error(`${scenario.id} needs a failing candidate to drive needs_clarification`)
    const provider = providerWith(
      evaluateResponse(driving.plan),
      clarifyResponse({
        message: "Please clarify before I finalize the plan.",
        reasonCodes,
        interaction: { kind: "reply" },
      }),
    )
    const result = await runMealPlanningAgentSession(
      provider,
      [{ role: "user", text: scenario.context.request.text }],
      { context: contextWithCandidateDefinitions(scenario.context, driving.plan) },
    )
    expect(result.terminal?.kind, scenario.id).toBe("needs_clarification")
    if (result.terminal?.kind === "needs_clarification")
      expect(result.terminal.reasonCodes, scenario.id).toEqual(reasonCodes)
    for (const [key, value] of Object.entries(scenario.behavior?.expectedPolicyOutcomes ?? {})) {
      expect(driving.plan.policyOutcomes[key]?.outcome, `${scenario.id} policy ${key}`).toBe(value)
    }
  })
})
