import { createHash, randomBytes } from "node:crypto"
import { open, readFile, writeFile, unlink } from "node:fs/promises"
import { parseEnv } from "node:util"
import { encryptedStore, validateGrant } from "./oauth.mjs"

const directory = ".wrangler/notes-buffer-spike"
const vars = parseEnv(await readFile(".dev.vars", "utf8"))
const store = await encryptedStore(directory)
const lock = await open(`${directory}/live.lock`, "wx", 0o600)
const command = process.argv[2]
const digest = value => createHash("sha256").update(value).digest("hex")

/** Executes exactly one provider request and returns its JSON without logging credentials. */
async function graphql(document, variables = {}) {
  const grant = await store.read()
  if (grant.expiresAtMs <= Date.now() + 60_000) throw Error("Grant needs refresh before this test")
  const response = await fetch("https://api.buffer.com", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
  })
  const body = await response.json()
  return { httpStatus: response.status, ...body }
}

/** Writes only allowlisted post fields as local evidence. */
function postEvidence(post) {
  if (!post) return null
  return Object.fromEntries(["id", "channelId", "channelService", "text", "status", "dueAt", "shareMode", "schedulingType", "isCustomScheduled", "sharedNow", "externalLink", "allowedActions", "metadata"].filter(key => key in post).map(key => [key, post[key]]))
}

