import { createTokenVault } from "../core/token-vault-client"
import type { Env } from "../core/types"
import { discoverBuffer, validateSubstackChannel } from "../integrations/buffer/client"
import { BUFFER_AUTH_URL, BUFFER_SCOPES, bufferRedirectUri, exchangeBufferToken } from "../integrations/buffer/oauth"
import { HTTP_STATUS } from "../runtime/http"
import { extractCookie, hasSetupAccess } from "./oauth"

const SUCCESS_STATUS = 200
const UPSTREAM_FAILURE_STATUS = 502
const COOKIE_NAME = "buffer-oauth-session"
const COOKIE_PATH = "/auth/buffer"
const COOKIE_SECONDS = 300
const CLEAR_COOKIE = `${COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`

/** Starts a protected, cookie-bound PKCE consent flow at the fixed callback. */
export async function handleBufferAuthStart(request: Request, env: Env): Promise<Response> {
  if (!(await hasSetupAccess(request, env))) return new Response("Setup requires authentication", { status: 403 })
  const redirectUri = bufferRedirectUri(env)
  if (!env.BUFFER_CLIENT_ID || !env.BUFFER_CLIENT_SECRET || !redirectUri)
    return new Response(
      "Configure BUFFER_CLIENT_ID, BUFFER_CLIENT_SECRET and a registered HTTPS BUFFER_REDIRECT_ORIGIN before connecting Buffer.",
      { status: 503 },
    )
  try {
    const { state, cookieId, challenge } = await createTokenVault(env).issueBufferState()
    const url = new URL(BUFFER_AUTH_URL)
    url.search = new URLSearchParams({
      client_id: env.BUFFER_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: BUFFER_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "consent",
    }).toString()
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
        "Set-Cookie": `${COOKIE_NAME}=${cookieId}; Secure; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${COOKIE_SECONDS}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    })
  } catch {
    return new Response("Buffer setup could not start. Try Connect Buffer again.", { status: 503 })
  }
}

/** Consumes the one-time state before exchange, then persists verified account identity and scope. */
export async function handleBufferAuthCallback(request: Request, env: Env): Promise<Response> {
  const reply = (message: string, status: number) =>
    new Response(message, {
      status,
      headers: { "Set-Cookie": CLEAR_COOKIE, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    })
  if (!(await hasSetupAccess(request, env))) return reply("OAuth setup requires authentication.", HTTP_STATUS.FORBIDDEN)
  if (!env.BUFFER_CLIENT_ID || !env.BUFFER_CLIENT_SECRET || !bufferRedirectUri(env))
    return reply("Buffer OAuth is not configured.", HTTP_STATUS.SERVICE_UNAVAILABLE)
  const url = new URL(request.url)
  const state = url.searchParams.get("state")
  const code = url.searchParams.get("code")
  const cookieId = extractCookie(request.headers.get("cookie"), COOKIE_NAME)
  if (!state || !cookieId)
    return reply("Buffer setup expired or could not be verified. Start Connect Buffer again.", HTTP_STATUS.BAD_REQUEST)
  try {
    const vault = createTokenVault(env)
    const consumed = await vault.consumeBufferState(state, cookieId)
    if (!consumed.valid)
      return reply("Buffer setup expired or was already used. Start Connect Buffer again.", HTTP_STATUS.BAD_REQUEST)
    if (!code || url.searchParams.has("error"))
      return reply("Buffer authorization was not completed. Start Connect Buffer again.", HTTP_STATUS.BAD_REQUEST)
    const token = await exchangeBufferToken(env, {
      grant_type: "authorization_code",
      code,
      code_verifier: consumed.verifier,
      redirect_uri: consumed.redirectUri,
    })
    const discovery = await discoverBuffer(token.accessToken)
    if (!(await vault.replaceBufferGrant({ ...token, accountId: discovery.accountId })).ok)
      return reply(
        "Buffer authorization could not be saved. Start Connect Buffer again.",
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      )
    const validation = validateSubstackChannel(discovery, env.BUFFER_SUBSTACK_CHANNEL_ID)
    const channels = !env.BUFFER_SUBSTACK_CHANNEL_ID
      ? discovery.channels
          .filter((channel) => channel.service === "substack")
          .map((channel) => `${channel.name}: ${channel.id}`)
          .join("\n")
      : ""
    return reply(
      `Buffer connected.\n${validation.message}${channels ? `\n\nSubstack channels (name: ID):\n${channels}` : ""}`,
      SUCCESS_STATUS,
    )
  } catch {
    return reply(
      "Buffer authorization could not be completed. Start Connect Buffer again. If Substack is disconnected, reconnect it inside Buffer.",
      UPSTREAM_FAILURE_STATUS,
    )
  }
}
