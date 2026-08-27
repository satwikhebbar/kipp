import { describe, expect, it } from "vitest"
import { coerceSubmission } from "../meal-planning/submissions"

describe("coerceSubmission", () => {
  it("wraps a force-reply text into the canonical one-item unbound submission", () => {
    expect(coerceSubmission("Wed lunch: too oily", "telegram-reply", 42)).toEqual({
      items: [{ id: "tg-42", text: "Wed lunch: too oily" }],
    })
  })

  it("uses the same tg-<messageId> id for the plain-text fallthrough source", () => {
    expect(coerceSubmission("more fruit", "telegram-text", 7)).toEqual({
      items: [{ id: "tg-7", text: "more fruit" }],
    })
  })
})