try {
  if (command === "inspect") {
    const result = await graphql(`query KippSpikeSchema {
      post: __type(name: "Post") { fields { name } }
      deletePayload: __type(name: "DeletePostPayload") { possibleTypes { name } }
      query: __type(name: "Query") { fields { name args { name type { kind name ofType { kind name } } } } }
      postInput: __type(name: "PostInput") { inputFields { name type { kind name ofType { kind name } } } }
      account { id organizations { id channels { id name service externalLink } } }
    }`)
    // Keep the schema query output small and exclude unrelated query operations.
    if (result.data?.query) result.data.query.fields = result.data.query.fields.filter(x => x.name === "post")
    console.log(JSON.stringify(result, null, 2))
  } else if (command === "refresh") {
    const grant = await store.read()
    const markerPath = `${directory}/refresh-claim.json`
    let previous
    try { previous = JSON.parse(await readFile(markerPath, "utf8")) } catch (error) { if (error.code !== "ENOENT") throw error }
    if (previous?.tokenFingerprint === digest(grant.refresh_token)) throw Error("Uncertain prior refresh: reconnect instead of reusing token")
    await writeFile(markerPath, JSON.stringify({ tokenFingerprint: digest(grant.refresh_token), claimedAt: new Date().toISOString() }), { mode: 0o600 })
    const response = await fetch("https://auth.buffer.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: vars.BUFFER_CLIENT_ID.trim(), client_secret: vars.BUFFER_CLIENT_SECRET.trim(), grant_type: "refresh_token", refresh_token: grant.refresh_token }),
    })
    if (!response.ok) throw Error(`Refresh HTTP ${response.status}; reconnect rather than blind retry`)
    const replacement = validateGrant(await response.json(), Date.now())
    await store.write(replacement)
    await unlink(markerPath)
    const evidence = { refreshedAt: new Date().toISOString(), httpStatus: response.status, refreshTokenChanged: replacement.refresh_token !== grant.refresh_token, accessTokenChanged: replacement.access_token !== grant.access_token, scopes: replacement.scopes, expiresAtMs: replacement.expiresAtMs }
    await writeFile(`${directory}/refresh-evidence.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(evidence, null, 2))
  } else if (command === "queue" || command === "schedule" || command === "now") {
    const discovery = JSON.parse(await readFile(`${directory}/discovery.json`, "utf8"))
    if (discovery.substackChannels.length !== 1) throw Error("Exactly one verified Substack channel required")
    const channel = discovery.substackChannels[0]
    if (channel.isDisconnected || channel.isLocked || channel.isQueuePaused || !channel.allowedActions.includes("scheduleUpdates")) throw Error("Channel is not ready for automatic publishing")
    const text = process.argv[3]
    if (!text?.trim()) throw Error("Explicit test text required")
    const url = process.argv[4]
    if (url && !["http:", "https:"].includes(new URL(url).protocol)) throw Error("Invalid test link")
    const input = { channelId: channel.id, text, assets: [], schedulingType: "automatic", mode: command === "queue" ? "addToQueue" : command === "now" ? "shareNow" : "customScheduled", needsApproval: false, saveToDraft: false }
    if (command === "schedule") input.dueAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
    if (url) input.metadata = { substack: { linkAttachment: { url } } }
    const evidencePath = `${directory}/create-${command}-${digest(text).slice(0, 16)}.json`
    const intent = { attemptId: randomBytes(16).toString("hex"), state: "dispatching", requestedAt: new Date().toISOString(), input }
    // Never repeat a create after an uncertain invocation, including a lost response.
    const file = await open(evidencePath, "wx", 0o600)
    try { await file.writeFile(JSON.stringify(intent, null, 2)); await file.sync() } finally { await file.close() }
    console.log(`Dispatching one ${command} test; intent retained at ${evidencePath}`)
    const result = await graphql(`mutation KippSpikeCreate($input: CreatePostInput!) {
      createPost(input: $input) {
        __typename
        ... on PostActionSuccess { post { id channelId channelService text status dueAt shareMode schedulingType isCustomScheduled sharedNow externalLink allowedActions metadata { ... on SubstackPostMetadata { linkAttachment { url expandedUrl } } } } }
        ... on MutationError { message }
      }
    }`, { input })
    const payload = result.data?.createPost
    const evidence = { ...intent, state: payload?.post?.id ? "created" : "unconfirmed", httpStatus: result.httpStatus, typename: payload?.__typename, post: postEvidence(payload?.post), graphqlErrors: result.errors?.map(x => ({ message: x.message })), mutationMessage: payload?.message }
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(evidence, null, 2))
  } else if (command === "read") {
    const evidencePath = process.argv[3]
    if (!evidencePath?.startsWith(directory + "/create-") || evidencePath.includes("..")) throw Error("Only a recorded test post can be read")
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"))
    if (!evidence.post?.id) throw Error("No known test post identity")
    const result = await graphql(`query KippSpikePost($input: PostInput!) { post(input: $input) { id channelId channelService text status dueAt shareMode schedulingType isCustomScheduled sharedNow externalLink allowedActions metadata { ... on SubstackPostMetadata { linkAttachment { url expandedUrl } } } } }`, { input: { id: evidence.post.id } })
    evidence.observed = { at: new Date().toISOString(), httpStatus: result.httpStatus, post: postEvidence(result.data?.post), graphqlErrors: result.errors?.map(x => ({ message: x.message })) }
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(evidence.observed, null, 2))
  } else if (command === "cleanup") {
    const evidencePath = process.argv[3]
    if (!evidencePath?.startsWith(directory + "/create-") || evidencePath.includes("..")) throw Error("Only a locally recorded test post can be removed")
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"))
    const id = evidence.post?.id
    if (!id || evidence.cleanup) throw Error("No eligible recorded test post")
    if (!evidence.post.allowedActions?.includes("deletePost")) throw Error("Buffer does not allow deletion of this post; use native Substack cleanup")
    const result = await graphql(`mutation KippSpikeDelete($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on DeletePostSuccess { id } ... on MutationError { message } } }`, { input: { id } })
    evidence.cleanup = result
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(result, null, 2))
  } else {
    throw Error("Choose inspect, refresh, queue, schedule, now, read or cleanup")
  }
} catch (error) {
  // No provider error body, request object, grant, or callback URL is logged.
  console.error(`Buffer spike stopped: ${error.code === "EEXIST" ? "existing claim/lock prevents replay" : error.name === "TimeoutError" ? "request timed out; retain uncertainty" : "check local evidence; no automatic retry"}`)
  process.exitCode = 1
} finally {
  await lock.close()
  await unlink(`${directory}/live.lock`)
}
