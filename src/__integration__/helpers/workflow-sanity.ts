import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeNetwork } from "../setup"

export type WireBody = Record<string, unknown>
export type ScriptedModel = (body: WireBody, call: number) => WireBody
export const SANITY_LIMITS = {
  modelCalls: 12,
  userTurns: 5,
  outputTokensPerCall: 16_384,
  outputTokensTotal: 98_304,
  scenarioMs: 240_000,
  requestMs: 90_000,
} as const

type TelegramMessage = ReturnType<ReturnType<typeof createFakeNetwork>["getState"]>["telegramMessages"][number]
type NodeRequest = { url: string; method: string; text(): Promise<string> }
type Runtime = { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }

// These controls and observers exist only in the test bundle, never in src/index.ts.
const entry = `
  import worker, { PipelineWorkflow, CalendarWorkflow, InteractionRouterDO, IdeaIngestDO, TokenVaultDO, NotesWorkflow, BufferPublicationDO } from "./src/index.ts";
  import { createTokenVault } from "./src/core/token-vault-client.ts";
  export { IdeaIngestDO, TokenVaultDO, BufferPublicationDO };
  export class ObservedRouter extends InteractionRouterDO {
    async fetch(request) {
      const registration = new URL(request.url).pathname === "/register" ? await request.clone().json() : null;
      const binding = new URL(request.url).pathname === "/notes/bind" ? await request.clone().json() : null;
      const response = await super.fetch(request);
      if (["/notes/resolve", "/notes/ack"].includes(new URL(request.url).pathname)) {
        const check = await fetch("https://sanity.test/router-boundary", {method:"POST",body:JSON.stringify({path:new URL(request.url).pathname,response:await response.clone().json()})});
        if (!check.ok) return new Response("Injected transport failure", {status:503});
      }
      if (binding && response.ok) await fetch("https://sanity.test/bound", {method:"POST",body:JSON.stringify(binding)});
      if (registration && response.ok) await fetch("https://sanity.test/registered", {method:"POST",body:JSON.stringify(registration)});
      return response;
    }
  }
  export class LinkedInProbe extends PipelineWorkflow {
    async run(event, step) {
      await step.do("sanity-observe-start", () => fetch("https://sanity.test/started", {method:"POST",body:JSON.stringify({domain:"linkedin",id:event.instanceId})}).then(() => true));
      return super.run(event, step);
    }
  }
  export class NotesProbe extends NotesWorkflow {
    async run(event, step) {
      await step.do("sanity-observe-start", () => fetch("https://sanity.test/started", {method:"POST",body:JSON.stringify({domain:"notes",id:event.instanceId})}).then(() => true));
      const writingRetries = this.env.SANITY_NOTES_WRITING_RETRIES;
      const wrapped = new Proxy(step, {get(target, key) {
        if (key !== "do") { const value = target[key]; return typeof value === "function" ? (...args) => target[key](...args) : value; }
        return (name, ...args) => {
          const operation = args.pop();
          if (name.startsWith("notes-write-") && Number.isInteger(writingRetries)) {
            // Fault scenarios shorten only the runtime retry policy; production must use its defaults.
            const config = args[0] ?? {};
            if (config.retries) throw new Error("Notes writing must use Workflow default retries, like LinkedIn");
            return target.do(name, {...config,retries:{limit:writingRetries,delay:"1 second"}},operation);
          }
          if (name !== "notes-submit") return target.do(name, ...args, operation);
          return target.do(name, {retries:{limit:1,delay:"1 second"}}, async (...input) => {
            const result = await operation(...input);
            const response = await fetch("https://sanity.test/publication-checkpoint", {method:"POST",body:JSON.stringify({result})});
            if (!response.ok) throw new Error("Injected lost publication checkpoint");
            return result;
          });
        };
      }});
      return super.run(event, wrapped);
    }
  }
  export class CalendarProbe extends CalendarWorkflow {
    async run(event, step) {
      await step.do("sanity-observe-start", () => fetch("https://sanity.test/started", {method:"POST",body:JSON.stringify({domain:"calendar",id:event.instanceId})}).then(() => true));
      return super.run(event, step);
    }
  }
  export default { async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/seed") {
      for (const provider of ["linkedin", "google-calendar"]) {
        const result = await createTokenVault(env, provider).writeTokens({access_token:"synthetic-test-token",refresh_token:"synthetic-refresh",expires_in:86400,created_at:new Date().toISOString()});
        if (!result.ok) throw new Error("Could not seed synthetic tokens");
      }
      if (url.searchParams.get("skipBuffer") !== "true")
        await createTokenVault(env).replaceBufferGrant({accessToken:"synthetic-buffer-token",refreshToken:"synthetic-buffer-refresh",expiresAtMs:Date.now()+86400000,accountId:"buffer-account",scopes:["account:read","posts:read","posts:write","offline_access"]});
      return Response.json({ok:true});
    }
    if (url.pathname === "/__test/buffer-grant") {
      const result = await createTokenVault(env).replaceBufferGrant({accessToken:"synthetic-buffer-token",refreshToken:"synthetic-buffer-refresh",expiresAtMs:Date.now()+(url.searchParams.get("nearExpiry") === "true" ? 60000 : 86400000),accountId:url.searchParams.get("account") ?? "buffer-account",scopes:["account:read","posts:read","posts:write","offline_access"]});
      return Response.json(result);
    }
    if (url.pathname === "/__test/status") {
      const binding = url.searchParams.get("domain") === "notes" ? env.NOTES_WORKFLOW : url.searchParams.get("domain") === "linkedin" ? env.PIPELINE_WORKFLOW : env.CALENDAR_WORKFLOW;
      return Response.json(await (await binding.get(url.searchParams.get("id"))).status());
    }
    if (url.pathname === "/__test/control") {
      const instance = await env.NOTES_WORKFLOW.get(url.searchParams.get("id"));
      await instance[url.searchParams.get("operation")]();
      return Response.json({ok:true});
    }
    return worker.fetch(request, env, ctx);
  }};
`

