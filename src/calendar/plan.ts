import type { RecurrenceAdjustment, RecurringOccurrence, RecurringProposal } from "./recurrence"
import type { OneOffProposal, ScheduledOneOff } from "./scheduling"

export type CalendarPlan =
  | {
      kind: "one_off"
      proposal: OneOffProposal
      scheduled: ScheduledOneOff
    }
  | {
      kind: "recurring"
      proposal: RecurringProposal
      occurrences: RecurringOccurrence[]
      adjustments: RecurrenceAdjustment[]
      rrule: string
      humanCadence: string
      reminderMinutes: number
    }

type CalendarPlanStatus = "issued" | "used" | "superseded"

export interface CalendarPlanRecord {
  id: string
  version: number
  expiresAt: number
  status: CalendarPlanStatus
  plan: CalendarPlan
}

export interface CalendarPlanLedger {
  records: CalendarPlanRecord[]
  options: CalendarPlanRecord[]
}

export type CalendarPlanRejection = "forged" | "stale" | "reused" | "expired" | "superseded"
export type CalendarPlanAuthorization = { ok: true; plan: CalendarPlan } | { ok: false; reason: CalendarPlanRejection }

/** Creates serializable workflow-owned storage for evaluated Calendar plans. */
export function createCalendarPlanLedger(): CalendarPlanLedger {
  return { records: [], options: [] }
}

/** Issues one opaque plan and supersedes any prior unconsumed plan in the same workflow state. */
export function issueCalendarPlan(
  ledger: CalendarPlanLedger,
  plan: CalendarPlan,
  version: number,
  expiresAt: number,
  id = crypto.randomUUID(),
): string {
  for (const record of ledger.records) if (record.status === "issued") record.status = "superseded"
  ledger.records.push({ id, version, expiresAt, status: "issued", plan })
  return id
}

/** Issues one authorized choice set while invalidating choices from prior evaluations. */
export function issueCalendarOptions(
  ledger: CalendarPlanLedger,
  plans: CalendarPlan[],
  version: number,
  expiresAt: number,
  ids = plans.map(() => crypto.randomUUID()),
): string[] {
  for (const record of ledger.options) if (record.status === "issued") record.status = "superseded"
  plans.forEach((plan, index) => {
    const id = ids[index]
    if (!id) throw new Error("Calendar option ID count does not match plan count")
    ledger.options.push({ id, version, expiresAt, status: "issued", plan })
  })
  return ids
}

/** Consumes one authorized option and supersedes its sibling choices. */
export function consumeCalendarOption(
  ledger: CalendarPlanLedger,
  id: string,
  version: number,
  now = Date.now(),
): CalendarPlanAuthorization {
  const record = ledger.options.find((candidate) => candidate.id === id)
  if (!record) return { ok: false, reason: "forged" }
  const authorization = authorizeRecord(record, version, now)
  if (!authorization.ok) return authorization
  record.status = "used"
  for (const sibling of ledger.options)
    if (sibling !== record && sibling.status === "issued") sibling.status = "superseded"
  return authorization
}

/** Resolves and consumes an authorized plan exactly once at the expected interaction version. */
export function consumeCalendarPlan(
  ledger: CalendarPlanLedger,
  id: string,
  version: number,
  now = Date.now(),
): CalendarPlanAuthorization {
  const record = ledger.records.find((candidate) => candidate.id === id)
  if (!record) return { ok: false, reason: "forged" }
  const authorization = authorizeRecord(record, version, now)
  if (!authorization.ok) return authorization
  record.status = "used"
  return authorization
}

/** Checks that a plan belongs to the current session without consuming its write authorization. */
export function inspectCalendarPlan(
  ledger: CalendarPlanLedger,
  id: string,
  version: number,
  now = Date.now(),
): CalendarPlanAuthorization {
  return authorizeRecord(
    ledger.records.find((candidate) => candidate.id === id),
    version,
    now,
  )
}

/** Checks that an option belongs to the current interaction without consuming its authorization. */
export function inspectCalendarOption(
  ledger: CalendarPlanLedger,
  id: string,
  version: number,
  now = Date.now(),
): CalendarPlanAuthorization {
  return authorizeRecord(
    ledger.options.find((candidate) => candidate.id === id),
    version,
    now,
  )
}

/** Applies the shared opaque-ID lifecycle checks without mutating a record. */
function authorizeRecord(
  record: CalendarPlanRecord | undefined,
  version: number,
  now: number,
): CalendarPlanAuthorization {
  if (!record) return { ok: false, reason: "forged" }
  if (record.version !== version) return { ok: false, reason: "stale" }
  if (record.status === "used") return { ok: false, reason: "reused" }
  if (record.status === "superseded") return { ok: false, reason: "superseded" }
  if (record.expiresAt <= now) return { ok: false, reason: "expired" }
  return { ok: true, plan: record.plan }
}
