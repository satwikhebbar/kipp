import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { GithubClient, GithubFile } from "../integrations/github"
import { cleanupArchive } from "../linkedin/backlog/archive"
import { createBacklogManager } from "../linkedin/backlog/manager"

const RAW_IDEA = `---
id: 1
title: A test idea
status: raw
source: telegram
created: 2026-07-01T12:00:00Z
---

# Idea 1

This is a raw idea.`

function mockClient() {
  const files = new Map<string, { content: string; sha: string }>()

  const client: GithubClient = {
    async readFile(path: string): Promise<GithubFile> {
      const f = files.get(path)
      if (!f) return Promise.reject(Object.assign(new Error("Not found"), { status: 404 }))
      return Promise.resolve(f)
    },
    async writeFile(path: string, content: string, _sha: string): Promise<void> {
      files.set(path, { content, sha: `sha${Math.random()}` })
    },
    async mutateFile(path: string, mutate: (c: string) => string): Promise<void> {
      const { content } = await client.readFile(path)
      const newContent = mutate(content)
      if (newContent !== content) {
        await client.writeFile(path, newContent, "")
      }
    },
  }

  return {
    client,
    files,
    setIdeas(content: string) {
      files.set("ideas.md", { content, sha: "s1" })
    },
    setArchive(content: string) {
      files.set("archive.md", { content, sha: "s2" })
    },
  }
}

