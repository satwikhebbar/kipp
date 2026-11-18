import { describe, expect, it, vi } from "vitest"
import { continueScopedRevision, withCorpusCatalog } from "../__contract__/helpers/meal-planning-context"
import type { MealPlanningTerminalOutcome } from "../agent/meal-planning-session"
import { loadScenarios } from "../meal-planning/corpus/load"
import { evaluateMealPlanSelection } from "../meal-planning/evaluation"
import type { MealPlanContext, MealPlanSelectionCandidate } from "../meal-planning/types"

describe("live meal-planning context", () => {
  it("keeps the corpus household's complete repertoire selectable without relaxing evaluator rules", () => {
    const scenario = loadScenarios().find((entry) => entry.id === "baseline-week")
    if (!scenario) throw new Error("missing baseline-week")
    const reference = scenario.candidates.find((candidate) => candidate.expect.pass)?.plan
    if (!reference) throw new Error("missing passing baseline")
    const context = withCorpusCatalog(scenario)
    const definitions = context.profile.mealDefinitions ?? []
    expect(context.profile.allowNewFoods).toBe(false)
    expect(context.profile.foodPreferences).toEqual(scenario.context.profile.foodPreferences)
    expect(context.weeklyInventory).toEqual(scenario.context.weeklyInventory)
    expect(definitions.map((entry) => entry.name).sort()).toEqual([...context.profile.dishRepertoire].sort())
    const selection: MealPlanSelectionCandidate = {
      ...reference,
      grid: Object.fromEntries(
        Object.entries(reference.grid).map(([day, slots]) => [
          day,
          Object.fromEntries(
            Object.entries(slots).map(([slot, cell]) => {
              const definition = definitions.find((entry) => entry.name === cell.dish)
              if (!definition) throw new Error(`missing definition for ${cell.dish}`)
              return [slot, { mealDefinitionId: definition.id }]
            }),
          ),
        ]),
      ),
    }
    const result = evaluateMealPlanSelection(selection, context)
    expect(result.evaluation.failures).toEqual([])
    expect(result.evaluation.pass).toBe(true)
    expect(result.candidate?.grid).toEqual(reference.grid)
  })

  it("continues a scoped swap after applying an inventory update even when replan is false", async () => {
    const context = loadScenarios().find((entry) => entry.id === "midweek-shortage")?.context
    if (!context) throw new Error("missing midweek-shortage")
    const result = {
      terminal: {
        kind: "update_week_context",
        update: {
          weeklyInventory: { items: [{ name: "paneer", status: "unavailable" }], notes: [] },
          weeklyExceptions: context.weeklyExceptions,
          replan: false,
        },
      } as MealPlanningTerminalOutcome,
    }
    const final = { terminal: null as MealPlanningTerminalOutcome | null }
    const runUpdatedSession = vi.fn(async (_updated: MealPlanContext) => final)
    expect(
      await continueScopedRevision<{ terminal: MealPlanningTerminalOutcome | null }>(
        context,
        result,
        runUpdatedSession,
      ),
    ).toBe(final)
    expect(runUpdatedSession).toHaveBeenCalledOnce()
    const updated = runUpdatedSession.mock.calls[0][0]
    expect(updated.weeklyInventory.items).toEqual([{ name: "paneer", status: "unavailable" }])
    expect(updated.recentPlan).toBe(context.recentPlan)
    expect(updated.feedbackItems).toEqual(context.feedbackItems)
    expect(updated.request.text).toContain("swap Friday's school lunch")
    expect(updated.request.text).toContain("already applied")
    expect(updated.request.text).not.toContain("fb-paneer")
  })

  it("preserves a standalone context-only terminal without inventing a replan", async () => {
    const context = loadScenarios().find((entry) => entry.id === "midweek-shortage")?.context
    if (!context) throw new Error("missing midweek-shortage")
    const result = {
      terminal: {
        kind: "update_week_context",
        update: { weeklyInventory: context.weeklyInventory, weeklyExceptions: context.weeklyExceptions, replan: false },
      } as MealPlanningTerminalOutcome,
    }
    const runUpdatedSession = vi.fn()
    expect(await continueScopedRevision({ ...context, feedbackItems: [] }, result, runUpdatedSession)).toBe(result)
    expect(runUpdatedSession).not.toHaveBeenCalled()
  })
})
