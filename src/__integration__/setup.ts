import { vi } from "vitest"
import { CONSUMED_INTERACTION_RETENTION_MS } from "../interaction-router"
import { INTERACTION_KIND, type WorkflowInteractionKind } from "../types"

export interface FakeState {
  githubFiles: Map<string, string>
  telegramMessages: Array<{ chatId: number | string; text: string; replyMarkup?: Record<string, unknown> }>
  linkedinDrafts: Array<{ authorUrn: string; text: string }>
  linkedinUrls: string[]
  nextMessageId: number
}

export interface FakeNetworkConfig {
  githubFiles?: Record<string, string>
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

export function createFakeNetwork(config?: FakeNetworkConfig): FakeNetwork {
  const state: FakeState = {
    githubFiles: new Map(Object.entries(config?.githubFiles ?? {})),
    telegramMessages: [],
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

  const get = vi.fn((instanceId: string) => ({
    sendEvent: vi.fn((event: unknown) => {
      receivedEvents.push({ instanceId, event })
    }),
  }))

  return {
    create,
    get,
    getCreated: () => [...created],
    getReceivedEvents: () => [...receivedEvents],
    reset: () => {
      created.length = 0
      receivedEvents.length = 0
      idCounter = 0
      create.mockClear()
      get.mockClear()
    },
  }
}

const REVISION_FEEDBACK_KIND = INTERACTION_KIND.REVISION_FEEDBACK

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
            : list.find((item) => item.kind === REVISION_FEEDBACK_KIND && !item.consumed)
        if (!found) return Response.json({ interaction: null })
        if (found.expiresAt <= Date.now() || (found.consumed && found.consumed !== body.telegramUpdateId))
          return Response.json({ interaction: null })
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