describe("createBacklogManager", () => {
  describe("getNextIdea", () => {
    it("returns null when no raw ideas exist", async () => {
      const m = mockClient()
      m.setIdeas("---\nid: 1\ntitle: Done\nstatus: finalized\ncreated: now\nsource: manual\n---\n\ndone")
      const mgr = createBacklogManager(m.client)
      expect(await mgr.getNextIdea()).toBeNull()
    })

    it("returns the oldest raw idea", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      const mgr = createBacklogManager(m.client)
      const idea = await mgr.getNextIdea()
      expect(idea).not.toBeNull()
      expect(idea?.id).toBe("1")
    })
  })

  describe("getIdeasByStatus", () => {
    it("filters by status", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      const mgr = createBacklogManager(m.client)
      const raw = await mgr.getIdeasByStatus("raw")
      expect(raw).toHaveLength(1)
      const finalized = await mgr.getIdeasByStatus("finalized")
      expect(finalized).toHaveLength(0)
    })
  })

  describe("updateIdea", () => {
    it("updates idea fields", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      const mgr = createBacklogManager(m.client)
      await mgr.updateIdea("1", { status: "drafted", draft: "New draft" })
      const ideas = await mgr.readIdeas()
      expect(ideas[0].status).toBe("drafted")
      expect(ideas[0].draft).toBe("New draft")
    })

    it("throws for unknown id", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      const mgr = createBacklogManager(m.client)
      await expect(mgr.updateIdea("99", { status: "finalized" })).rejects.toThrow("not found")
    })
  })

  describe("moveToArchive", () => {
    it("preserves full idea metadata in archive", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      m.setArchive("")
      const mgr = createBacklogManager(m.client)

      const raw = await mgr.getNextIdea()
      if (!raw) throw new Error("Expected an idea")
      await mgr.moveToArchive(raw)

      const ideas = await mgr.readIdeas()
      expect(ideas).toHaveLength(0)

      const archived = await m.client.readFile("archive.md")
      expect(archived.content).toContain("id: 1")
      expect(archived.content).toContain("title: A test idea")
      expect(archived.content).toContain("status: finalized")
      expect(archived.content).toContain("source: telegram")
      expect(archived.content).toContain("# Idea 1")
      expect(archived.content).toContain("This is a raw idea")
    })

    it("rethrows non-not-found errors from updateIdea", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      m.setArchive("")
      const mgr = createBacklogManager(m.client)
      // replace writeFile to inject a 409 after status update
      const origWrite = m.client.writeFile
      m.client.writeFile = vi.fn().mockImplementation(async (path, content, sha) => {
        if (content.includes("finalized")) {
          const err: Error & { status?: number } = new Error("Conflict")
          err.status = 409
          throw err
        }
        return origWrite(path, content, sha)
      }) as typeof m.client.writeFile

      const raw = await mgr.getNextIdea()
      if (!raw) throw new Error("Expected an idea")
      await expect(mgr.moveToArchive(raw)).rejects.toThrow("Conflict")
    })

    it("does not duplicate an already archived idea id", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      m.setArchive("")
      const mgr = createBacklogManager(m.client)

      const raw = await mgr.getNextIdea()
      if (!raw) throw new Error("Expected an idea")
      await mgr.moveToArchive(raw)
      await mgr.moveToArchive(raw)

      const archived = await m.client.readFile("archive.md")
      const idCount = archived.content.match(/id: 1/g)?.length ?? 0
      expect(idCount).toBe(1)
    })

    it("archives multiline draft without leaking into body", async () => {
      const m = mockClient()
      m.setIdeas(`---
id: 9
title: Multiline draft
status: drafted
source: telegram
created: 2026-07-13T12:00:00Z
---

Original body.

## Draft

Paragraph one.

Paragraph two.

Paragraph three.`)
      m.setArchive("")
      const mgr = createBacklogManager(m.client)

      const idea = (await mgr.readIdeas())[0]
      await mgr.moveToArchive(idea)

      const archived = await m.client.readFile("archive.md")
      expect(archived.content).toContain("Original body.")
      expect(archived.content).toContain("Paragraph one.")
      expect(archived.content).toContain("Paragraph two.")
      expect(archived.content).toContain("Paragraph three.")
      expect(archived.content).toContain("## Draft")

      // Roundtrip the archived entry
      const entries = (await import("../linkedin/backlog/parser")).parseIdeas(archived.content)
      expect(entries).toHaveLength(1)
      expect(entries[0].body).toBe("Original body.")
      expect(entries[0].draft).toBe("Paragraph one.\n\nParagraph two.\n\nParagraph three.")
      expect(entries[0].body).not.toContain("Paragraph")
    })
  })

  describe("appendToArchive invariants", () => {
    it("always sets finalized status regardless of input status", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      m.setArchive("")
      const mgr = createBacklogManager(m.client)

      const raw = await mgr.getNextIdea()
      if (!raw) throw new Error("Expected an idea")
      await mgr.moveToArchive(raw)

      const archived = await m.client.readFile("archive.md")
      expect(archived.content).toContain("status: finalized")
      expect(archived.content).not.toContain("status: raw")
    })

    it("appends to archive without removing content from previous entries", async () => {
      const m = mockClient()
      m.setArchive("")
      const mgr = createBacklogManager(m.client)

      for (let i = 0; i < 3; i++) {
        const idea = {
          id: String(i + 1),
          title: `Idea ${i + 1}`,
          status: "raw" as const,
          source: "manual" as const,
          created: "2026-07-01T12:00:00Z",
          body: `Body ${i + 1}`,
        }
        m.setIdeas(
          `---\nid: ${i + 1}\ntitle: Idea ${i + 1}\nstatus: raw\nsource: manual\ncreated: 2026-07-01T12:00:00Z\n---\n\nBody ${i + 1}`,
        )
        await mgr.moveToArchive(idea)
      }

      const archived = await m.client.readFile("archive.md")
      const entries = (await import("../linkedin/backlog/parser")).parseIdeas(archived.content)
      expect(entries).toHaveLength(3)
      expect(entries.map((e) => e.body)).toEqual(["Body 1", "Body 2", "Body 3"])
    })
  })

  describe("moveToArchive only removes target", () => {
    it("leaves other ideas in ideas.md untouched", async () => {
      const m = mockClient()
      m.setIdeas(`---
id: 1
title: First
status: raw
source: manual
created: 2026-07-01T12:00:00Z
---

Body 1
---
id: 2
title: Second
status: awaiting-feedback
source: manual
created: 2026-07-02T12:00:00Z
---

Body 2
---
id: 3
title: Third
status: raw
source: manual
created: 2026-07-03T12:00:00Z
---

Body 3`)
      m.setArchive("")
      const mgr = createBacklogManager(m.client)

      const target = (await mgr.readIdeas()).find((i) => i.id === "2")
      if (!target) throw new Error("Expected idea 2")
      await mgr.moveToArchive(target)

      const remaining = await mgr.readIdeas()
      expect(remaining.map((i) => i.id)).toEqual(["1", "3"])
      expect(remaining.every((i) => i.status !== "finalized")).toBe(true)
    })
  })

  describe("updateIdea replaces without duplicates", () => {
    it("does not append when updating an existing idea", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      const mgr = createBacklogManager(m.client)

      await mgr.updateIdea("1", { status: "drafted", draft: "A draft" })

      const ideas = await mgr.readIdeas()
      expect(ideas).toHaveLength(1)
      expect(ideas[0].status).toBe("drafted")

      // Also verify raw file has only one entry
      const file = await m.client.readFile("ideas.md")
      const reparsed = (await import("../linkedin/backlog/parser")).parseIdeas(file.content)
      expect(reparsed).toHaveLength(1)
    })
  })

  describe("updateIdea multiline draft", () => {
    it("preserves full multiline draft on update", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      const mgr = createBacklogManager(m.client)

      const draft = "Line one.\n\nLine two.\n\nLine three."
      await mgr.updateIdea("1", { draft, status: "awaiting-feedback" })

      const ideas = await mgr.readIdeas()
      expect(ideas[0].draft).toBe(draft)
      expect(ideas[0].body).toBe("# Idea 1\n\nThis is a raw idea.")

      // Verify raw file stores it correctly
      const file = await m.client.readFile("ideas.md")
      const reParsed = (await import("../linkedin/backlog/parser")).parseIdeas(file.content)
      expect(reParsed[0].draft).toBe(draft)
      expect(reParsed[0].body).toBe("# Idea 1\n\nThis is a raw idea.")
      expect(reParsed[0].body).not.toContain("Line one")
    })
  })
})

