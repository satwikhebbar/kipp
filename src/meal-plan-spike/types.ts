/** A meal shown in the throwaway weekly-plan prototype. */
export interface MockMeal {
  id: string
  label: string
  detail: string
  revised?: boolean
  feedbackText?: string
}

/** A single day in the throwaway weekly-plan prototype. */
export interface MockDay {
  id: string
  label: string
  meals: MockMeal[]
}

/** The versioned, mock weekly plan returned to the Mini App. */
export interface MockPlan {
  id: string
  version: number
  days: MockDay[]
}

/** A submitted feedback record retained only for the current Worker process. */
export interface MockFeedback {
  id: string
  dayId: string
  mealId: string
  text: string
  baseVersion: number
  resultingVersion: number
  submittedAt: string
}

/** The short-lived server-side session associated with signed Telegram data. */
export interface MiniAppSession {
  token: string
  userId: string
  householdId: string
  expiresAt: number
}
