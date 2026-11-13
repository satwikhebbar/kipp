import { type ConversationMessage, presentConversationTurn } from "./conversation-presenter"

/** Semantic controls keep reconnect/resume actions distinct from mutation approval. */
type LinkAction = { intent: "link"; label: string; url: string }
type CallbackAction<Intent extends string> = { intent: Intent; label: string; callbackToken: string }
export type ConnectionAction = LinkAction | CallbackAction<"resume" | "cancel" | "revise">
export type ConversationAction =
  | LinkAction
  | CallbackAction<"approve" | "revise" | "resume" | "cancel" | "select" | "edit">

export type ConversationControls =
  | { kind: "reply" }
  | { kind: "inline"; rows: ReadonlyArray<ReadonlyArray<ConversationAction>> }

type ConnectionControls =
  | { kind: "reply" }
  | {
      kind: "inline"
      rows: ReadonlyArray<ReadonlyArray<ConnectionAction>>
    }

/** Exactly one response purpose; connection guidance cannot carry draft sections or approval. */
export type ConversationTurn =
  | { kind: "connection"; message: string; controls?: ConnectionControls }
  | { kind: "review"; sections: readonly string[]; controls?: ConversationControls }
  | { kind: "clarification" | "confirmation" | "failure"; message: string; controls?: ConversationControls }

/**
 * Reserves one response for one accepted user input, including while delivery is pending.
 * Create the next coordinator only after another accepted interaction (or timeout).
 * Claim outside Workflow checkpoints so replay reconstructs the same exclusivity.
 * Delivery retries belong inside the reserved response's durable operation.
 */
export function createConversationTurn() {
  let claimed: ConversationTurn["kind"] | undefined
  const coordinator = {
    get responded(): boolean {
      return claimed !== undefined
    },
    claim(kind: ConversationTurn["kind"]): void {
      if (claimed) throw new Error(`Conversation turn already reserved for ${claimed}; cannot send ${kind}`)
      claimed = kind
    },
    async respond<T>(
      turn: ConversationTurn,
      deliver: (message: ConversationMessage, index: number) => Promise<T>,
    ): Promise<T[]> {
      coordinator.claim(turn.kind)
      return presentConversationTurn(turn, deliver)
    },
  }
  return coordinator
}

export type ConversationTurnCoordinator = ReturnType<typeof createConversationTurn>
