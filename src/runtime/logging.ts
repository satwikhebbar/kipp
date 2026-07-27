import type { Env } from "../types"

export const LOG_LEVEL = {
  INFO: "info",
} as const

export type RuntimeLogFields = {
  workflow?: string
  sessionId?: string
  interactionId?: string
  event?: string
  tool?: string
  outcome: "started" | "succeeded" | "failed" | "ignored" | "not-configured"
  durationMs?: number
  retryCount?: number
}

/** Emits metadata only; callers must never attach user/provider payloads. */
export function logRuntime(env: Pick<Env, "LOG_LEVEL">, fields: RuntimeLogFields): void {
  if (env.LOG_LEVEL !== LOG_LEVEL.INFO) return
  console.log(JSON.stringify({ component: "kipp-runtime", ...fields }))
}