/** Runs the production HTTP routes, workflows, clients and durable storage with isolated external services. */
export async function createWorkflowSanity(options: {
  model?: ScriptedModel
  live?: { apiKey: string; model: string; provider?: "deepseek" | "openrouter" }
  notesWritingRetries?: number
  skipBufferGrant?: boolean
  userTurnLimit?: number
  timeZone?: string | null
  bufferResult?: (input: WireBody) => WireBody
  notesRouterFault?: "resolve" | "ack"
  loseNotesSubmitCheckpoint?: boolean
  persistent?: boolean
  onProgress?: (event: { phase: "request" | "response"; call: number; outputTokens?: number }) => void
}) {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
  const { build } = runtimeRequire("esbuild")
  const { Miniflare, Response: RuntimeResponse, Log, LogLevel } = runtimeRequire("miniflare")
  const network = createFakeNetwork({
    githubFiles: {
      "style-prompt.md":
        "Write a concise, concrete LinkedIn post for software builders. Preserve supplied facts. No invented experiences or hashtags.",
    },
    notionPages: [
      {
        pageId: "page_1",
        kippId: 1,
        title: "Small releases",
        status: "raw",
        source: "manual",
        markdown:
          "Small releases make feedback easier to act on. A smaller change is easier to understand and reverse.",
        chatId: "100",
      },
    ],
  })
  const state = {
    modelCalls: 0,
    outputTokens: 0,
    transcript: [] as Array<{ request: WireBody; response: WireBody }>,
    calendarWrites: [] as WireBody[],
    linkedinWrites: [] as WireBody[],
    bufferWrites: [] as WireBody[],
    bufferRefreshes: 0,
    bufferDiscoveryCalls: 0,
    publicationCheckpoints: 0,
    publicationResults: [] as unknown[],
    bufferDisconnected: false,
    bufferQueuePaused: false,
    started: [] as Array<{ domain: string; id: string }>,
    registrations: [] as WireBody[],
    boundNotesMessages: [] as number[],
    failures: [] as string[],
  }
  let routerFaultInjected = false
  let checkpointFaultInjected = false
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const abort = new AbortController()
  const scenarioMs = options.live ? SANITY_LIMITS.scenarioMs : 20_000
  const deadline = Date.now() + scenarioMs
  const { outputFiles } = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "workflow-sanity-entry.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  })
  const persistence = options.persistent ? await mkdtemp(join(tmpdir(), "kipp-notes-workflow-recovery-")) : null
  const runtimeOptions = {
    modules: true,
    script: outputFiles[0].text,
    compatibilityDate: "2026-07-08",
    log: new Log(LogLevel.ERROR),
    ...(persistence
      ? { workflowsPersist: join(persistence, "workflows"), durableObjectsPersist: join(persistence, "objects") }
      : {}),
    bindings: {
      ...(options.notesWritingRetries !== undefined
        ? { SANITY_NOTES_WRITING_RETRIES: options.notesWritingRetries }
        : {}),
      TELEGRAM_BOT_TOKEN: "synthetic:bot",
      TELEGRAM_WEBHOOK_SECRET: "sanity-secret",
      TELEGRAM_ALLOWED_USER_ID: "42",
      LLM_PROVIDER: "deepseek",
      LLM_MODEL: options.live?.model ?? "deepseek-flash",
      LLM_API_KEY: "intercepted-model-token",
      OPENROUTER_API_KEY: "intercepted-openrouter-token",
      LLM_MAX_RETRIES: "0",
      ...(options.timeZone !== null ? { TIMEZONE: options.timeZone ?? "Asia/Kolkata" } : {}),
      WAIT_FOR_FEEDBACK_HOURS: "12",
      GITHUB_PAT: "synthetic",
      DATA_REPO_OWNER: "test",
      DATA_REPO_NAME: "test",
      NOTION_API_KEY: "synthetic",
      NOTION_IDEAS_DATA_SOURCE_ID: "test",
      LINKEDIN_AUTHOR_URN: "urn:li:person:synthetic",
      BUFFER_CLIENT_ID: "synthetic-buffer-client",
      BUFFER_CLIENT_SECRET: "synthetic-buffer-secret",
      BUFFER_REDIRECT_ORIGIN: "https://kipp.test",
      BUFFER_SUBSTACK_CHANNEL_ID: "buffer-channel",
      TOKEN_ENCRYPTION_KEY_IDS: "sanity",
      TOKEN_ENCRYPTION_KEY_sanity: Buffer.alloc(32, 7).toString("base64url"),
    },
    workflows: {
      PIPELINE_WORKFLOW: { name: "sanity-linkedin", className: "LinkedInProbe" },
      CALENDAR_WORKFLOW: { name: "sanity-calendar", className: "CalendarProbe" },
      NOTES_WORKFLOW: { name: "sanity-notes", className: "NotesProbe" },
    },
    durableObjects: {
      INTERACTION_ROUTER: { className: "ObservedRouter", useSQLite: true },
      IDEA_INGEST: { className: "IdeaIngestDO", useSQLite: true },
      TOKEN_VAULT: { className: "TokenVaultDO", useSQLite: true },
      BUFFER_PUBLICATIONS: { className: "BufferPublicationDO", useSQLite: true },
    },
    outboundService: async (request: NodeRequest) => {
      try {
        if (state.failures.length) throw new Error("Scenario already failed; further outbound calls are blocked")
        if (abort.signal.aborted || Date.now() >= deadline) throw new Error("Scenario wall-clock budget exceeded")
        const url = new URL(request.url)
        if (url.origin === "https://auth.buffer.com" && url.pathname === "/token") {
          state.bufferRefreshes++
          return RuntimeResponse.json({ error: "invalid_grant" }, { status: 400 })
        }
        const text = request.method === "GET" ? "" : await request.text()
        const body: WireBody = text ? JSON.parse(text) : {}
        if (url.origin === "https://sanity.test" && url.pathname === "/publication-checkpoint") {
          state.publicationCheckpoints++
          state.publicationResults.push(body.result)
          if (options.loseNotesSubmitCheckpoint && !checkpointFaultInjected) {
            checkpointFaultInjected = true
            return RuntimeResponse.json({}, { status: 503 })
          }
          return RuntimeResponse.json({ ok: true })
        }
        if (url.origin === "https://sanity.test" && url.pathname === "/router-boundary") {
          const response = body.response as { event?: unknown }
          if (
            !routerFaultInjected &&
            options.notesRouterFault &&
            body.path === `/notes/${options.notesRouterFault}` &&
            (options.notesRouterFault === "ack" || response.event)
          ) {
            routerFaultInjected = true
            return RuntimeResponse.json({}, { status: 503 })
          }
          return RuntimeResponse.json({ ok: true })
        }
        if (url.origin === "https://sanity.test" && url.pathname === "/started") {
          state.started.push(body as { domain: string; id: string })
          return RuntimeResponse.json({ ok: true })
        }
        if (url.origin === "https://sanity.test" && url.pathname === "/bound") {
          state.boundNotesMessages.push(Number(body.messageId))
          return RuntimeResponse.json({ ok: true })
        }
        if (url.origin === "https://sanity.test" && url.pathname === "/registered") {
          state.registrations.push(body)
          return RuntimeResponse.json({ ok: true })
        }
        if (
          (url.origin === "https://api.deepseek.com" && url.pathname === "/chat/completions") ||
          (url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/chat/completions")
        ) {
          if (++state.modelCalls > SANITY_LIMITS.modelCalls) throw new Error("Model-call budget exceeded")
          options.onProgress?.({ phase: "request", call: state.modelCalls })
          let response: WireBody
          if (options.live) {
            const expectedOrigin =
              options.live.provider === "openrouter" ? "https://openrouter.ai" : "https://api.deepseek.com"
            if (url.origin !== expectedOrigin) throw new Error("Unexpected live model provider")
            // Keep any stricter production cap intact; otherwise allow generous anomaly-detection headroom.
            body.max_tokens = Math.min(
              Number(body.max_tokens ?? SANITY_LIMITS.outputTokensPerCall),
              SANITY_LIMITS.outputTokensPerCall,
            )
            const upstream = await nativeFetch(url.href, {
              method: "POST",
              headers: { Authorization: `Bearer ${options.live.apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SANITY_LIMITS.requestMs)]),
            })
            if (!upstream.ok) throw new Error(`Live model HTTP ${upstream.status}`)
            response = (await upstream.json()) as WireBody
          } else {
            if (!options.model) throw new Error("Missing scripted model")
            response = options.model(body, state.modelCalls)
          }
          state.transcript.push({ request: body, response })
          const usage = response.usage as { completion_tokens?: number } | undefined
          state.outputTokens += usage?.completion_tokens ?? 0
          options.onProgress?.({
            phase: "response",
            call: state.modelCalls,
            outputTokens: usage?.completion_tokens ?? 0,
          })
          if (state.outputTokens > SANITY_LIMITS.outputTokensTotal)
            throw new Error("Scenario output-token budget exceeded")
          const choices = response.choices as Array<{ finish_reason?: string }> | undefined
          if (choices?.some((choice) => choice.finish_reason === "length"))
            throw new Error("Model output was truncated by token limit")
          return RuntimeResponse.json(response)
        }
        if (url.origin === "https://api.buffer.com") {
          const query = String(body.query)
          if (query.includes("KippIdentity")) {
            state.bufferDiscoveryCalls++
            return RuntimeResponse.json({
              data: { account: { id: "buffer-account", organizations: [{ id: "buffer-org" }] } },
            })
          }
          if (query.includes("KippChannels"))
            return RuntimeResponse.json({
              data: {
                channels: [
                  {
                    id: "buffer-channel",
                    organizationId: "buffer-org",
                    service: "substack",
                    name: "Test",
                    allowedActions: ["scheduleUpdates"],
                    isDisconnected: state.bufferDisconnected,
                    isLocked: false,
                    isQueuePaused: state.bufferQueuePaused,
                  },
                ],
              },
            })
          if (query.includes("KippCreatePost")) {
            const input = (body.variables as { input: WireBody }).input
            state.bufferWrites.push(input)
            return RuntimeResponse.json(
              options.bufferResult
                ? options.bufferResult(input)
                : {
                    data: {
                      createPost: {
                        __typename: "PostActionSuccess",
                        post: {
                          id: "buffer-post",
                          channelId: input.channelId,
                          channelService: "substack",
                          text: input.text,
                          status: input.mode === "shareNow" ? "sent" : "scheduled",
                          shareMode: input.mode,
                          ...(input.mode !== "shareNow" ? { dueAt: input.dueAt ?? "2030-01-01T13:30:00.000Z" } : {}),
                          schedulingType: "automatic",
                          isCustomScheduled: input.mode === "customScheduled",
                          sharedNow: input.mode === "shareNow",
                          externalLink: null,
                          metadata: {
                            linkAttachment:
                              (input.metadata as { substack?: { linkAttachment?: unknown } } | undefined)?.substack
                                ?.linkAttachment ?? null,
                          },
                        },
                      },
                    },
                  },
            )
          }
          throw new Error("Unexpected Buffer request")
        }
        if (url.origin === "https://www.googleapis.com") {
          if (url.pathname === "/calendar/v3/freeBusy" && request.method === "POST")
            return RuntimeResponse.json({ calendars: { primary: { busy: [] } } })
          if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "POST") {
            state.calendarWrites.push(body)
            return RuntimeResponse.json(body)
          }
          if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "GET")
            return RuntimeResponse.json({ items: [] })
          throw new Error(`Unexpected Calendar request: ${request.method} ${url.pathname}`)
        }
        if (!["api.telegram.org", "api.notion.com", "api.github.com", "api.linkedin.com"].includes(url.hostname))
          throw new Error(`Unexpected outbound host: ${url.hostname}`)
        if (url.hostname === "api.linkedin.com") {
          if (url.pathname !== "/v2/ugcPosts" || request.method !== "POST")
            throw new Error("Unexpected LinkedIn request")
          state.linkedinWrites.push(body)
        }
        const response = await network.fetch(url.href, { method: request.method, ...(text ? { body: text } : {}) })
        return new RuntimeResponse(await response.text(), { status: response.status })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Outbound test failure"
        state.failures.push(message)
        return RuntimeResponse.json({ error: message }, { status: 599 })
      }
    },
  }
  let runtime: Runtime = new Miniflare(runtimeOptions)
  const timer = setTimeout(
    () => abort.abort(new Error("Scenario wall-clock budget exceeded")),
    Math.max(0, deadline - Date.now()),
  )
  /** Includes local-runtime startup and webhook requests in the same scenario deadline. */
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("Scenario wall-clock budget exceeded"))
          abort.signal.addEventListener("abort", onAbort, { once: true })
          if (abort.signal.aborted) onAbort()
        }),
      ])
    } finally {
      if (onAbort) abort.signal.removeEventListener("abort", onAbort)
    }
  }
  let updateId = 0
  let userTurns = 0
  /** Sends an authenticated Telegram update through the production HTTP route. */
  async function update(body: WireBody, id = ++updateId, secret = "sanity-secret") {
    if (++userTurns > (options.live ? SANITY_LIMITS.userTurns : (options.userTurnLimit ?? SANITY_LIMITS.userTurns)))
      throw new Error("User-turn budget exceeded")
    const response = await bounded(
      runtime.dispatchFetch("https://kipp.test/webhook/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify({ update_id: id, ...body }),
      }),
    )
    return response.status
  }
  /** Polls bounded test observations, failing immediately on intercepted transport/budget failures. */
  async function until<T>(read: () => T | undefined): Promise<T> {
    while (Date.now() < deadline && !abort.signal.aborted) {
      if (state.failures.length) throw new Error(state.failures.join("; "))
      const result = read()
      if (result !== undefined) return result
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(
      `Scenario wall-clock budget exceeded: ${JSON.stringify({ ...state, telegram: network.getState().telegramMessages })}`,
    )
  }
  try {
    const response = await bounded(
      runtime.dispatchFetch(`https://kipp.test/__test/seed?skipBuffer=${Boolean(options.skipBufferGrant)}`),
    )
    if (!response.ok) throw new Error("Could not seed test vault")
  } catch (error) {
    clearTimeout(timer)
    await runtime.dispose()
    throw error
  }
  return {
    state,
    network,
    /** Pauses or resumes the actual Notes engine before a deliberate workerd shutdown. */
    controlNotes: async (operation: "pause" | "resume") => {
      const instance = await until(() => state.started.find((item) => item.domain === "notes"))
      const response = await runtime.dispatchFetch(
        `https://kipp.test/__test/control?id=${instance.id}&operation=${operation}`,
      )
      if (!response.ok) throw new Error(`Could not ${operation} Notes workflow`)
    },
    /** Reconstructs a fresh runtime against the same Workflow and SQLite stores. */
    reboot: async () => {
      if (!persistence) throw new Error("Persistent runtime was not requested")
      await runtime.dispose()
      runtime = new Miniflare(runtimeOptions)
    },
    setBufferGrant: async (nearExpiry = false, accountId = "buffer-account") => {
      const response = await runtime.dispatchFetch(
        `https://kipp.test/__test/buffer-grant?nearExpiry=${nearExpiry}&account=${encodeURIComponent(accountId)}`,
      )
      if (!response.ok) throw new Error("Could not update synthetic Buffer grant")
    },
    until,
    update,
    message: async (
      text: string,
      replyTo?: number,
      entities?: Array<{ type: string; offset: number; length: number; url?: string }>,
    ) => {
      // Telegram HTTP capture can precede the workflow's post-send reply binding.
      // Simulated replies wait for that boundary, just as callbacks wait for registration.
      if (replyTo && state.started.some((item) => item.domain === "notes"))
        await until(() => state.boundNotesMessages.includes(replyTo))
      return update({
        message: {
          message_id: updateId + 1,
          from: { id: 42, is_bot: false },
          chat: { id: 100, type: "private" },
          text,
          ...(entities ? { entities } : {}),
          ...(replyTo ? { reply_to_message: { message_id: replyTo, from: { id: 7, is_bot: true } } } : {}),
        },
      })
    },
    click: async (message: TelegramMessage, label: RegExp, id?: number) => {
      const keyboard = message.replyMarkup?.inline_keyboard as Array<Array<{ text: string; callback_data?: string }>>
      const button = keyboard?.flat().find((button) => label.test(button.text))
      if (!button?.callback_data) throw new Error(`No callback button matching ${label}`)
      await until(() => state.registrations.find((registration) => registration.callbackToken === button.callback_data))
      return update(
        {
          callback_query: {
            id: `cq-${id ?? updateId + 1}`,
            from: { id: 42 },
            message: { message_id: message.messageId, chat: { id: 100 } },
            data: button.callback_data,
          },
        },
        id,
      )
    },
    waitMessage: (match: RegExp, afterId = 0) =>
      until(() =>
        network.getState().telegramMessages.find((msg) => msg.messageId > afterId && match.test(msg.text ?? "")),
      ),
    /** Waits for the real workflow to finish, rather than assuming the final HTTP request means completion. */
    waitStatus: async (domain: string, expected = "complete") => {
      const instance = await until(() => state.started.find((item) => item.domain === domain))
      while (Date.now() < deadline) {
        if (state.failures.length) throw new Error(state.failures.join("; "))
        const status = (await (
          await runtime.dispatchFetch(`https://kipp.test/__test/status?domain=${domain}&id=${instance.id}`)
        ).json()) as { status: string; error?: unknown }
        if (status.status === expected) return
        if (status.status === "errored") throw new Error(`Workflow errored: ${JSON.stringify(status.error)}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error("Workflow completion budget exceeded")
    },
    dispose: async () => {
      clearTimeout(timer)
      abort.abort()
      await runtime.dispose()
      if (persistence) await rm(persistence, { recursive: true, force: true })
    },
  }
}

/** Formats scripted responses exactly as the production DeepSeek client receives them. */
export function toolResponse(name: string, input: unknown): WireBody {
  // Legacy scripted drafts omit timing; production/Luna must supply the required schema field.
  if (name === "submit_note") input = { timing: { kind: "unchanged" }, ...(input as WireBody) }
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [
            { id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(input) } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  }
}
