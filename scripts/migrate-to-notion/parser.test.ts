import { describe, expect, it } from "vitest"
import {
  isIdeaStart,
  parseIdea,
  parseIdeas,
  parseYamlLine,
  serializeIdea,
} from "./parser"
const RAW_IDEA = `---
id: 1
title: A test idea
status: raw
source: telegram
created: 2026-07-01T12:00:00Z
---

# Idea 1

This is a raw idea captured via Telegram.`

const DRAFTED_IDEA = `---
id: 5
title: Substack teaser
status: drafted
source: substack
created: 2026-07-03T09:00:00Z
substackUrl: https://example.substack.com/p/test
teaser: A compelling teaser
---

# Idea 5

Body content here.

## Draft

This is the LLM-generated draft.

## Critique

- [x] Clarity: Clear and concise
- [ ] Hook: Needs a stronger opening`

const AWAITING_FEEDBACK_IDEA = `---
id: 10
title: Post about X
status: awaiting-feedback
source: substack
created: 2026-07-05T09:00:00Z
correlation:
  telegramChatId: "12345"
  botMessageId: 42
  workflowInstanceId: wf_abc123
---

# Idea 10

Post content.`

const ZERO_COST_IDEA = `---
id: 99
title: Zero input cost
status: raw
source: manual
created: 2026-07-01T12:00:00Z
costInputTokens: "0"
costOutputTokens: "5"
costModel: deepseek-v4-flash
---

Zero cost body.`

const EXPIRED_IDEA = `---
id: 12
title: Expired post
status: awaiting-feedback-expired
source: substack
created: 2026-07-06T09:00:00Z
---

# Idea 12

This feedback window expired.`

const FINALIZED_IDEA = `---
id: 15
title: Published post
status: finalized
source: substack
created: 2026-07-07T09:00:00Z
---

# Idea 15

This one was published.`

const SKIPPED_IDEA = `---
id: 3
title: Skipped idea
status: skipped
source: manual
created: 2026-07-02T10:00:00Z
---

# Idea 3

Not worth posting.`

const ALL_IDEAS = [RAW_IDEA, DRAFTED_IDEA, AWAITING_FEEDBACK_IDEA, EXPIRED_IDEA, FINALIZED_IDEA, SKIPPED_IDEA]

describe("parseIdea", () => {
  it("parses raw status", () => {
    const idea = parseIdea(RAW_IDEA)
    expect(idea.id).toBe("1")
    expect(idea.status).toBe("raw")
    expect(idea.source).toBe("telegram")
  })

  it("parses drafted status with substack fields", () => {
    const idea = parseIdea(DRAFTED_IDEA)
    expect(idea.id).toBe("5")
    expect(idea.status).toBe("drafted")
    expect(idea.source).toBe("substack")
    expect(idea.substackUrl).toBe("https://example.substack.com/p/test")
    expect(idea.teaser).toBe("A compelling teaser")
    expect(idea.draft).toBe("This is the LLM-generated draft.")
  })

  it("parses awaiting-feedback with correlation", () => {
    const idea = parseIdea(AWAITING_FEEDBACK_IDEA)
    expect(idea.status).toBe("awaiting-feedback")
    expect(idea.correlation).toBeDefined()
    expect(idea.correlation?.telegramChatId).toBe("12345")
    expect(idea.correlation?.botMessageId).toBe(42)
    expect(idea.correlation?.workflowInstanceId).toBe("wf_abc123")
  })

  it("parses awaiting-feedback-expired", () => {
    const idea = parseIdea(EXPIRED_IDEA)
    expect(idea.status).toBe("awaiting-feedback-expired")
  })

  it("parses finalized", () => {
    const idea = parseIdea(FINALIZED_IDEA)
    expect(idea.status).toBe("finalized")
  })

  it("parses skipped", () => {
    const idea = parseIdea(SKIPPED_IDEA)
    expect(idea.status).toBe("skipped")
    expect(idea.source).toBe("manual")
  })
})

const MULTILINE_DRAFT_IDEA = `---
id: 8
title: Multiline draft
status: awaiting-feedback
source: telegram
created: 2026-07-13T12:00:00Z
---

Original body text here.

## Draft

First paragraph of draft.

Second paragraph of draft.

Third paragraph.`

const DRAFT_WITH_HORIZONTAL_RULE = `---
id: 9
title: Post with --- in draft
status: drafted
source: substack
created: 2026-07-14T12:00:00Z
substackUrl: https://example.substack.com/p/test-hr
teaser: Draft containing HR
---

# Idea 9

Preamble text.

## Draft

Option 1: "Some quote here."

Option 2: "Another quote."

---

Here's the deeper insight.

---

That's how you learn.

## Critique

- [x] Good hook
- [ ] Needs stronger conclusion`

