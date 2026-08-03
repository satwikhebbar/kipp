import { describe, expect, it } from "vitest"
import { persistableCalendarMessages } from "../agent/calendar-transcript"

describe("persisted Calendar agent transcripts", () => {
  it("drops reasoning and compacts obsolete event lists to metadata", () => {
    const result = persistableCalendarMessages([
      {
        role: "assistant",
        toolCalls: [{ id: "first", name: "list_calendar_events", input: {} }],
        reasoningContent: "private reasoning",
      },
      {
        role: "tool",
        toolCallId: "first",
        name: "list_calendar_events",
        output: { ok: true, output: { events: [{ title: "Private title" }], truncated: true } },
      },
      {
        role: "tool",
        toolCallId: "second",
        name: "list_calendar_events",
        output: { ok: true, output: { events: [{ title: "Current title" }], truncated: false } },
      },
    ])

    expect(result[0]).not.toHaveProperty("reasoningContent")
    expect(result[1]).toEqual({
      role: "tool",
      toolCallId: "first",
      name: "list_calendar_events",
      output: { ok: true, output: { compacted: true, eventCount: 1, truncated: true } },
    })
    expect(result[2]).toMatchObject({
      output: { ok: true, output: { events: [{ title: "Current title" }] } },
    })
  })
})
