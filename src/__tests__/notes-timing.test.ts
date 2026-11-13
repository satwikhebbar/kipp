import { expect, it } from "vitest"
import { notePublicationMessage } from "../notes/publication"
import { fingerprintCommand } from "../notes/review"
import {
  formatNoteInstant,
  isNoteTimingFuture,
  type NoteTiming,
  noteApprovalLabel,
  noteTimingLabel,
  publicationTimingSchema,
  resolveNoteTiming,
  timingInstructionSchema,
} from "../notes/timing"
import type { ApprovedPublication } from "../notes/types"

const receipt = Date.parse("2026-11-12T18:00:00Z") // 23:30 IST
const now = receipt
const schedule = (date: string, time = "09:00", timeZone: string | null = null) =>
  timingInstructionSchema.parse({
    kind: "schedule",
    date: { kind: "absolute", localDate: date },
    localTime: time,
    timeZone,
  })

it.each([
  ["2026-11-12T18:00:00Z", 180, "Asia/Kolkata", "2026-11-12T21:00:00.000Z", "2026-11-13 02:30 Asia/Kolkata"],
  ["2026-12-31T23:45:00Z", 30, "UTC", "2027-01-01T00:15:00.000Z", "2027-01-01 00:15 UTC"],
  ["2026-03-08T06:30:00Z", 60, "America/New_York", "2026-03-08T07:30:00.000Z", "2026-03-08 03:30 America/New_York"],
  ["2026-11-01T05:30:00Z", 60, "America/New_York", "2026-11-01T06:30:00.000Z", "2026-11-01 01:30 America/New_York"],
  ["2026-03-07T14:00:00Z", 1440, "America/New_York", "2026-03-08T14:00:00.000Z", "2026-03-08 10:00 America/New_York"],
  [
    "2026-10-03T15:15:00Z",
    60,
    "Australia/Lord_Howe",
    "2026-10-03T16:15:00.000Z",
    "2026-10-04 03:15 Australia/Lord_Howe",
  ],
])("adds elapsed minutes from %s across civil and DST boundaries", (start, minutes, zone, dueAt, display) => {
  const received = Date.parse(start)
  const input = timingInstructionSchema.parse({ kind: "relative-duration", minutes })
  const expected = { kind: "ready", timing: { kind: "schedule", dueAt, timeZone: zone } }
  expect(resolveNoteTiming(input, null, received, zone, received)).toEqual(expected)
  expect(resolveNoteTiming(input, null, received, zone, received + 1000)).toEqual(expected)
  expect(formatNoteInstant(dueAt, zone)).toBe(display)
})

it("anchors new relative instructions to the supplied receipt and preserves resolved schedules on prose edits", () => {
  const input = timingInstructionSchema.parse({ kind: "relative-duration", minutes: 90, timeZone: "UTC" })
  const original = { kind: "schedule" as const, dueAt: "2030-01-01T00:00:00.000Z", timeZone: "UTC" }
  const result = resolveNoteTiming(input, original, receipt, "Asia/Kolkata", now)
  expect(result).toEqual({
    kind: "ready",
    timing: { kind: "schedule", dueAt: "2026-11-12T19:30:00.000Z", timeZone: "UTC" },
  })
  if (result.kind !== "ready") throw new Error("Expected schedule")
  expect(resolveNoteTiming({ kind: "unchanged" }, result.timing, receipt + 60_000, "UTC", now)).toEqual(result)
  expect(resolveNoteTiming(input, null, receipt, "UTC", receipt + 90 * 60_000).kind).toBe("clarification")
  expect(resolveNoteTiming(input, null, Number.NaN, "UTC", now).kind).toBe("clarification")
  expect(resolveNoteTiming(input, null, 8.64e15, "UTC", now).kind).toBe("clarification")
  expect(
    resolveNoteTiming(
      timingInstructionSchema.parse({ kind: "relative-duration", minutes: 5 }),
      null,
      receipt,
      null,
      now,
    ).kind,
  ).toBe("clarification")
})

