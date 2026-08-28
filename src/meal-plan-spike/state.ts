import type { MiniAppSession, MockDay, MockFeedback, MockPlan } from "./types"

const SESSION_TTL_MINUTES = 15
const SECONDS_PER_MINUTE = 60
const MILLISECONDS_PER_SECOND = 1_000
const SESSION_TTL_MS = SESSION_TTL_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND
const MOCK_HOUSEHOLD_ID = "mock-household-1"
const UNAUTHORIZED_HOUSEHOLD_ID = "mock-household-2"

const INITIAL_DAYS: MockDay[] = [
  {
    id: "mon",
    label: "Monday",
    meals: [
      { id: "lunch", label: "Lunch", detail: "Tomato pasta with peas" },
      { id: "dinner", label: "Dinner", detail: "Chicken traybake with carrots" },
    ],
  },
  {
    id: "tue",
    label: "Tuesday",
    meals: [
      { id: "lunch", label: "Lunch", detail: "Cheese and bean quesadillas" },
      { id: "dinner", label: "Dinner", detail: "Salmon rice bowls" },
    ],
  },
  {
    id: "wed",
    label: "Wednesday",
    meals: [
      { id: "lunch", label: "Lunch", detail: "Pesto gnocchi with greens" },
      { id: "dinner", label: "Dinner", detail: "Turkey chilli and rice" },
    ],
  },
  {
    id: "thu",
    label: "Thursday",
    meals: [
      { id: "lunch", label: "Lunch", detail: "Hummus wraps with cucumber" },
      { id: "dinner", label: "Dinner", detail: "Vegetable stir-fry noodles" },
    ],
  },
  {
    id: "fri",
    label: "Friday",
    meals: [
      { id: "lunch", label: "Lunch", detail: "Tuna jacket potatoes" },
      { id: "dinner", label: "Dinner", detail: "Homemade pizza night" },
    ],
  },
  {
    id: "sat",
    label: "Saturday",
    meals: [
      { id: "lunch", label: "Lunch", detail: "Picnic sandwiches and fruit" },
      { id: "dinner", label: "Dinner", detail: "Lentil dhal with flatbreads" },
    ],
  },
]

/** Holds all intentionally ephemeral data for one local Worker process. */
export class MealPlanSpikeState {
  private readonly sessions = new Map<string, MiniAppSession>()
  private readonly usedInitData = new Set<string>()
  private readonly idempotentResponses = new Map<string, { feedback: MockFeedback[]; plan: MockPlan }>()
  private plan: MockPlan = { id: "mock-week-2026-08-24", version: 1, days: structuredClone(INITIAL_DAYS) }

  /** Returns the mock household owner, favouring the configured development user. */
  authorizedUserId(configuredUserId: string): string {
    return configuredUserId.trim() || "1001"
  }

  /** Returns the mock plan for a household, without exposing an unauthorized fixture. */
  readPlan(householdId: string): MockPlan | null {
    if (householdId !== MOCK_HOUSEHOLD_ID) return null
    return structuredClone(this.plan)
  }

  /** Allocates a short-lived session after a signed Telegram launch is verified. */
  createSession(userId: string, now: number): MiniAppSession {
    this.removeExpiredSessions(now)
    const session: MiniAppSession = {
      token: crypto.randomUUID(),
      userId,
      householdId: MOCK_HOUSEHOLD_ID,
      expiresAt: now + SESSION_TTL_MS,
    }
    this.sessions.set(session.token, session)
    return session
  }

  /** Reads a valid session and removes it when it has expired. */
  readSession(token: string, now: number): MiniAppSession | null {
    const session = this.sessions.get(token)
    if (!session) return null
    if (session.expiresAt <= now) {
      this.sessions.delete(token)
      return null
    }
    return session
  }

  /** Records a raw signed launch value as consumed, rejecting exact replays. */
  consumeInitData(fingerprint: string): boolean {
    if (this.usedInitData.has(fingerprint)) return false
    this.usedInitData.add(fingerprint)
    return true
  }

  /** Returns the non-owner fixture identifier used by authorization tests. */
  unauthorizedHouseholdId(): string {
    return UNAUTHORIZED_HOUSEHOLD_ID
  }

  /** Stores one whole feedback batch for the mock agent without revising the active plan. */
  submitFeedbackBatch(input: {
    householdId: string
    feedback: Array<{ dayId: string; mealId: string; text: string }>
    baseVersion: number
    idempotencyKey: string
    now: number
  }):
    | { kind: "saved"; feedback: MockFeedback[]; plan: MockPlan; duplicate: boolean }
    | { kind: "conflict"; plan: MockPlan }
    | { kind: "invalid" } {
    if (input.householdId !== MOCK_HOUSEHOLD_ID) return { kind: "invalid" }
    const previous = this.idempotentResponses.get(input.idempotencyKey)
    if (previous) return structuredClone({ kind: "saved" as const, ...previous, duplicate: true })
    if (input.baseVersion !== this.plan.version) return { kind: "conflict", plan: structuredClone(this.plan) }

    const targets = input.feedback.map(({ dayId, mealId }) => {
      const day = this.plan.days.find((candidate) => candidate.id === dayId)
      return { dayId, mealId, meal: day?.meals.find((candidate) => candidate.id === mealId) }
    })
    if (targets.some((target) => !target.meal)) return { kind: "invalid" }

    const feedback = targets.map((target, index) => {
      const source = input.feedback[index]
      return {
        id: crypto.randomUUID(),
        dayId: target.dayId,
        mealId: target.mealId,
        text: source.text,
        baseVersion: input.baseVersion,
        resultingVersion: this.plan.version,
        submittedAt: new Date(input.now).toISOString(),
      }
    })
    const result = { feedback, plan: structuredClone(this.plan) }
    this.idempotentResponses.set(input.idempotencyKey, result)
    return structuredClone({ kind: "saved" as const, ...result, duplicate: false })
  }

  /** Clears expired sessions to keep ephemeral development state bounded. */
  private removeExpiredSessions(now: number): void {
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token)
  }
}

let state = new MealPlanSpikeState()

/** Returns the single ephemeral state instance for this Worker process. */
export function getMealPlanSpikeState(): MealPlanSpikeState {
  return state
}

/** Resets prototype state for isolated automated tests. */
export function resetMealPlanSpikeForTests(): void {
  state = new MealPlanSpikeState()
}
