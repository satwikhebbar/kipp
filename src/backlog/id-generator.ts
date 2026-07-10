import type { Idea } from "../types"

export function nextId(ideas: Idea[]): number {
  const max = ideas.reduce((m, i) => Math.max(m, Number(i.id)), 0)
  return max + 1
}
