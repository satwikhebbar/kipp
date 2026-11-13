import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovedPublication } from "../../notes/types"

type Runtime = { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }

// Faults wrap real storage only in this test entrypoint. No test route or fault flag ships in the Worker.
const entry = `
import { BufferPublicationDO, TokenVaultDO, InteractionRouterDO } from "./src/index.ts";
import { createTokenVault } from "./src/core/token-vault-client.ts";
import { fingerprintCommand } from "./src/notes/review.ts";
function instrument(ctx, fault) {
  let phase, puts = 0;
  const sql = new Proxy(ctx.storage.sql, {get(target,key) {
    if (key === "exec") return (query,...args) => {
      if (query.startsWith("INSERT INTO publication VALUES")) {
        phase = JSON.parse(args[1]).phase;
        if (fault.value === "result-write" && phase === "finished") throw new Error("Injected result transaction failure");
      }
      return target[key](query,...args);
    };
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  }});
  const storage = new Proxy(ctx.storage, {get(target,key) {
    if (key === "sql") return sql;
    if (key === "sync") return async () => {
      await target.sync();
      if ((fault.value === "dispatch-sync" && phase === "dispatching") || (fault.value === "result-sync" && phase === "finished")) throw new Error("Injected lost storage completion");
    };
    if (key === "put") return async (...args) => {
      if (fault.value) puts++;
      if (fault.value === "rotation-write" && puts === 2) throw new Error("Injected replacement write failure");
      await target.put(...args);
      if (fault.value === "refresh-claim" && puts === 1) throw new Error("Injected lost refresh claim completion");
    };
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  }});
  return new Proxy(ctx,{get(target,key) { if(key === "storage") return storage; const value = target[key]; return typeof value === "function" ? value.bind(target) : value; }});
}
export class PublicationProbe extends BufferPublicationDO {
  constructor(ctx,env) { const fault = {value:null}; super(instrument(ctx,fault),env); this.fault = fault; this.storage = ctx.storage; }
  async fetch(request) {
    this.fault.value = request.headers.get("X-Test-Fault");
    if (new URL(request.url).pathname === "/state") return Response.json({
      publications:this.storage.sql.exec("SELECT * FROM publication").toArray(),
      attempts:this.storage.sql.exec("SELECT * FROM attempts ORDER BY ordinal").toArray()
    });
    return super.fetch(request);
  }
}
export class VaultProbe extends TokenVaultDO {
  constructor(ctx,env) { const fault = {value:null}; super(instrument(ctx,fault),env); this.fault = fault; }
  async fetch(request) { this.fault.value = request.headers.get("X-Test-Fault"); return super.fetch(request); }
}
export { InteractionRouterDO };
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if(url.pathname === "/fixture") {
    const input = await request.json();
    const vault = createTokenVault(env);
    await vault.replaceBufferGrant({accessToken:input.accessToken ?? "synthetic-access",refreshToken:input.refreshToken ?? "synthetic-refresh",expiresAtMs:Date.now()+(input.nearExpiry?60000:86400000),accountId:"account",scopes:["account:read","posts:read","posts:write","offline_access"]});
    if(input.nearExpiry || input.grantOnly) return Response.json({ok:true});
    const access = await vault.acquireBufferAccess();
    const command = {destination:{accountId:"account",connectionId:access.connectionId,organizationId:"org",channelId:"channel",service:"substack"},text:"Small releases give feedback a clear target.",attachmentUrl:"https://example.com/article",timing:{kind:"queue"}};
    return Response.json({publicationId:"recovery:v1",workflowId:"recovery",candidateVersion:1,fingerprint:await fingerprintCommand(command),command,deadlineMs:Date.now()+3600000,approval:{userId:"42",chatId:"100",deliveryId:"approval",interactionId:"approve",approvedAtMs:Date.now()}});
  }
  const namespace = url.pathname.startsWith("/vault") ? env.TOKEN_VAULT : url.pathname.startsWith("/router") ? env.INTERACTION_ROUTER : env.BUFFER_PUBLICATIONS;
  const name = namespace === env.TOKEN_VAULT ? "linkedin-token-vault" : namespace === env.INTERACTION_ROUTER ? "telegram-chat:100" : "recovery:v1";
  const path = url.pathname.replace(/^\\/(vault|router|publication)/, "") || "/";
  return namespace.get(namespace.idFromName(name)).fetch(new Request("https://object"+path,{method:request.method,headers:request.headers,body:request.body}));
}};
`

