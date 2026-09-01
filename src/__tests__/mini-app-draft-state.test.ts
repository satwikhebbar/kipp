import { describe, expect, it } from "vitest"
import { addLocalFeedbackDraft, readLocalFeedbackBatch } from "../meal-planning/mini-app/draft-state"

describe("Mini App local feedback batch", () => {
  it("keeps one idempotency key when a 202 response is lost and the drafts retry", () => {
    const initial = addLocalFeedbackDraft(
      { drafts: [], idempotencyKey: null },
      { target: { kind: "plan" }, text: "Fewer new dishes" },
      () => "batch-key-1",
    )
    const reloaded = readLocalFeedbackBatch(JSON.stringify(initial))
    expect(reloaded.idempotencyKey).toBe("batch-key-1")
    expect(reloaded.drafts).toEqual(initial.drafts)
  })
})
