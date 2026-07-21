import { describe, expect, it } from "vitest"
import { nextId } from "../backlog/id-generator"
import { parseIdea, parseIdeas, serializeIdea, serializeIdeas } from "../backlog/parser"

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
reviewCount: 2
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

const ZERO_REVIEW_COUNT_IDEA = `---
id: 100
title: Zero review count
status: awaiting-feedback
source: manual
created: 2026-07-01T12:00:00Z
reviewCount: "0"
---

Zero review count body.`

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
    expect(idea.reviewCount).toBe(2)
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
    ZERO_REVIEW_COUNT_IDEA,
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

  it("serializeIdeas roundtrips all statuses", () => {
    const ideas = parseIdeas(ALL_IDEAS.join("\n"))
    const serialized = serializeIdeas(ideas)
    const reparsed = parseIdeas(serialized)
    expect(reparsed).toEqual(ideas)
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

  it("serializeIdeas preserves duplicate IDs", () => {
    const ideas = parseIdeas(`${RAW_IDEA}\n${RAW_IDEA}`)
    const serialized = serializeIdeas(ideas)
    const reparsed = parseIdeas(serialized)
    expect(reparsed).toHaveLength(2)
  })
})

describe("nextId", () => {
  it("returns max + 1", () => {
    const ideas = parseIdeas(ALL_IDEAS.join("\n"))
    expect(nextId(ideas)).toBe(16)
  })

  it("returns 1 for empty list", () => {
    expect(nextId([])).toBe(1)
  })
})