it.each([
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  36500 * 24 * 60 + 1,
])("rejects invalid elapsed minutes %s", (minutes) => {
  expect(timingInstructionSchema.safeParse({ kind: "relative-duration", minutes }).success).toBe(false)
})

it("defaults to immediate, preserves a queue/schedule on prose edits, and changes mode explicitly", () => {
  expect(resolveNoteTiming({ kind: "unchanged" }, null, receipt, null, now)).toEqual({
    kind: "ready",
    timing: { kind: "now" },
  })
  for (const current of [
    { kind: "queue" } as const,
    { kind: "schedule", dueAt: "2026-11-14T03:30:00.000Z", timeZone: "Asia/Kolkata" } as const,
  ])
    expect(resolveNoteTiming({ kind: "unchanged" }, current, receipt, null, now)).toEqual({
      kind: "ready",
      timing: current,
    })
  expect(resolveNoteTiming({ kind: "now" }, { kind: "queue" }, receipt, null, now)).toEqual({
    kind: "ready",
    timing: { kind: "now" },
  })
  expect(resolveNoteTiming({ kind: "queue" }, null, receipt, null, now)).toEqual({
    kind: "ready",
    timing: { kind: "queue" },
  })
})

it("resolves tomorrow from the persisted source receipt, across midnight and later replay", () => {
  const input = timingInstructionSchema.parse({
    kind: "schedule",
    date: { kind: "relative-days", days: 1 },
    localTime: "09:00",
    timeZone: null,
  })
  const expected = {
    kind: "ready",
    timing: { kind: "schedule", dueAt: "2026-11-13T03:30:00.000Z", timeZone: "Asia/Kolkata" },
  }
  expect(resolveNoteTiming(input, null, receipt, "Asia/Kolkata", now)).toEqual(expected)
  expect(resolveNoteTiming(input, null, receipt, "Asia/Kolkata", now + 3_600_000)).toEqual(expected)
})

it("honors an explicit zone before the default and adds civil days across DST", () => {
  expect(resolveNoteTiming(schedule("2026-11-14", "09:00", "UTC"), null, receipt, "Asia/Kolkata", now)).toMatchObject({
    timing: { dueAt: "2026-11-14T09:00:00.000Z", timeZone: "UTC" },
  })
  const input = timingInstructionSchema.parse({
    kind: "schedule",
    date: { kind: "relative-days", days: 1 },
    localTime: "09:00",
    timeZone: "America/New_York",
  })
  expect(
    resolveNoteTiming(input, null, Date.parse("2026-03-07T14:00:00Z"), null, Date.parse("2026-03-07T14:00:00Z")),
  ).toMatchObject({ timing: { dueAt: "2026-03-08T13:00:00.000Z" } })
})

it.each([
  ["2027-03-14", "02:30", "America/New_York", "does not exist"],
  ["2027-11-07", "01:30", "America/New_York", "occurs twice"],
  ["2027-10-03", "02:15", "Australia/Lord_Howe", "does not exist"],
  ["2027-04-04", "01:45", "Australia/Lord_Howe", "occurs twice"],
  ["2027-02-30", "12:00", "UTC", "valid posting date"],
  ["2027-01-01", "25:00", "UTC", "valid posting date"],
  ["2027-01-01", "12:00", "IST", "Which timezone"],
  ["2027-01-01", "12:00", "Not/AZone", "Which timezone"],
  ["2027-01-01", "12:00", "+05:30", "Which timezone"],
])("clarifies invalid or ambiguous %s %s %s", (date, time, zone, question) => {
  expect(resolveNoteTiming(schedule(date, time, zone), null, receipt, "Asia/Kolkata", now)).toMatchObject({
    kind: "clarification",
    question: expect.stringContaining(question),
  })
})

