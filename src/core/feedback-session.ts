const DEFAULT_WAIT_FOR_FEEDBACK_HOURS = 12
const HOURS_TO_MS = 3_600_000
const SECONDS_TO_MS = 1_000
const MAX_FEEDBACK_SESSION_DURATION_MS = 42_300_000 // eleven hours and forty-five minutes

/** Applies Kipp's existing feedback-session cap of eleven hours and forty-five minutes. */
export function resolveFeedbackDeadline(startedAtMs: number, configuredHours: string | undefined): number {
  const requestedHours = Number(configuredHours || DEFAULT_WAIT_FOR_FEEDBACK_HOURS)
  const requestedDurationMs = Number.isFinite(requestedHours) && requestedHours > 0 ? requestedHours * HOURS_TO_MS : 0
  const sessionDurationMs = Math.min(
    requestedDurationMs || MAX_FEEDBACK_SESSION_DURATION_MS,
    MAX_FEEDBACK_SESSION_DURATION_MS,
  )
  return startedAtMs + sessionDurationMs
}

/** Returns a whole-second Workflow duration that does not extend past the deadline. */
export function remainingFeedbackTimeoutSeconds(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.floor((deadlineMs - nowMs) / SECONDS_TO_MS))
}
