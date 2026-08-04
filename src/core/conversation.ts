import type { LLMMessage } from "../providers/llm"

export const STEP_OUTPUT_BYTE_LIMIT = 921_600 // ponytail: 900 KiB

export class TranscriptTooLargeError extends Error {
  constructor(
    message: string,
    readonly measuredBytes: number,
    readonly limitBytes: number,
  ) {
    super(message)
    this.name = "TranscriptTooLargeError"
  }
}

/** Returns the JSON-serialized byte length of a value. */
export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

/** Throws if the serialized value meets or exceeds the step output byte limit. */
export function assertStepOutputSize<T>(value: T, limit = STEP_OUTPUT_BYTE_LIMIT): T {
  const bytes = serializedByteLength(value)
  if (bytes >= limit) {
    throw new TranscriptTooLargeError(
      `Workflow step output is ${bytes} bytes, exceeds limit of ${limit} bytes. Reduce transcript size before returning from the step.`,
      bytes,
      limit,
    )
  }
  return value
}

/** Appends an assistant message to the conversation. */
export function appendAssistant(messages: LLMMessage[], content: string): LLMMessage[] {
  return [...messages, { role: "assistant", content }]
}

/** Appends a human feedback message to the conversation. */
export function appendHumanFeedback(messages: LLMMessage[], feedback: string): LLMMessage[] {
  return [...messages, { role: "user", content: feedback }]
}
