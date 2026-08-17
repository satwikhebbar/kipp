import { vi } from "vitest"
import { claimInstanceId } from "../core/idea-ingest"
import { CONSUMED_INTERACTION_RETENTION_MS } from "../core/interaction-router"
import { type Env, INTERACTION_KIND, type WorkflowInteractionKind } from "../core/types"
import { createNotionClient } from "../integrations/notion"
import { createIdeaManager, type IdeaInput } from "../linkedin/ideas/manager"

export interface FakeNotionPage {
  pageId: string
  kippId: number
  title: string
  status: string
  source: string
  markdown: string
  chatId?: string
  substackUrl?: string
  substackBody?: string
  idempotencyKey?: string
}

export interface FakeState {
  githubFiles: Map<string, string>
  notionPages: Map<string, FakeNotionPage>
  telegramMessages: Array<{ chatId: number | string; text: string; replyMarkup?: Record<string, unknown> }>
  answeredCallbacks: string[]
  linkedinDrafts: Array<{ authorUrn: string; text: string }>
  linkedinUrls: string[]
  nextMessageId: number
}

export interface FakeNetworkConfig {
  githubFiles?: Record<string, string>
  notionPages?: FakeNotionPage[]
  llmResponses?: unknown[]
  rssFeedUrl?: string
  rssFeedXml?: string
}

export interface FakeNetwork {
  fetch: typeof globalThis.fetch
  getState: () => FakeState
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function respond(body: unknown, status = 200) {
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Map(),
  }
}

function notionPageJson(p: FakeNotionPage) {
  const properties: Record<string, unknown> = {
    "Kipp ID": { unique_id: { prefix: null, number: p.kippId } },
    Status: { status: { name: p.status } },
    Source: { select: { name: p.source } },
    Title: { title: [{ type: "text", text: { content: p.title } }] },
  }
  if (p.chatId) properties["Chat ID"] = { rich_text: [{ type: "text", text: { content: p.chatId } }] }
  if (p.substackUrl) properties["Substack URL"] = { url: p.substackUrl }
  if (p.substackBody) properties["Substack Body"] = { rich_text: [{ type: "text", text: { content: p.substackBody } }] }
  if (p.idempotencyKey)
    properties["Idempotency Key"] = { rich_text: [{ type: "text", text: { content: p.idempotencyKey } }] }
  return {
    object: "page",
    id: p.pageId,
    created_time: "2026-07-01T12:00:00Z",
    last_edited_time: "2026-07-02T12:00:00Z",
    properties,
  }
}

