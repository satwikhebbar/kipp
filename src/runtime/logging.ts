export type RuntimeLogFields = {
  workflow?: string
  sessionId?: string
  interactionId?: string
  event?: string
  tool?: string
  outcome: "started" | "succeeded" | "failed" | "ignored"
  durationMs?: number
  retryCount?: number
}

/** Emits metadata only; callers must never attach user/provider payloads. */
export function logRuntime(fields: RuntimeLogFields): void {
  console.log(JSON.stringify({ component: "kipp-runtime", ...fields }))
}
