/** Matches the event timeout error emitted by the Cloudflare Workflows runtime. */
export function workflowTimeoutError(): Error {
  return Object.assign(new Error("Execution timed out after 900000ms"), { remote: true })
}
