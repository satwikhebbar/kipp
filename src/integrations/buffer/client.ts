import type { BufferCreateCommand, BufferCreateResult, BufferDestination } from "../../notes/types"
import { HTTP_STATUS } from "../../runtime/http"
import { mapSubstackPost } from "./substack"

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
/** A read-only destination check can establish a safe pre-create repair requirement. */
export class BufferDestinationError extends Error {
  constructor(
    readonly reason: string,
    readonly repair: "reauthorize" | "reconnect-channel" | "configuration",
  ) {
    super("Buffer destination unavailable")
  }
}
const BUFFER_API_URL = "https://api.buffer.com"
const BUFFER_REQUEST_TIMEOUT_MS = 20_000

/** Executes a single read-only API request and hides potentially sensitive response errors. */
async function query<T>(accessToken: string, document: string, variables = {}): Promise<T> {
  const response = await fetch(BUFFER_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(BUFFER_REQUEST_TIMEOUT_MS),
  })
  if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN)
    throw new BufferDestinationError("reauthorization-required", "reauthorize")
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

/** Resolves the configured channel without substituting another destination. */
export async function discoverBufferDestination(
  accessToken: string,
  connectionId: string,
  channelId: string,
  requireQueue = false,
): Promise<BufferDestination> {
  const discovery = await discoverBuffer(accessToken)
  const configured = discovery.channels.find((channel) => channel.id === channelId)
  if (configured?.isDisconnected) throw new BufferDestinationError("channel-disconnected", "reconnect-channel")
  if (!validateSubstackChannel(discovery, channelId).ready)
    throw new BufferDestinationError("destination-unavailable", "configuration")
  if (requireQueue && configured?.isQueuePaused) throw new BufferDestinationError("queue-paused", "reconnect-channel")
  const channel = discovery.channels.find((channel) => channel.id === channelId)
  if (!channel) throw new Error("Buffer destination unavailable")
  return {
    accountId: discovery.accountId,
    connectionId,
    organizationId: channel.organizationId,
    channelId,
    service: "substack",
  }
}

const POST_FIELDS = `id channelId channelService text status dueAt shareMode schedulingType isCustomScheduled sharedNow externalLink metadata { ... on SubstackPostMetadata { linkAttachment { url expandedUrl } } }`
const CREATE_POST = `mutation KippCreatePost($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message } } }`

/** Decodes post evidence conservatively; generic GraphQL errors never establish non-creation. */
export function decodeBufferPost(post: unknown, command: BufferCreateCommand): BufferCreateResult {
  if (!post || typeof post !== "object") return { kind: "unknown", reason: "missing-post" }
  const p = post as Record<string, unknown>
  if (typeof p.id !== "string" || !p.id) return { kind: "unknown", reason: "missing-post-id" }
  const metadata = p.metadata as { linkAttachment?: { url?: unknown } | null } | null | undefined
  if (
    p.channelId !== command.destination.channelId ||
    p.channelService !== command.destination.service ||
    p.text !== command.text ||
    p.shareMode !== mapSubstackPost(command).mode ||
    (p.schedulingType !== null && p.schedulingType !== "automatic") ||
    p.isCustomScheduled !== (command.timing.kind === "schedule") ||
    p.sharedNow !== (command.timing.kind === "now") ||
    !["sent", "pending", "scheduled"].includes(String(p.status)) ||
    (command.timing.kind === "schedule" &&
      (typeof p.dueAt !== "string" || Date.parse(p.dueAt) !== Date.parse(command.timing.dueAt))) ||
    (command.attachmentUrl ? metadata?.linkAttachment?.url !== command.attachmentUrl : metadata?.linkAttachment != null)
  )
    return { kind: "created-unexpected", postId: p.id, reason: "post-does-not-match-approval" }
  return {
    kind: "accepted",
    postId: p.id,
    ...(typeof p.dueAt === "string" && Number.isFinite(Date.parse(p.dueAt)) ? { dueAt: p.dueAt } : {}),
    ...(typeof p.externalLink === "string" && /^https:\/\//u.test(p.externalLink) ? { link: p.externalLink } : {}),
  }
}

/** Sends exactly one create request. No HTTP status or generic error permits another create. */
export async function createBufferPostOnce(
  accessToken: string,
  command: BufferCreateCommand,
): Promise<BufferCreateResult> {
  try {
    const response = await fetch(BUFFER_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: CREATE_POST, variables: { input: mapSubstackPost(command) } }),
      signal: AbortSignal.timeout(BUFFER_REQUEST_TIMEOUT_MS),
    })
    const body = (await response.json()) as {
      data?: { createPost?: { __typename?: string; post?: unknown } }
      errors?: unknown[]
    }
    const payload = body.data?.createPost
    // Preserve an ID even alongside errors; its existence rules out a fresh create.
    if (payload?.post) {
      const decoded = decodeBufferPost(payload.post, command)
      if (response.ok && !body.errors?.length && payload.__typename === "PostActionSuccess") return decoded
      const id = (payload.post as { id?: unknown }).id
      return { kind: "unknown", reason: "incomplete-post-response", ...(typeof id === "string" ? { postId: id } : {}) }
    }
    return { kind: "unknown", reason: "unconfirmed-create" }
  } catch {
    return { kind: "unknown", reason: "unconfirmed-create" }
  }
}

/** Makes one bounded lookup of a captured post ID; never searches or polls for publication. */
export async function inspectBufferPost(
  accessToken: string,
  postId: string,
  command: BufferCreateCommand,
): Promise<BufferCreateResult> {
  try {
    const result = await query<{ post: unknown }>(
      accessToken,
      `query KippInspectPost($input: PostInput!) { post(input: $input) { ${POST_FIELDS} } }`,
      { input: { id: postId } },
    )
    const decoded = decodeBufferPost(result.post, command)
    if ("postId" in decoded && decoded.postId === postId) return decoded
  } catch {
    /* Unknown stays terminal; a failed read cannot authorize another create. */
  }
  return { kind: "unknown", reason: "unconfirmed-create", postId }
}