export function createFakeNetwork(config?: FakeNetworkConfig): FakeNetwork {
  const state: FakeState = {
    githubFiles: new Map(Object.entries(config?.githubFiles ?? {})),
    notionPages: new Map((config?.notionPages ?? []).map((page) => [page.pageId, { ...page }])),
    telegramMessages: [],
    answeredCallbacks: [],
    linkedinDrafts: [],
    linkedinUrls: [],
    nextMessageId: 100,
  }
  const llmResponses = config?.llmResponses ?? []

  if (!state.githubFiles.has("style-prompt.md")) {
    state.githubFiles.set("style-prompt.md", "Professional tone.")
  }

  let llmCallIndex = 0

  const fetch = vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url

    if (urlStr.includes("api.notion.com")) {
      if (urlStr.endsWith("/query")) {
        const body = JSON.parse((opts?.body as string) ?? "{}") as {
          filter?: {
            property?: string
            status?: { equals?: string }
            url?: { equals?: string }
            rich_text?: { equals?: string }
          }
          sorts?: Array<{ property?: string; direction?: string }>
        }
        let results = [...state.notionPages.values()]
        const filter = body.filter
        if (filter?.property === "Status") results = results.filter((p) => p.status === filter.status?.equals)
        if (filter?.property === "Substack URL") results = results.filter((p) => p.substackUrl === filter.url?.equals)
        if (filter?.property === "Idempotency Key")
          results = results.filter((p) => p.idempotencyKey === filter.rich_text?.equals)
        if (body.sorts?.[0]?.property === "Kipp ID") results = results.sort((a, b) => a.kippId - b.kippId)
        return respond({ object: "list", results: results.map(notionPageJson), has_more: false, next_cursor: null })
      }

      if (urlStr === "https://api.notion.com/v1/pages" && opts?.method === "POST") {
        const body = JSON.parse(opts.body as string) as {
          properties: Record<
            string,
            {
              title?: Array<{ text: { content: string } }>
              status?: { name?: string }
              select?: { name?: string }
              rich_text?: Array<{ text: { content: string } }>
              url?: string
            }
          >
          markdown?: string
        }
        const nextKippId = Math.max(0, ...[...state.notionPages.values()].map((p) => p.kippId)) + 1
        const page: FakeNotionPage = {
          pageId: `page_${nextKippId}`,
          kippId: nextKippId,
          title: body.properties.Title?.title?.[0]?.text?.content ?? "",
          status: body.properties.Status?.status?.name ?? "raw",
          source: body.properties.Source?.select?.name ?? "manual",
          markdown: body.markdown ?? "",
          chatId: body.properties["Chat ID"]?.rich_text?.[0]?.text?.content,
          substackUrl: body.properties["Substack URL"]?.url,
          substackBody: body.properties["Substack Body"]?.rich_text?.[0]?.text?.content,
          idempotencyKey: body.properties["Idempotency Key"]?.rich_text?.[0]?.text?.content,
        }
        state.notionPages.set(page.pageId, page)
        return respond(notionPageJson(page))
      }

      const markdown = urlStr.match(/\/v1\/pages\/([^/]+)\/markdown$/)
      if (markdown) {
        const page = state.notionPages.get(markdown[1])
        if (!page) return respond({ message: "object_not_found" }, 404)
        if (opts?.method === "PATCH") {
          const body = JSON.parse(opts.body as string) as { replace_content?: { new_str?: string } }
          if (body.replace_content?.new_str !== undefined) page.markdown = body.replace_content.new_str
        }
        return respond({
          object: "page_markdown",
          id: page.pageId,
          markdown: page.markdown,
          truncated: false,
          unknown_block_ids: [],
        })
      }

      const pageMatch = urlStr.match(/\/v1\/pages\/([^/]+)$/)
      if (pageMatch) {
        const page = state.notionPages.get(pageMatch[1])
        if (!page) return respond({ message: "object_not_found" }, 404)
        if (opts?.method === "PATCH") {
          const body = JSON.parse(opts.body as string) as {
            properties: Record<
              string,
              {
                status?: { name?: string }
                title?: Array<{ text: { content: string } }>
                rich_text?: Array<{ text: { content: string } }>
              }
            >
          }
          const props = body.properties ?? {}
          if (props.Status) page.status = props.Status.status?.name ?? page.status
          if (props.Title) page.title = props.Title.title?.[0]?.text?.content ?? page.title
          if (props["Chat ID"]) page.chatId = props["Chat ID"].rich_text?.[0]?.text?.content
        }
        return respond(notionPageJson(page))
      }
    }

    if (urlStr.includes("api.github.com/repos/")) {
      const match = urlStr.match(/\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)/)
      if (!match) return respond({ message: "not found" }, 404)
      const [, , , path] = match

      if (opts?.method === "PUT") {
        const parsed = JSON.parse(opts.body as string)
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(parsed.content), (c) => c.charCodeAt(0)))
        state.githubFiles.set(path, decoded)
        return respond({ content: { sha: "new-sha" } })
      }

      if (!state.githubFiles.has(path)) {
        return respond({ message: "Not Found" }, 404)
      }
      const fileContent = state.githubFiles.get(path)
      return respond({ content: b64encode(fileContent ?? ""), sha: "sha1" })
    }

    if (urlStr.includes("api.telegram.org/bot")) {
      const parsed = JSON.parse(opts?.body as string) as Record<string, unknown>
      if (urlStr.includes("/answerCallbackQuery")) {
        state.answeredCallbacks.push(parsed.callback_query_id as string)
        return respond({ ok: true })
      }
      const msg = {
        chatId: (parsed.chat_id ?? parsed.chatId) as number | string,
        text: parsed.text as string,
        replyMarkup: parsed.reply_markup as Record<string, unknown> | undefined,
      }
      state.telegramMessages.push(msg)
      const mid = state.nextMessageId++
      return respond({ ok: true, result: { message_id: mid } })
    }

    if (urlStr.includes("api.linkedin.com")) {
      state.linkedinUrls.push(urlStr)
      const parsed = opts?.body ? (JSON.parse(opts.body as string) as Record<string, unknown>) : {}
      const authorUrn = (parsed.author as string) ?? ""
      const text =
        ((
          (parsed.specificContent as Record<string, unknown>)?.["com.linkedin.ugc.ShareContent"] as Record<
            string,
            unknown
          >
        )?.shareCommentary as Record<string, unknown>) ?? {}
      state.linkedinDrafts.push({ authorUrn, text: (text as Record<string, unknown>).text as string })
      return respond({ id: "urn:li:ugcPost:fake" }, 201)
    }

    if (urlStr.includes("api.deepseek.com")) {
      const response = llmResponses[llmCallIndex++] ?? {
        choices: [{ message: { content: "Default response" } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }
      return respond(response)
    }

    if (config?.rssFeedUrl && urlStr.includes(config.rssFeedUrl)) {
      return respond(config.rssFeedXml ?? "<?xml version='1.0'?><rss><channel></channel></rss>")
    }

    throw new Error(`Unexpected fetch: ${opts?.method ?? "GET"} ${urlStr}`)
  })

  return { fetch: fetch as unknown as typeof globalThis.fetch, getState: () => state }
}

