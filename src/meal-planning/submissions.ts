import type { FeedbackItem } from "./types"

/** The canonical feedback submission payload shared by the Telegram producers and the iteration-2 mini-app. */
export interface Submission {
  items: FeedbackItem[]
}

/** Producers that reach the workflow through Telegram text; the mini-app (iteration 2) bypasses coercion. */
export type SubmissionSource = "telegram-reply" | "telegram-text"

/**
 * Coerces one Telegram text message into the canonical one-item submission
 * payload (`{ items: [{ id: "tg-<messageId>", text }] }`, unbound). Pure and
 * deterministic — everything downstream (session context, `propose_plan`
 * coverage validation, the `feedback_batch` row) consumes only this shape, so
 * iteration 2 swaps the Telegram producer for the mini-app's structured
 * `feedback-submit` without any pipeline change.
 */
export function coerceSubmission(text: string, source: SubmissionSource, messageId: number): Submission {
  const prefix = source.startsWith("telegram") ? "tg" : source
  return { items: [{ id: `${prefix}-${messageId}`, text }] }
}
