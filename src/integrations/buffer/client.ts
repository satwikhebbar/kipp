/** Read-only discovery shared by all future Buffer destinations. */
export interface BufferChannel {
  id: string
  organizationId: string
  service: string
  name: string
  allowedActions: string[]
  isDisconnected: boolean
  isLocked: boolean
  isQueuePaused: boolean
}
export interface BufferDiscovery {
  accountId: string
  channels: BufferChannel[]
}
const BUFFER_API_URL = "https://api.buffer.com"
const DISCOVERY_TIMEOUT_MS = 20_000

/** Executes a single read-only API request and hides potentially sensitive response errors. */
async function query<T>(accessToken: string, document: string, variables = {}): Promise<T> {
  const response = await fetch(BUFFER_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error("Buffer account discovery failed")
  const body = (await response.json()) as { data?: T; errors?: unknown[] }
  if (body.errors?.length || !body.data) throw new Error("Buffer account discovery failed")
  return body.data
}

/** Discovers only organizations belonging to the authenticated account. */
export async function discoverBuffer(accessToken: string): Promise<BufferDiscovery> {
  const { account } = await query<{ account: { id: string; organizations: { id: string }[] } }>(
    accessToken,
    "query KippIdentity { account { id organizations { id } } }",
  )
  if (!account || typeof account.id !== "string" || !account.id || !Array.isArray(account.organizations))
    throw new Error("Invalid Buffer account")
  const channels: BufferChannel[] = []
  for (const org of account.organizations) {
    if (typeof org.id !== "string" || !org.id) throw new Error("Invalid Buffer organization")
    const result = await query<{ channels: BufferChannel[] }>(
      accessToken,
      "query KippChannels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id organizationId service name allowedActions isDisconnected isLocked isQueuePaused } }",
      { organizationId: org.id },
    )
    if (!Array.isArray(result.channels)) throw new Error("Invalid Buffer channels")
    for (const channel of result.channels) {
      if (
        !channel ||
        typeof channel.id !== "string" ||
        !channel.id ||
        channel.organizationId !== org.id ||
        typeof channel.service !== "string" ||
        typeof channel.name !== "string" ||
        !Array.isArray(channel.allowedActions) ||
        !channel.allowedActions.every((action) => typeof action === "string") ||
        typeof channel.isDisconnected !== "boolean" ||
        typeof channel.isLocked !== "boolean" ||
        typeof channel.isQueuePaused !== "boolean"
      )
        throw new Error("Invalid Buffer channel")
      channels.push(channel)
    }
  }
  return { accountId: account.id, channels }
}

/** Validates the configured destination without silently selecting or changing it. */
export function validateSubstackChannel(
  discovery: BufferDiscovery,
  channelId?: string,
): { ready: boolean; message: string } {
  if (!channelId)
    return { ready: false, message: "Set BUFFER_SUBSTACK_CHANNEL_ID to one of the Substack channel IDs listed below." }
  const channel = discovery.channels.find((channel) => channel.id === channelId)
  if (!channel)
    return {
      ready: false,
      message: "Configured channel is not available to this Buffer account. Check BUFFER_SUBSTACK_CHANNEL_ID.",
    }
  if (channel.service !== "substack") return { ready: false, message: "Configured channel must be a Substack channel." }
  if (channel.isDisconnected) return { ready: false, message: "Reconnect your Substack channel inside Buffer." }
  if (channel.isLocked || !channel.allowedActions.includes("scheduleUpdates"))
    return { ready: false, message: "Buffer channel does not permit publishing. Check channel access in Buffer." }
  return {
    ready: true,
    message: channel.isQueuePaused
      ? "Substack channel is ready, but its Buffer queue is paused. Resume the queue in Buffer before using queue placement."
      : "Substack channel is ready.",
  }
}
