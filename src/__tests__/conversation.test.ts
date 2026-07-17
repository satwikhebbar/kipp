import { describe, expect, it } from "vitest"
import {
  appendAssistant,
  appendHumanFeedback,
  assertStepOutputSize,
  STEP_OUTPUT_BYTE_LIMIT,
  serializedByteLength,
  TranscriptTooLargeError,
} from "../conversation"
import type { LLMMessage } from "../providers/llm"

describe("serializedByteLength", () => {
  it("returns UTF-8 byte length of JSON-serialized input", () => {
    expect(serializedByteLength("a")).toBe(3) // "a" = 3 bytes
    expect(serializedByteLength("é")).toBe(4) // "é" = 1+2+1 bytes
    expect(serializedByteLength("😀")).toBe(6) // "😀" = 1+4+1 bytes
  })
})

describe("assertStepOutputSize", () => {
  it("passes through value below limit", () => {
    const value = { draft: "d", messages: [{ role: "user", content: "u" }], chatId: "42" }
    const out = assertStepOutputSize(value)
    expect(out).toBe(value)
  })

  it("rejects a value at/over the configured limit without modifying input", () => {
    const big = "x".repeat(64)
    const value = { draft: big, messages: [{ role: "user", content: big }], chatId: big }
    const limit = serializedByteLength(value) // exact size
    expect(() => assertStepOutputSize(value, limit)).toThrow(TranscriptTooLargeError)
    expect(() => assertStepOutputSize(value, limit)).toThrow(/exceeds limit/)
  })

  it("default limit is the conservative 900 KiB threshold", () => {
    expect(STEP_OUTPUT_BYTE_LIMIT).toBe(900 * 1024)
  })
})

describe("appendAssistant / appendHumanFeedback", () => {
  it("appendAssistant returns a new array with assistant message at end", () => {
    const base: LLMMessage[] = [{ role: "system", content: "s" }]
    const out = appendAssistant(base, "draft text")
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ role: "assistant", content: "draft text" })
    expect(base).toHaveLength(1)
  })

  it("appendHumanFeedback returns a new array with user message at end", () => {
    const base: LLMMessage[] = [{ role: "assistant", content: "draft" }]
    const out = appendHumanFeedback(base, "make it shorter")
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ role: "user", content: "make it shorter" })
  })
})
