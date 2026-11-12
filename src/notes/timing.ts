import { z } from "zod"
import { addCivilDays, isValidTimeZone, localDateAt, localTimeAt, resolveLocalDateTime } from "../core/time"

const MAX_QUESTION_CHARACTERS = 1500
const MAX_RELATIVE_DAYS = 36500
const instantSchema = z
  .string()
  .datetime()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
export const publicationTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("now") }).strict(),
  z.object({ kind: z.literal("queue") }).strict(),
  z
    .object({ kind: z.literal("schedule"), dueAt: instantSchema, timeZone: z.string().refine(isValidTimeZone) })
    .strict(),
])
export type NoteTiming = z.infer<typeof publicationTimingSchema>
export const timingInstructionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchanged") }).strict(),
  z.object({ kind: z.literal("now") }).strict(),
  z.object({ kind: z.literal("queue") }).strict(),
  z.object({ kind: z.literal("clarify"), question: z.string().trim().min(1).max(MAX_QUESTION_CHARACTERS) }).strict(),
  z
    .object({
      kind: z.literal("schedule"),
      date: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("absolute"), localDate: z.string() }).strict(),
        z
          .object({
            kind: z.literal("relative-days"),
            days: z.number().int().min(-MAX_RELATIVE_DAYS).max(MAX_RELATIVE_DAYS),
          })
          .strict(),
      ]),
      localTime: z.string(),
      timeZone: z.string().nullable().default(null),
      source: z.enum(["initial", "current"]).default("current"),
    })
    .strict(),
])
export type TimingInstruction = z.infer<typeof timingInstructionSchema>
export type TimingResolution = { kind: "ready"; timing: NoteTiming } | { kind: "clarification"; question: string }

/** Resolves the writer's proposal against the source receipt, without normalizing DST gaps or overlaps. */
export function resolveNoteTiming(
  instruction: TimingInstruction,
  current: NoteTiming | null,
  receivedAtMs: number,
  defaultZone: string | null,
  now = Date.now(),
): TimingResolution {
  if (instruction.kind === "clarify") return { kind: "clarification", question: instruction.question }
  if (instruction.kind === "unchanged") {
    const timing = current ?? { kind: "now" as const }
    return isNoteTimingFuture(timing, now)
      ? { kind: "ready", timing }
      : {
          kind: "clarification",
          question: "The approved posting time has passed. What future date, time and timezone should I use?",
        }
  }
  if (instruction.kind !== "schedule") return { kind: "ready", timing: instruction }
  const zone = instruction.timeZone ?? defaultZone
  if (!zone || !isValidTimeZone(zone) || (zone !== "UTC" && !zone.includes("/")))
    return {
      kind: "clarification",
      question: "Which timezone should I use? Please give an IANA timezone such as Asia/Kolkata or UTC.",
    }
  if (!Number.isFinite(receivedAtMs))
    return { kind: "clarification", question: "Please give an explicit future date and time." }
  const date =
    instruction.date.kind === "absolute"
      ? instruction.date.localDate
      : addCivilDays(localDateAt(receivedAtMs, zone), instruction.date.days)
  const resolved = date ? resolveLocalDateTime(date, instruction.localTime, zone) : { kind: "invalid" as const }
  if (resolved.kind !== "unique")
    return {
      kind: "clarification",
      question:
        resolved.kind === "ambiguous"
          ? `That time occurs twice in ${zone}. Please choose a different local time or give the intended date and time in UTC.`
          : resolved.kind === "nonexistent"
            ? `That local time does not exist in ${zone} because the clocks change. Which valid time should I use?`
            : "Please give a valid posting date and time in HH:mm format.",
    }
  const timing: NoteTiming = { kind: "schedule", dueAt: new Date(resolved.epochMs).toISOString(), timeZone: zone }
  return isNoteTimingFuture(timing, now)
    ? { kind: "ready", timing }
    : { kind: "clarification", question: "That posting time has passed. What future date and time should I use?" }
}

/** Exact schedules must remain future at review, approval, retry and dispatch. */
export function isNoteTimingFuture(timing: NoteTiming, now = Date.now()): boolean {
  return timing.kind !== "schedule" || Date.parse(timing.dueAt) > now
}

/** Renders an explicit civil date, time and timezone; missing configuration falls back to UTC. */
export function formatNoteInstant(instant: string, zone: string | null): string {
  const timeZone = zone && isValidTimeZone(zone) ? zone : "UTC"
  return `${localDateAt(Date.parse(instant), timeZone)} ${localTimeAt(Date.parse(instant), timeZone)} ${timeZone}`
}

/** Describes approved timing without guessing which queue slot Buffer will assign. */
export function noteTimingLabel(timing: NoteTiming): string {
  if (timing.kind === "queue") return "Timing: next available slot in your Buffer queue."
  if (timing.kind === "schedule") return `Timing: ${formatNoteInstant(timing.dueAt, timing.timeZone)}.`
  return "Timing: publish immediately after approval."
}

/** The current timing mode determines the explicit approval button label. */
export function noteApprovalLabel(timing: NoteTiming): string {
  return timing.kind === "queue" ? "Add to queue" : timing.kind === "schedule" ? "Schedule" : "Publish"
}