describe("serializeIdea roundtrip", () => {
  const cases = [
    RAW_IDEA,
    DRAFTED_IDEA,
    AWAITING_FEEDBACK_IDEA,
    EXPIRED_IDEA,
    FINALIZED_IDEA,
    SKIPPED_IDEA,
    MULTILINE_DRAFT_IDEA,
    DRAFT_WITH_HORIZONTAL_RULE,
    ZERO_COST_IDEA,
  ]

  for (const input of cases) {
    it(`roundtrips idea ${parseIdea(input).id}`, () => {
      const idea = parseIdea(input)
      const serialized = serializeIdea(idea)
      const reparsed = parseIdea(serialized)
      expect(reparsed).toEqual(idea)
    })
  }
})

it("correctly extracts multiline draft from body", () => {
  const idea = parseIdea(MULTILINE_DRAFT_IDEA)
  expect(idea.body).toBe("Original body text here.")
  expect(idea.draft).toBe("First paragraph of draft.\n\nSecond paragraph of draft.\n\nThird paragraph.")
  expect(idea.body).not.toContain("First paragraph")
})

describe("parseIdeas / serializeIdeas", () => {
  it("parses multiple ideas from a full file", () => {
    const file = ALL_IDEAS.join("\n")
    const ideas = parseIdeas(file)
    expect(ideas).toHaveLength(6)
    expect(ideas.map((i) => i.id)).toEqual(["1", "5", "10", "12", "15", "3"])
  })
})

it("parseIdeas handles --- in draft body without corrupting adjacent ideas", () => {
  const file = `${RAW_IDEA}\n${DRAFT_WITH_HORIZONTAL_RULE}\n${SKIPPED_IDEA}`
  const ideas = parseIdeas(file)
  expect(ideas).toHaveLength(3)
  expect(ideas[0].id).toBe("1")
  expect(ideas[1].id).toBe("9")
  expect(ideas[1].draft).toContain("---")
  expect(ideas[1].draft).toContain("Option 1")
  expect(ideas[1].draft).toContain("That's how you learn")
  expect(ideas[2].id).toBe("3")
})

describe("duplicate ID handling", () => {
  it("parseIdeas returns both entries when IDs are duplicated", () => {
    const dup = `${RAW_IDEA}\n${RAW_IDEA}`
    const ideas = parseIdeas(dup)
    expect(ideas).toHaveLength(2)
    expect(ideas[0].id).toBe("1")
    expect(ideas[1].id).toBe("1")
  })

  it("serializeIdea roundtrips duplicate IDs", () => {
    const ideas = parseIdeas(`${RAW_IDEA}\n${RAW_IDEA}`)
    const serialized = ideas.map((idea) => serializeIdea(idea)).join("\n")
    const reparsed = parseIdeas(serialized)
    expect(reparsed).toHaveLength(2)
  })
})

describe("parseYamlLine", () => {
  it("parses key: value", () => {
    expect(parseYamlLine("foo: bar")).toEqual(["foo", "bar"])
  })

  it("strips quotes from value", () => {
    expect(parseYamlLine('foo: "bar"')).toEqual(["foo", "bar"])
  })

  it("handles colon in value", () => {
    expect(parseYamlLine("url: https://example.com/path")).toEqual(["url", "https://example.com/path"])
  })

  it("returns null for non-matching line", () => {
    expect(parseYamlLine("not a key value pair")).toBeNull()
  })

  it("returns null for empty line", () => {
    expect(parseYamlLine("")).toBeNull()
  })

  it("returns null for comment line", () => {
    expect(parseYamlLine("# comment")).toBeNull()
  })

  it("trims leading whitespace", () => {
    expect(parseYamlLine("  key: value")).toEqual(["key", "value"])
  })
})

describe("isIdeaStart", () => {
  it("detects --- followed by a yaml key", () => {
    expect(isIdeaStart(["---", "id: 1"], 0)).toBe(true)
  })

  it("detects --- followed by indented yaml key", () => {
    expect(isIdeaStart(["---", "  correlation:"], 0)).toBe(true)
  })

  it("returns false for --- followed by non-key text", () => {
    expect(isIdeaStart(["---", "body text"], 0)).toBe(false)
  })

  it("returns false at a non --- line", () => {
    expect(isIdeaStart(["some text", "---"], 0)).toBe(false)
  })

  it("returns false for --- at end of file", () => {
    expect(isIdeaStart(["---"], 0)).toBe(false)
  })

  it("returns false for --- with missing next line", () => {
    expect(isIdeaStart(["---", undefined as unknown as string], 0)).toBe(false)
  })
})
