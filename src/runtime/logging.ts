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
  failureCategory?: string
  metrics?: Readonly<Record<string, number | boolean>>
  /** Safe, non-payload labels that identify a state transition or validation boundary. */
  details?: Readonly<Record<string, string | number | boolean>>
}

/** Emits metadata only; callers must never attach user/provider payloads. */
export function logRuntime(env: Pick<Env, "LOG_LEVEL">, fields: RuntimeLogFields): void {
  if (env.LOG_LEVEL !== LOG_LEVEL.INFO) return
  console.log(JSON.stringify({ component: "kipp-runtime", ...fields }))
}
