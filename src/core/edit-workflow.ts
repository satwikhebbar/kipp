const HEX_RADIX = 16
const HEX_BYTE_LENGTH = 2

/** Starts one deterministic edit run, including safe retries of a lost create response. */
export async function startEditWorkflow(workflow: Workflow, key: string, params: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  const id = `edit-${Array.from(new Uint8Array(digest), (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_LENGTH, "0")).join("")}`
  try {
    await workflow.create({ id, params })
  } catch (error) {
    // Only an existing run establishes successful delivery. Other failures must retry.
    try {
      const status = await (await workflow.get(id)).status()
      if (status.status === "unknown") throw error
    } catch {
      throw error
    }
  }
  return id
}
