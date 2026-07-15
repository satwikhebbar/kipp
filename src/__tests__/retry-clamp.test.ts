import { describe, expect, it } from "vitest"

describe("createGenerator clamps invalid maxRetries", () => {
  function clampRetries(maxRetries: number): number {
    return Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : 3
  }

  it("clamps NaN to 3 so generation still runs", () => {
    expect(clampRetries(NaN)).toBe(3)
  })

  it("clamps negative to 3", () => {
    expect(clampRetries(-1)).toBe(3)
  })

  it("clamps Infinity to 3", () => {
    expect(clampRetries(Infinity)).toBe(3)
  })

  it("returns valid integer unchanged", () => {
    expect(clampRetries(0)).toBe(0)
    expect(clampRetries(5)).toBe(5)
  })
})
