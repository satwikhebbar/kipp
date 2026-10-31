import type { WorkflowStep } from "cloudflare:workers"

export type WorkflowWaitResult<T> = { type: "event"; payload: T } | { type: "timeout"; payload?: undefined }

/** Converts only the runtime's event-wait timeout into an explicit application outcome. */
export async function waitForWorkflowEvent<T>(
  step: WorkflowStep,
  name: string,
  options: Parameters<WorkflowStep["waitForEvent"]>[1],
): Promise<WorkflowWaitResult<T>> {
  try {
    const event = await step.waitForEvent(name, options)
    return { type: "event", payload: event.payload as T }
  } catch (error) {
    // The engine constructs WorkflowTimeoutError, but its RPC boundary can
    // restore it as Error. The exact engine message is verified by the runtime
    // integration test; do not classify arbitrary errors containing "timeout".
    if (
      error instanceof Error &&
      (error.name === "WorkflowTimeoutError" ||
        (error.name === "Error" && /^Execution timed out after \d+ms$/.test(error.message)))
    )
      return { type: "timeout" }
    throw error
  }
}