describe("cleanupArchive", () => {
  const NOW = 1_758_000_000_000
  const DAY = 86_400_000
  const THIRTY_DAYS_AGO = new Date(NOW - 30 * DAY).toISOString()
  const THIRTY_ONE_DAYS_AGO = new Date(NOW - 31 * DAY).toISOString()
  const TWENTY_NINE_DAYS_AGO = new Date(NOW - 29 * DAY).toISOString()

  function entry(id: string, finalized: string | undefined): string {
    return `---
id: ${id}
title: Entry ${id}
status: finalized
source: manual
created: 2026-01-01
finalized: ${finalized ?? ""}
---

Body ${id}
`
  }

  function archiveContent(...entries: string[]): string {
    return entries.join("\n")
  }

  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it("prunes entries older than 30 days", async () => {
    const m = mockClient()
    m.setArchive(archiveContent(entry("old", THIRTY_ONE_DAYS_AGO), entry("recent", TWENTY_NINE_DAYS_AGO)))
    await cleanupArchive(m.client)
    const archived = await m.client.readFile("archive.md")
    expect(archived.content).not.toContain("id: old")
    expect(archived.content).toContain("id: recent")
  })

  it("keeps entry at exactly 30-day boundary", async () => {
    const m = mockClient()
    m.setArchive(archiveContent(entry("boundary", THIRTY_DAYS_AGO)))
    await cleanupArchive(m.client)
    const archived = await m.client.readFile("archive.md")
    expect(archived.content).toContain("id: boundary")
  })

  it("preserves entry without finalized field", async () => {
    const m = mockClient()
    m.setArchive(archiveContent(entry("no-date", undefined)))
    await cleanupArchive(m.client)
    const archived = await m.client.readFile("archive.md")
    expect(archived.content).toContain("id: no-date")
  })

  it("preserves entry with malformed finalized date", async () => {
    const m = mockClient()
    m.setArchive(`---
id: bad
title: Bad date
status: finalized
source: manual
created: 2026-01-01
finalized: not-a-date
---

Body bad
`)
    await cleanupArchive(m.client)
    const archived = await m.client.readFile("archive.md")
    expect(archived.content).toContain("id: bad")
  })

  it("does not mutate archive when nothing to prune", async () => {
    const m = mockClient()
    const content = archiveContent(entry("recent", TWENTY_NINE_DAYS_AGO))
    m.setArchive(content)
    const writeSpy = vi.spyOn(m.client, "writeFile")
    await cleanupArchive(m.client)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it("prunes only old entries leaving multiple intact", async () => {
    const m = mockClient()
    m.setArchive(
      archiveContent(
        entry("a", THIRTY_ONE_DAYS_AGO),
        entry("b", TWENTY_NINE_DAYS_AGO),
        entry("c", THIRTY_ONE_DAYS_AGO),
        entry("d", TWENTY_NINE_DAYS_AGO),
      ),
    )
    await cleanupArchive(m.client)
    const archived = await m.client.readFile("archive.md")
    expect(archived.content).toContain("id: b")
    expect(archived.content).toContain("id: d")
    expect(archived.content).not.toContain("id: a")
    expect(archived.content).not.toContain("id: c")
  })

  it("cleans up when moveToArchive triggers archive of new entry", async () => {
    const m = mockClient()
    m.setIdeas(RAW_IDEA)
    m.setArchive(archiveContent(entry("old", THIRTY_ONE_DAYS_AGO)))
    const mgr = createBacklogManager(m.client)
    const raw = await mgr.getNextIdea()
    if (!raw) throw new Error("Expected an idea")
    await mgr.moveToArchive(raw)
    const archived = await m.client.readFile("archive.md")
    expect(archived.content).not.toContain("id: old")
    expect(archived.content).toContain("id: 1")
  })
})