/** Builds a base Env with fake bindings; overrides may supply per-test values. */
export function createBaseEnv(overrides?: Partial<Env>): Env {
  const env = {
    GITHUB_PAT: "pat",
    DATA_REPO_OWNER: "o",
    DATA_REPO_NAME: "r",
    TELEGRAM_BOT_TOKEN: "bot:token",
    TELEGRAM_WEBHOOK_SECRET: "my-secret",
    TELEGRAM_ALLOWED_USER_ID: "",
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
    LINKEDIN_ACCESS_TOKEN: "",
    LINKEDIN_AUTHOR_URN: "",
    LLM_API_KEY: "key",
    LLM_PROVIDER: "deepseek",
    POSTING_CADENCE_DAYS: "7",
    SUBSTACK_RSS_URL: "",
    WAIT_FOR_FEEDBACK_HOURS: "168",
    NOTION_API_KEY: "secret",
    NOTION_IDEAS_DATA_SOURCE_ID: "ds-1",
    NOTION_FREE_TIER: "false",
    TOKEN_VAULT: {} as never,
    INTERACTION_ROUTER: createFakeInteractionRouter().namespace,
    PIPELINE_WORKFLOW: {} as never,
    ...overrides,
  } as never as Env
  env.IDEA_INGEST = createFakeIdeaIngest(env)
  return env
}

export function createFakeStep() {
  const calledSteps: string[] = []
  const stepDo = vi.fn(async (_name: string, fn: () => unknown) => {
    calledSteps.push(_name)
    return fn()
  })
  const waitForEvent = vi.fn()

  return {
    do: stepDo,
    waitForEvent,
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
    getCalledSteps: () => [...calledSteps],
  }
}

