import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { type CoverageSet, computeCoverageSet, resolveSlotId } from "../coverage"
import type { MealPlanScenario } from "../types"
import { mealPlanScenarioSchema } from "./schema"

export { type CoverageSet, computeCoverageSet }

export interface ScenarioIssue {
  path: string
  message: string
}

export class ScenarioValidationError extends Error {
  readonly issues: ScenarioIssue[]

  constructor(issues: ScenarioIssue[]) {
    super(
      `scenario validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues[0]?.message ?? ""}`,
    )
    this.name = "ScenarioValidationError"
    this.issues = issues
  }
}

/** Structural self-consistency checks for a parsed scenario, including exact-token and coverage-set validation. */
export function validateScenarioStructure(scenario: MealPlanScenario): ScenarioIssue[] {
  const issues: ScenarioIssue[] = []
  const { schedule, weeklyExceptions, request } = scenario.context
  const days = new Set(schedule.days)
  const slotIds = new Set(schedule.slots.map((slot) => slot.id))

  for (const candidate of scenario.candidates) {
    for (const day of Object.keys(candidate.plan.grid)) {
      if (!days.has(day)) {
        issues.push({
          path: `candidates[${candidate.label}].grid.${day}`,
          message: `day "${day}" is not one of the configured days ${JSON.stringify(schedule.days)}`,
        })
      }
      for (const slotId of Object.keys(candidate.plan.grid[day] ?? {})) {
        if (!slotIds.has(slotId)) {
          issues.push({
            path: `candidates[${candidate.label}].grid.${day}.${slotId}`,
            message: `slot "${slotId}" is not one of the configured slot ids ${JSON.stringify(schedule.slots.map((slot) => slot.id))}`,
          })
        }
      }
    }
  }

  const policyIds = new Set(scenario.context.customPolicies.map((policy) => policy.id))
  if (policyIds.size !== scenario.context.customPolicies.length) {
    issues.push({ path: "context.customPolicies", message: "custom policy ids must be unique" })
  }

  for (let index = 0; index < weeklyExceptions.items.length; index += 1) {
    const exception = weeklyExceptions.items[index] as (typeof weeklyExceptions.items)[number]
    const path = `context.weeklyExceptions.items[${index}]`
    const day = exception.appliesTo?.day
    if (day && !days.has(day)) {
      issues.push({ path: `${path}.appliesTo.day`, message: `day "${day}" is not a configured day` })
    }
    for (const entry of exception.appliesTo?.mealSlots ?? []) {
      if (!resolveSlotId(entry, schedule.slots)) {
        issues.push({
          path: `${path}.appliesTo.mealSlots`,
          message: `meal slot "${entry}" matches no configured slot id or name`,
        })
      }
    }
  }

  if (request.kind === "revision" && !scenario.context.recentPlan) {
    issues.push({ path: "context.recentPlan", message: "revision scenarios must reference a recentPlan" })
  }

  if (
    scenario.context.requireUrgentUseEarly &&
    scenario.context.urgentUseByDay &&
    !days.has(scenario.context.urgentUseByDay)
  ) {
    issues.push({
      path: "context.urgentUseByDay",
      message: `urgentUseByDay "${scenario.context.urgentUseByDay}" is not a configured day`,
    })
  }

  const closedDays = new Set(
    weeklyExceptions.items
      .filter((exception) => exception.kind === "school_closed" && exception.appliesTo?.day)
      .map((exception) => exception.appliesTo?.day as string),
  )
  for (let index = 0; index < weeklyExceptions.items.length; index += 1) {
    const exception = weeklyExceptions.items[index] as (typeof weeklyExceptions.items)[number]
    const day = exception.appliesTo?.day
    if (exception.kind === "half_day" && day && closedDays.has(day)) {
      issues.push({
        path: `context.weeklyExceptions.items[${index}]`,
        message: `day "${day}" cannot be both school_closed and half_day`,
      })
    }
  }

  return issues
}

/** Parses and structurally validates one scenario fixture. Throws ScenarioValidationError on any problem. */
export function parseScenario(input: unknown): MealPlanScenario {
  let scenario: MealPlanScenario
  try {
    scenario = mealPlanScenarioSchema.parse(input)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ScenarioValidationError(
        error.issues.map((issue) => ({ path: issue.path.join(".") || "$", message: issue.message })),
      )
    }
    throw error
  }
  const issues = validateScenarioStructure(scenario)
  if (issues.length) throw new ScenarioValidationError(issues)
  return scenario
}

/** Loads and validates every `scenarios/*.json` fixture, sorted deterministically by id. */
export function loadScenarios(
  dirPath = join(dirname(fileURLToPath(import.meta.url)), "scenarios"),
): MealPlanScenario[] {
  let files: string[]
  try {
    files = readdirSync(dirPath)
  } catch (error) {
    // Only the not-yet-created scenarios directory is a legitimate empty corpus.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        return parseScenario(JSON.parse(readFileSync(join(dirPath, file), "utf8")))
      } catch (error) {
        if (error instanceof ScenarioValidationError) {
          throw new ScenarioValidationError(
            error.issues.map((issue) => ({ path: `${file}:${issue.path}`, message: issue.message })),
          )
        }
        throw new Error(`failed to load scenario fixture ${file}`, { cause: error })
      }
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
