import type { WorkflowInteraction, WorkflowInteractionKind } from "./types"

export interface InteractionRegistration {
  interactionId: string
  version: number
  workflowId: string
  kind: WorkflowInteractionKind
  callbackToken?: string
  botMessageId?: number
  expiresAt: number
  interactionGroup?: string
}

export interface RoutedInteraction extends WorkflowInteraction {
  workflowId: string
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
    register: (registration: InteractionRegistration) => post<{ ok: boolean }>("/register", registration),
    resolve: (input: InteractionResolveInput) => post<{ interaction: RoutedInteraction | null }>("/resolve", input),
  }
}
