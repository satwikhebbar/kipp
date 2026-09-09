import type { WorkflowStep } from "cloudflare:workers"
import { createTelegramClient } from "../integrations/telegram"
import { logRuntime } from "../runtime/logging"
import { createInteractionRouter, type InteractionRegistration } from "./interaction-router-client"
import type { Env, WorkflowInteractionKind } from "./types"

export type ActionPromptOutcome =
  | { type: "timeout" }
  | { type: "action"; kind: WorkflowInteractionKind; actionIndex: number }
  | { type: "reply"; text: string }

export type ActionPromptStage = "notify" | "register" | "wait"

/** Signals which durable interaction operation failed so a caller can re-notify without repeating the write. */
export class ActionPromptOperationError extends Error {
  constructor(readonly stage: ActionPromptStage) {
    super("Action prompt operation failed")
    this.name = "ActionPromptOperationError"
  }
}

export interface ActionPromptOptions {
  env: Env
  step: WorkflowStep
  instanceId: string
  chatId: number | string
  version: number
  /** Base step name; `-notify`, `-register`, and `-wait` steps are derived from it. */
  name: string
  message: string
  actions: Array<[string, WorkflowInteractionKind]>
  /** Sends an inline keyboard when true, a force-reply prompt otherwise. */
  keyboard?: boolean
  /** Registration expiry in milliseconds from when the prompt is sent. */
  ttlMs: number
  interactionGroup?: string
  /** Enforced only for multi-action inline keyboards. */
  maxLabelChars?: number
  /** Runtime event name used when an interaction operation fails. */
  logEventName?: string
}

/**
 * Registers fixed actions on Telegram, waits once for a routed reply, and
 * distinguishes callbacks from free text. Free-text replies are matched only
 * when no registered action kind is unique to that text, so callers must rely
 * on the returned `type` rather than assuming a button was tapped.
 */
export async function promptForActions(options: ActionPromptOptions): Promise<ActionPromptOutcome> {
  const {
    env,
    step,
    instanceId,
    chatId,
    version,
    name,
    message,
    actions,
    keyboard = true,
    ttlMs,
    interactionGroup,
    maxLabelChars = 16,
    logEventName = "workflow-interaction",
  } = options
  if (keyboard && actions.length > 1 && actions.some(([label]) => label.length > maxLabelChars))
    throw new Error(`Action labels must be at most ${maxLabelChars} characters`)
  let stage: ActionPromptStage = "notify"
  const prepared = actions.map(([label, kind]) => ({
    label,
    kind,
    interactionId: crypto.randomUUID(),
    callbackToken: keyboard ? crypto.randomUUID() : undefined,
  }))
  try {
    const sent = await step.do(`${name}-notify`, () =>
      createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(
        chatId,
        message,
        keyboard
          ? {
              replyMarkup: {
                inline_keyboard: [
                  prepared
                    .filter((action) => action.callbackToken)
                    .map((action) => ({ text: action.label, callback_data: action.callbackToken })),
                ],
              },
            }
          : { replyMarkup: { force_reply: true } },
      ),
    )
    stage = "register"
    await step.do(`${name}-register`, async () => {
      const router = createInteractionRouter(env.INTERACTION_ROUTER, chatId)
      await Promise.all(
        prepared.map((action) =>
          router.register({
            interactionId: action.interactionId,
            version,
            workflowId: instanceId,
            kind: action.kind,
            callbackToken: action.callbackToken,
            botMessageId: sent.messageId,
            expiresAt: Date.now() + ttlMs,
            ...(interactionGroup ? { interactionGroup } : {}),
          } satisfies InteractionRegistration),
        ),
      )
    })
    stage = "wait"
    const reply = await step.waitForEvent<{ text?: string; interactionId?: string }>(`${name}-wait`, {
      type: "telegram-reply",
      timeout: "15 minutes" as never,
    })
    if (reply.type === "timeout") return { type: "timeout" }
    const text = reply.payload?.text
    if (!text) return { type: "timeout" }
    const matchedIndex = prepared.findIndex(
      (action) =>
        action.callbackToken &&
        (action.interactionId === reply.payload?.interactionId ||
          (text === `__${action.kind}__` &&
            prepared.filter((candidate) => candidate.kind === action.kind).length === 1)),
    )
    return matchedIndex >= 0
      ? { type: "action", kind: prepared[matchedIndex]?.kind as WorkflowInteractionKind, actionIndex: matchedIndex }
      : { type: "reply", text }
  } catch {
    logRuntime(env, {
      workflow: instanceId,
      event: logEventName,
      outcome: "failed",
      failureCategory: "interaction-operation-failed",
      details: { stage, version },
    })
    throw new ActionPromptOperationError(stage)
  }
}
