export const CALENDAR_ISSUE_CODES = [
  "ambiguous_request",
  "missing_information",
  "unsupported_recurrence",
  "missing_date",
  "invalid_first_date",
  "invalid_end_date",
  "end_before_first",
  "horizon_exceeded",
  "invalid_occurrence_count",
  "occurrence_count_exceeds_horizon",
  "missing_weekday",
  "first_date_weekday_mismatch",
  "invalid_title",
  "invalid_duration_range",
  "invalid_duration_increment",
  "missing_or_invalid_time",
  "inferred_duration_requires_time",
  "family_social_requires_time",
  "event_crosses_local_day",
  "requested_time_conflicts",
  "no_available_time",
] as const

export type CalendarIssueCode = (typeof CALENDAR_ISSUE_CODES)[number]

export type CalendarIssueField =
  | "title"
  | "localDate"
  | "firstDate"
  | "startTime"
  | "durationMinutes"
  | "recurrence"
  | "recurrence.weekdays"
  | "end"

export interface CalendarValidationIssue {
  code: CalendarIssueCode
  field: CalendarIssueField
  params?: Readonly<Record<string, number | string>>
}

/** Temporary compatibility renderer while Calendar dialogue moves into the bounded agent. */
export function legacyCalendarIssueMessage(issue: CalendarValidationIssue): string {
  switch (issue.code) {
    case "ambiguous_request":
    case "missing_information":
      return "Please tell me the missing scheduling details."
    case "unsupported_recurrence":
      return "Please choose a supported recurrence."
    case "missing_date":
      return "Please tell me the date."
    case "invalid_first_date":
      return "Please tell me a valid first date."
    case "invalid_end_date":
      return "Please tell me a valid inclusive recurrence end date."
    case "end_before_first":
      return "The recurrence end date cannot be before its first occurrence."
    case "horizon_exceeded":
      return "Recurring blocks can run for at most six calendar months."
    case "invalid_occurrence_count":
      return "Please give me a positive number of occurrences."
    case "occurrence_count_exceeds_horizon":
      return "That occurrence count would run beyond the six-month maximum."
    case "missing_weekday":
      return "Please name at least one weekday."
    case "first_date_weekday_mismatch":
      return "The first date must fall on one of the selected weekdays."
    case "invalid_title":
      return "I need a short title for this calendar block."
    case "invalid_duration_range":
      return "Please give me a duration between 15 minutes and 4 hours."
    case "invalid_duration_increment":
      return "Please use a duration in 15-minute increments."
    case "missing_or_invalid_time":
      return "Please tell me a valid time."
    case "inferred_duration_requires_time":
      return "Please tell me what time works for this longer block."
    case "family_social_requires_time":
      return "Please tell me what time works for this family or social plan."
    case "event_crosses_local_day":
      return "Please choose a time that finishes on the same day."
    case "requested_time_conflicts":
      return "The requested time conflicts with another calendar event."
    case "no_available_time":
      return "I couldn't find a safe time for that calendar block."
  }
}
