import type { NotesActionMetadata } from "../notes/router"
import type { NotesInteractionEvent } from "../notes/types"
import type { WorkflowInteraction, WorkflowInteractionKind } from "./types"

export interface InteractionRegistration {
  notes?: NotesActionMetadata
  interactionId: string
  version: number
  workflowId: string
  kind: WorkflowInteractionKind
  callbackToken?: string
  botMessageId?: number
  expiresAt: number
  interactionGroup?: string
  /** Chat-scoped plan-message generation (§6); carries group invalidation when present. */
  generation?: number
  /** Starts a new edit run instead of delivering to a waiting generation run. */
  edit?: { sessionId?: string }
}

export interface RoutedInteraction extends WorkflowInteraction {
  workflowId: string
  edit?: { sessionId?: string }
}

export interface InteractionResolveInput {
  telegramUpdateId: number
  callbackToken?: string
  replyToMessageId?: number
  text?: string
}

/** Creates a client for the per-chat interaction router Durable Object. */
export function createInteractionRouter(namespace: DurableObjectNamespace, chatId: number | string) {
  const stub = namespace.get(namespace.idFromName(`telegram-chat:${chatId}`))
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await stub.fetch(`https://interaction-router${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Interaction router ${path} failed`)
    return response.json() as Promise<T>
  }
  return {
    resolveNotes: (input: InteractionResolveInput & { userId: string; chatId: string; receivedAtMs: number }) =>
      post<{ handled: boolean; event?: NotesInteractionEvent | null }>("/notes/resolve", input),
    acknowledgeNotes: (deliveryId: string) => post<{ ok: boolean }>("/notes/ack", { deliveryId }),
    invalidateNotes: (workflowId: string, version: number) =>
      post<{ ok: boolean }>("/notes/invalidate", { workflowId, version }),
    bindNotes: (interactionId: string, messageId: number) =>
      post<{ ok: boolean }>("/notes/bind", { interactionId, messageId }),
    register: (registration: InteractionRegistration) => post<{ ok: boolean }>("/register", registration),
    resolve: (input: InteractionResolveInput) =>
      post<{ interaction: RoutedInteraction | null; reason?: "expired" | "stale" }>("/resolve", input),
    saveEditContext: (context: EditContextRegistration) => post<{ ok: boolean }>("/edit-context", context),
    editContext: <T>(sessionId: string, userId: string) =>
      post<{ context: T | null; resourceId?: string; expiresAt?: number }>("/edit-context/get", { sessionId, userId }),
    claimEdit: (resourceId: string, workflowId: string, domain: "calendar" | "meal") =>
      post<{ ok: boolean }>("/edit/claim", { resourceId, workflowId, domain }),
    releaseEdit: (resourceId: string, workflowId: string) =>
      post<{ ok: boolean }>("/edit/release", { resourceId, workflowId }),
  }
}

export interface EditContextRegistration {
  sessionId: string
  resourceId: string
  userId: string
  expiresAt: number
  context: unknown
}
