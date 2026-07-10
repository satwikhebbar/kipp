import { describe, expect, it } from "vitest"
import type { ArchivedIdea, ChecklistItem, ClassificationResult, Idea, LLMResponse, WorkflowEvent } from "../types"

describe("types", () => {
  it("Idea can be instantiated", () => {
    const idea: Idea = {
      id: "001",
      title: "Test",
      status: "raw",
      created: "2026-07-10",
      source: "telegram",
      body: "hello",
    }
    expect(idea.status).toBe("raw")
  })

  it("ArchivedIdea can be instantiated", () => {
    const archived: ArchivedIdea = {
      id: "001",
      title: "Test",
      finalized: "2026-07-10",
      linkedinUrl: "https://linkedin.com",
      linkedinUrn: "urn:li:share:123",
      draftText: "content",
      totalTokens: 500,
      revisionCount: 2,
    }
    expect(archived.totalTokens).toBe(500)
  })

  it("LLMResponse carries usage breakdown", () => {
    const resp: LLMResponse = {
      text: "hello",
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
    }
    expect(resp.usage.reasoningTokens).toBe(5)
  })

  it("ClassificationResult supports approve and feedback", () => {
    const approve: ClassificationResult = { action: "approve", feedbackText: null }
    const feedback: ClassificationResult = { action: "feedback", feedbackText: "too long" }
    expect(approve.action).toBe("approve")
    expect(feedback.feedbackText).toBe("too long")
  })

  it("ChecklistItem has nullable feedback", () => {
    const passed: ChecklistItem = { check: "Length", passed: true, feedback: null }
    const failed: ChecklistItem = { check: "Length", passed: false, feedback: "too long" }
    expect(passed.feedback).toBeNull()
    expect(failed.feedback).toBe("too long")
  })

  it("WorkflowEvent carries telegram reply data", () => {
    const event: WorkflowEvent = {
      type: "telegram-reply",
      userId: 12345,
      text: "looks good",
    }
    expect(event.type).toBe("telegram-reply")
  })
})
