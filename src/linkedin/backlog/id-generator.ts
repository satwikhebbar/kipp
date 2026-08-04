import type { Idea } from "../../core/types"

/** Returns one greater than the largest numeric idea ID. */
export function nextId(ideas: Idea[]): number {
  const max = ideas.reduce((m, i) => Math.max(m, Number(i.id)), 0)
  return max + 1
}