/** Runs production Notes storage owners in fresh workerd processes sharing isolated on-disk SQLite stores. */
export async function createNotesRecovery() {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
  const { build } = runtimeRequire("esbuild")
  const { Miniflare, Response: RuntimeResponse, Log, LogLevel } = runtimeRequire("miniflare")
  const directory = await mkdtemp(join(tmpdir(), "kipp-notes-recovery-"))
  const bundled = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "notes-recovery-entry.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  })
  const calls = { creates: [] as Record<string, unknown>[], refreshTokens: [] as string[] }
  let paused = false
  let rotatedExpiresIn = 86400
  let releaseRefresh: (() => void) | undefined
  let hold: Promise<void> | undefined
  const options = {
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-08",
    log: new Log(LogLevel.NONE),
    durableObjectsPersist: join(directory, "objects"),
    bindings: {
      BUFFER_SUBSTACK_CHANNEL_ID: "channel",
      BUFFER_CLIENT_ID: "synthetic-client",
      BUFFER_CLIENT_SECRET: "synthetic-secret",
      TOKEN_ENCRYPTION_KEY_IDS: "test",
      TOKEN_ENCRYPTION_KEY_test: Buffer.alloc(32, 7).toString("base64url"),
    },
    durableObjects: {
      BUFFER_PUBLICATIONS: { className: "PublicationProbe", useSQLite: true },
      TOKEN_VAULT: { className: "VaultProbe", useSQLite: true },
      INTERACTION_ROUTER: { className: "InteractionRouterDO", useSQLite: true },
    },
    outboundService: async (request: Request) => {
      const url = new URL(request.url)
      if (url.origin === "https://auth.buffer.com" && url.pathname === "/token") {
        calls.refreshTokens.push(new URLSearchParams(await request.text()).get("refresh_token") ?? "missing")
        if (hold) await hold
        return RuntimeResponse.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: rotatedExpiresIn,
          token_type: "bearer",
          scope: "account:read posts:read posts:write offline_access",
        })
      }
      if (url.origin !== "https://api.buffer.com") throw new Error(`Unexpected recovery endpoint: ${url.origin}`)
      const body = (await request.json()) as { query: string; variables: { input: Record<string, unknown> } }
      if (body.query.includes("KippIdentity"))
        return RuntimeResponse.json({ data: { account: { id: "account", organizations: [{ id: "org" }] } } })
      if (body.query.includes("KippChannels"))
        return RuntimeResponse.json({
          data: {
            channels: [
              {
                id: "channel",
                organizationId: "org",
                service: "substack",
                name: "Test",
                allowedActions: ["scheduleUpdates"],
                isQueuePaused: paused,
                isDisconnected: false,
                isLocked: false,
              },
            ],
          },
        })
      if (!body.query.includes("KippCreatePost")) throw new Error("Unexpected Buffer query")
      const input = body.variables.input
      calls.creates.push(input)
      return RuntimeResponse.json({
        data: {
          createPost: {
            __typename: "PostActionSuccess",
            post: {
              id: "post-1",
              channelId: "channel",
              channelService: "substack",
              text: input.text,
              status: "scheduled",
              shareMode: "addToQueue",
              schedulingType: "automatic",
              sharedNow: false,
              isCustomScheduled: false,
              dueAt: "2030-01-01T09:00:00.000Z",
              metadata: { linkAttachment: { url: "https://example.com/article" } },
            },
          },
        },
      })
    },
  }
  let runtime: Runtime = new Miniflare(options)
  const request = (path: string, body: unknown = {}, fault?: string) =>
    runtime.dispatchFetch(`https://recovery.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(fault ? { "X-Test-Fault": fault } : {}) },
      body: JSON.stringify(body),
    })
  return {
    calls,
    request,
    fixture: async () => (await (await request("/fixture")).json()) as ApprovedPublication,
    pauseQueue: (value: boolean) => {
      paused = value
    },
    expireNextRotationSoon: () => {
      rotatedExpiresIn = 60
    },
    /** Holds the provider response while multiple RPC callers join or a newer grant replaces it. */
    holdRefresh: () => {
      hold = new Promise<void>((resolve) => {
        releaseRefresh = resolve
      })
      return () => {
        hold = undefined
        releaseRefresh?.()
      }
    },
    /** Destroys the old V8 runtime; only the persisted SQLite records survive. */
    reboot: async () => {
      await runtime.dispose()
      runtime = new Miniflare(options)
    },
    dispose: async () => {
      releaseRefresh?.()
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
