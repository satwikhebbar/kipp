import type { BusyInterval } from "../integrations/google-calendar"
import { type CalendarPlan, type CalendarPlanLedger, issueCalendarOptions, issueCalendarPlan } from "./plan"
import {
  evaluateRecurrenceAvailability,
  expandRecurrence,
  type RecurringProposal,
  validateRecurringProposalIssues,
} from "./recurrence"
import {
  calendarDayBounds,
  type OneOffProposal,
  scheduleOneOff,
  suggestOneOffAlternative,
  validateProposalIssues,
} from "./scheduling"
import type { CalendarValidationIssue } from "./validation"

export type CalendarCandidate =
  | { kind: "one_off"; proposal: OneOffProposal }
  | { kind: "recurring"; proposal: RecurringProposal }

export type CalendarEvaluation =
  | { kind: "needs_input"; issues: CalendarValidationIssue[] }
  | {
      kind: "choice_required"
      issues: CalendarValidationIssue[]
      options: Array<{
        optionId: string
        kind: "one_off_alternative" | "recurring_adjustments" | "recurring_common_time"
        localStartTime?: string
        adjustedDates?: Array<{ localDate: string; localStartTime: string }>
      }>
    }
  | {
      kind: "ready"
      planId: string
      facts: { candidateKind: CalendarCandidate["kind"]; occurrenceCount: number; localStartTime: string }
    }

export interface CalendarEvaluationContext {
  getBusyIntervals(timeMin: string, timeMax: string): Promise<BusyInterval[]>
  ledger: CalendarPlanLedger
  version: number
  expiresAt: number
  timeZone: string
  now?: number
}

/** Evaluates one strict Calendar candidate and stores only authorized plans or choices in workflow-owned state. */
export async function evaluateCalendarCandidate(
  candidate: CalendarCandidate,
  context: CalendarEvaluationContext,
): Promise<CalendarEvaluation> {
  return candidate.kind === "one_off"
    ? evaluateOneOffCandidate(candidate.proposal, context)
    : evaluateRecurringCandidate(candidate.proposal, context)
}

/** Runs the one-off policy and availability pipeline without authoring user-facing prose. */
async function evaluateOneOffCandidate(
  proposal: OneOffProposal,
  context: CalendarEvaluationContext,
): Promise<CalendarEvaluation> {
  const issues = validateProposalIssues(proposal)
  if (issues.length) return { kind: "needs_input", issues }
  const bounds = calendarDayBounds(proposal.localDate as string, context.timeZone)
  if (!bounds) return { kind: "needs_input", issues: [{ code: "missing_date", field: "localDate" }] }
  const busy = await context.getBusyIntervals(bounds.timeMin, bounds.timeMax)
  const scheduled = scheduleOneOff(proposal, busy, context.timeZone, context.now)
  if ("clarification" in scheduled)
    return { kind: "needs_input", issues: [{ code: "missing_or_invalid_time", field: "startTime" }] }
  if ("conflict" in scheduled) {
    const alternative = suggestOneOffAlternative(proposal, busy, context.timeZone, context.now)
    if (!alternative) return noAvailableTime()
    const optionIds = issueCalendarOptions(
      context.ledger,
      [{ kind: "one_off", proposal, scheduled: alternative }],
      context.version,
      context.expiresAt,
    )
    return {
      kind: "choice_required",
      issues: [{ code: "requested_time_conflicts", field: "startTime" }],
      options: [
        { optionId: optionIds[0] as string, kind: "one_off_alternative", localStartTime: alternative.localStartTime },
      ],
    }
  }
  return ready(
    context,
    { kind: "one_off", proposal, scheduled },
    { candidateKind: "one_off", occurrenceCount: 1, localStartTime: scheduled.localStartTime },
  )
}

/** Runs bounded recurrence expansion and whole-series availability evaluation. */
async function evaluateRecurringCandidate(
  proposal: RecurringProposal,
  context: CalendarEvaluationContext,
): Promise<CalendarEvaluation> {
  const issues = validateRecurringProposalIssues(proposal)
  if (issues.length) return { kind: "needs_input", issues }
  const expanded = expandRecurrence(proposal)
  if ("clarification" in expanded)
    return { kind: "needs_input", issues: [{ code: "invalid_first_date", field: "firstDate" }] }
  const firstBounds = calendarDayBounds(expanded.dates[0] as string, context.timeZone)
  const lastBounds = calendarDayBounds(expanded.dates.at(-1) as string, context.timeZone)
  if (!firstBounds || !lastBounds)
    return { kind: "needs_input", issues: [{ code: "invalid_first_date", field: "firstDate" }] }
  const busy = await context.getBusyIntervals(firstBounds.timeMin, lastBounds.timeMax)
  const availability = evaluateRecurrenceAvailability(proposal, busy, context.timeZone, context.now)
  if (availability.kind === "clarification")
    return { kind: "needs_input", issues: [{ code: "event_crosses_local_day", field: "startTime" }] }
  if (availability.kind === "conflict") return noAvailableTime()
  if (availability.kind === "available") {
    const plan: CalendarPlan = {
      kind: "recurring",
      proposal,
      occurrences: availability.occurrences,
      adjustments: [],
      rrule: availability.rrule,
      humanCadence: availability.humanCadence,
      reminderMinutes: availability.reminderMinutes,
    }
    return ready(context, plan, {
      candidateKind: "recurring",
      occurrenceCount: availability.occurrences.length,
      localStartTime: availability.occurrences[0]?.localStartTime ?? proposal.startTime ?? "",
    })
  }
  const adjustedProposal =
    availability.kind === "common-alternative"
      ? { ...proposal, startTime: availability.localStartTime, timeIsExplicit: true }
      : proposal
  const optionPlan: CalendarPlan = {
    kind: "recurring",
    proposal: adjustedProposal,
    occurrences: availability.occurrences,
    adjustments: availability.kind === "adjustments" ? availability.adjustments : [],
    rrule: availability.rrule,
    humanCadence: availability.humanCadence,
    reminderMinutes: availability.reminderMinutes,
  }
  const [optionId] = issueCalendarOptions(context.ledger, [optionPlan], context.version, context.expiresAt)
  return {
    kind: "choice_required",
    issues: [{ code: "requested_time_conflicts", field: "startTime" }],
    options: [
      availability.kind === "adjustments"
        ? {
            optionId: optionId as string,
            kind: "recurring_adjustments",
            adjustedDates: availability.adjustments.map((adjustment) => ({
              localDate: adjustment.localDate,
              localStartTime: adjustment.scheduled.localStartTime,
            })),
          }
        : {
            optionId: optionId as string,
            kind: "recurring_common_time",
            localStartTime: availability.localStartTime,
          },
    ],
  }
}

/** Issues one ready plan and returns only the opaque authorization ID plus safe facts. */
function ready(
  context: CalendarEvaluationContext,
  plan: CalendarPlan,
  facts: Extract<CalendarEvaluation, { kind: "ready" }>["facts"],
): CalendarEvaluation {
  return {
    kind: "ready",
    planId: issueCalendarPlan(context.ledger, plan, context.version, context.expiresAt),
    facts,
  }
}

/** Returns the typed no-candidate outcome shared by one-off and recurring evaluation. */
function noAvailableTime(): CalendarEvaluation {
  return { kind: "needs_input", issues: [{ code: "no_available_time", field: "startTime" }] }
}
