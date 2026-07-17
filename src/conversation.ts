import type { LLMMessage } from "./providers/llm"

export const STEP_OUTPUT_BYTE_LIMIT = 900 * 1024

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

export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

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

export function appendAssistant(messages: LLMMessage[], content: string): LLMMessage[] {
  return [...messages, { role: "assistant", content }]
}

export function appendHumanFeedback(messages: LLMMessage[], feedback: string): LLMMessage[] {
  return [...messages, { role: "user", content: feedback }]
}