it("requires a zone for exact scheduling and never converts past times to immediate", () => {
  expect(resolveNoteTiming(schedule("2026-11-14"), null, receipt, null, now).kind).toBe("clarification")
  expect(resolveNoteTiming(schedule("2026-11-12", "12:00", "UTC"), null, receipt, null, now).kind).toBe("clarification")
  const past: NoteTiming = { kind: "schedule", dueAt: new Date(now).toISOString(), timeZone: "UTC" }
  expect(resolveNoteTiming({ kind: "unchanged" }, past, receipt, "UTC", now).kind).toBe("clarification")
  expect(isNoteTimingFuture(past, now)).toBe(false)
  expect(isNoteTimingFuture({ kind: "queue" }, now)).toBe(true)
})

it("represents vague/conflicting timing as clarification and rejects mixed queue/schedule fields", () => {
  expect(
    resolveNoteTiming({ kind: "clarify", question: "Queue it or use an exact time?" }, null, receipt, null, now),
  ).toEqual({ kind: "clarification", question: "Queue it or use an exact time?" })
  for (const mixed of [
    { kind: "queue", dueAt: "2030-01-01T00:00:00.000Z" },
    { kind: "queue", date: "tomorrow" },
    { kind: "now", timeZone: "UTC" },
  ]) {
    expect(publicationTimingSchema.safeParse(mixed).success).toBe(false)
    expect(timingInstructionSchema.safeParse(mixed).success).toBe(false)
  }
  expect(
    publicationTimingSchema.safeParse({ kind: "schedule", dueAt: "2030-02-30T00:00:00.000Z", timeZone: "UTC" }).success,
  ).toBe(false)
})

it("shows explicit labels and reports only the queue time Buffer actually returned", () => {
  expect(noteApprovalLabel({ kind: "queue" })).toBe("Add to queue")
  expect(noteApprovalLabel({ kind: "now" })).toBe("Publish")
  expect(noteApprovalLabel({ kind: "schedule", dueAt: "2030-01-01T13:30:00.000Z", timeZone: "Asia/Kolkata" })).toBe(
    "Schedule",
  )
  expect(noteTimingLabel({ kind: "queue" })).toContain("next available slot")
  expect(formatNoteInstant("2030-01-01T13:30:00.000Z", null)).toBe("2030-01-01 13:30 UTC")
  const approved = { command: { timing: { kind: "queue" } } } as ApprovedPublication
  expect(
    notePublicationMessage(
      { kind: "accepted", postId: "p", dueAt: "2030-01-01T13:30:00.000Z" },
      approved,
      "Asia/Kolkata",
    ),
  ).toBe("Added to your Buffer queue.\nScheduled for 2030-01-01 19:00 Asia/Kolkata.")
  expect(notePublicationMessage({ kind: "accepted", postId: "p" }, approved, null)).toBe("Added to your Buffer queue.")
})

it("binds queue intent and exact UTC schedule to the approval fingerprint", async () => {
  const command = {
    destination: {
      accountId: "a",
      connectionId: "c",
      organizationId: "o",
      channelId: "ch",
      service: "substack" as const,
    },
    text: "Note",
    attachmentUrl: null,
    timing: { kind: "now" as const },
  }
  const original = await fingerprintCommand(command)
  expect(await fingerprintCommand({ ...command, timing: { kind: "queue" } })).not.toBe(original)
  const scheduled = {
    ...command,
    timing: { kind: "schedule" as const, dueAt: "2030-01-01T13:30:00.000Z", timeZone: "UTC" },
  }
  expect(await fingerprintCommand(scheduled)).not.toBe(original)
  expect(
    await fingerprintCommand({ ...scheduled, timing: { ...scheduled.timing, dueAt: "2030-01-01T14:30:00.000Z" } }),
  ).not.toBe(await fingerprintCommand(scheduled))
})

it("accepts the equivalent Etc/UTC zone without changing the scheduled instant", () => {
  expect(
    resolveNoteTiming(schedule("2030-01-01", "09:00", "Etc/UTC"), null, receipt, "Asia/Kolkata", now),
  ).toMatchObject({ kind: "ready", timing: { dueAt: "2030-01-01T09:00:00.000Z" } })
})
