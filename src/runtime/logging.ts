import type { Env } from "../core/types"

export const LOG_LEVEL = {
  INFO: "info",
} as const

/** JSON-safe diagnostic metadata; callers must allowlist fields before logging. */
export type RuntimeLogDetail =
  | string
  | number
  | boolean
  | readonly RuntimeLogDetail[]
  | { readonly [key: string]: RuntimeLogDetail | undefined }

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
  details?: Readonly<Record<string, RuntimeLogDetail>>
}

/** Emits metadata only; callers must never attach user/provider payloads. */
export function logRuntime(env: Pick<Env, "LOG_LEVEL">, fields: RuntimeLogFields): void {
  if (env.LOG_LEVEL !== LOG_LEVEL.INFO) return
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), component: "kipp-runtime", ...fields }))
}