export function createFakeWorkflowBinding() {
  const created: Array<{ id: string; params: unknown }> = []
  const receivedEvents: Array<{ instanceId: string; event: unknown }> = []
  let idCounter = 0

  const create = vi.fn(async (params: unknown) => {
    const id = `wf-${++idCounter}`
    created.push({ id, params })
    return { id }
  })

  const createBatch = vi.fn(async (items: Array<{ id: string; params: unknown }>) => {
    const createdNow: Array<{ id: string; params: unknown }> = []
    for (const item of items) {
      // Cloudflare Workflows createBatch is idempotent: skip ids already
      // present (including earlier in this batch) and return only new ones.
      if (created.some((existing) => existing.id === item.id) || createdNow.some((existing) => existing.id === item.id))
        continue
      created.push(item)
      createdNow.push(item)
    }
    return createdNow
  })

  const get = vi.fn((instanceId: string) => ({
    sendEvent: vi.fn((event: unknown) => {
      receivedEvents.push({ instanceId, event })
    }),
  }))

  return {
    create,
    createBatch,
    get,
    getCreated: () => [...created],
    getReceivedEvents: () => [...receivedEvents],
    reset: () => {
      created.length = 0
      receivedEvents.length = 0
      idCounter = 0
      create.mockClear()
      createBatch.mockClear()
      get.mockClear()
    },
  }
}

/**
 * In-memory stand-in for the IdeaIngest Durable Object namespace, faithful to
 * the real adopt-or-create ingest and deterministic workflow-start semantics.
 */
export function createFakeIdeaIngest(env: Env): DurableObjectNamespace {
  const storage = new Map<string, unknown>()
  const manager = () => createIdeaManager(createNotionClient(env))
  const namespace = {
    idFromName: (name: string) => name as never,
    get: (_id: { toString: () => string }) => ({
      fetch: async (url: string | Request, init?: RequestInit) => {
        const path = new URL(typeof url === "string" ? url : url.url).pathname
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>

        if (path === "/ingest") {
          const { key, idea, startWorkflow } = body as {
            key: string
            idea: IdeaInput
            startWorkflow?: boolean
          }
          const record = storage.get(`ingest:${key}`) as { pageId: string; ideaId: string } | undefined
          let pageId: string
          let ideaId: string
          if (record) {
            pageId = record.pageId
            ideaId = record.ideaId
          } else {
            const created = await manager().createIdea({ ...idea, idempotencyKey: key })
            pageId = created.pageId
            ideaId = created.id
            storage.set(`ingest:${key}`, { pageId, ideaId })
          }
          let workflowInstanceId: string | undefined
          let alreadyStarted: boolean | undefined
          if (startWorkflow) {
            const started = await namespace.get({ toString: () => `claim:${pageId}` }).fetch("http://ingest/start", {
              method: "POST",
              body: JSON.stringify({ pageId, ideaId, source: idea.source }),
            })
            const result = (await started.json()) as { workflowInstanceId: string; alreadyStarted: boolean }
            workflowInstanceId = result.workflowInstanceId
            alreadyStarted = result.alreadyStarted
          }
          return Response.json({ pageId, ideaId, workflowInstanceId, alreadyStarted })
        }

        if (path === "/start") {
          const { pageId, ideaId, source } = body as { pageId: string; ideaId: string; source: string }
          const instanceId = await claimInstanceId(pageId)
          const claimKey = `claim:${pageId}`
          const record = storage.get(claimKey) as { status: string; instanceId?: string } | undefined
          if (!record || record.status === "unstarted") {
            const created = await env.PIPELINE_WORKFLOW.createBatch([
              { id: instanceId, params: { pageId, ideaId, source } },
            ])
            storage.set(claimKey, { status: "started", instanceId })
            return Response.json({ workflowInstanceId: instanceId, alreadyStarted: created.length === 0 })
          }
          return Response.json({ workflowInstanceId: record.instanceId ?? instanceId, alreadyStarted: true })
        }

        return new Response("Not found", { status: 404 })
      },
    }),
  }
  return namespace as unknown as DurableObjectNamespace
}

const REVISION_FEEDBACK_KIND = INTERACTION_KIND.REVISION_FEEDBACK
const PLAIN_TEXT_INTERACTION_KINDS = new Set<string>([
  REVISION_FEEDBACK_KIND,
  INTERACTION_KIND.CALENDAR_CLARIFICATION,
  INTERACTION_KIND.CALENDAR_CONFLICT_REPLACE,
  INTERACTION_KIND.CALENDAR_RECURRENCE_NEW_TIME,
  INTERACTION_KIND.CALENDAR_EDIT_FEEDBACK,
])

export interface FakeInteractionRegistration {
  interactionId: string
  version: number
  workflowId: string
  kind: WorkflowInteractionKind
  callbackToken?: string
  botMessageId?: number
  expiresAt?: number
  interactionGroup?: string
}

export interface FakeInteractionRouter {
  namespace: DurableObjectNamespace
  register(chatId: number | string, registration: FakeInteractionRegistration): void
}

export function createFakeInteractionRouter(): FakeInteractionRouter {
  type RouterRecord = {
    interactionId: string
    version: number
    workflowId: string
    kind: string
    callbackToken?: string
    botMessageId?: number
    expiresAt: number
    interactionGroup?: string
    consumed?: number
    consumedAt?: number
  }
  const records = new Map<string, RouterRecord[]>()
  const register = (chatId: number | string, registration: FakeInteractionRegistration) => {
    const chat = `telegram-chat:${chatId}`
    const list = records.get(chat) ?? []
    if (registration.kind === REVISION_FEEDBACK_KIND) {
      for (const item of list) if (item.kind === REVISION_FEEDBACK_KIND && !item.consumed) item.consumed = -1
    }
    if (registration.interactionGroup) {
      for (const item of list) {
        if (
          item.interactionGroup === registration.interactionGroup &&
          item.version < registration.version &&
          !item.consumed
        )
          item.consumed = -1
      }
    }
    list.push({ ...registration, expiresAt: registration.expiresAt ?? Date.now() + 60_000 })
    records.set(chat, list)
  }
  const namespace = {
    idFromName: (name: string) => name as never,
    get: (id: { toString?: () => string } | string) => ({
      fetch: async (url: string | Request, init?: RequestInit) => {
        const chat = typeof id === "string" ? id : (id.toString?.() ?? "")
        const now = Date.now()
        const list = (records.get(chat) ?? []).filter(
          (item) =>
            item.expiresAt > now && (!item.consumedAt || item.consumedAt > now - CONSUMED_INTERACTION_RETENTION_MS),
        )
        records.set(chat, list)
        const path = new URL(typeof url === "string" ? url : url.url).pathname
        const body = JSON.parse(init?.body as string) as Record<string, unknown>
        if (path === "/register") {
          const registration = body as unknown as RouterRecord
          if (registration.kind === REVISION_FEEDBACK_KIND) {
            for (const item of list) if (item.kind === REVISION_FEEDBACK_KIND && !item.consumed) item.consumed = -1
          }
          if (registration.interactionGroup) {
            for (const item of list) {
              if (
                item.interactionGroup === registration.interactionGroup &&
                item.version < registration.version &&
                !item.consumed
              )
                item.consumed = -1
            }
          }
          list.push(registration)
          return Response.json({ ok: true })
        }
        const found = body.callbackToken
          ? list.find((item) => item.callbackToken === body.callbackToken)
          : body.replyToMessageId !== undefined
            ? list.find((item) => item.botMessageId === body.replyToMessageId)
            : [...list].reverse().find((item) => PLAIN_TEXT_INTERACTION_KINDS.has(item.kind) && !item.consumed)
        if (!found) return Response.json({ interaction: null })
        if (found.expiresAt <= Date.now() || found.consumed) return Response.json({ interaction: null })
        found.consumed = body.telegramUpdateId as number
        found.consumedAt = now
        return Response.json({
          interaction: {
            ...found,
            telegramUpdateId: body.telegramUpdateId,
            ...(body.text !== undefined ? { text: body.text } : {}),
          },
        })
      },
    }),
  } as unknown as DurableObjectNamespace
  return { namespace, register }
}
