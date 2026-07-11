import { describe, expect, it } from "vitest"
import { createBacklogManager } from "../backlog/manager"
import type { GithubFile } from "../integrations/github"

const RAW_IDEA = `---
id: 1
title: A test idea
status: raw
source: telegram
created: 2026-07-01T12:00:00Z
---

# Idea 1

This is a raw idea.`

const EXISTING_ARCHIVE = `---
id: 5
title: Old post
status: finalized
source: substack
created: 2026-07-02T09:00:00Z
---

# Idea 5

Already archived.`

function mockClient() {
  const files = new Map<string, { content: string; sha: string }>()

  function readFile(path: string): Promise<GithubFile> {
    const f = files.get(path)
    if (!f) return Promise.reject(Object.assign(new Error("Not found"), { status: 404 }))
    return Promise.resolve(f)
  }

  function writeFile(path: string, content: string, _sha: string): Promise<void> {
    files.set(path, { content, sha: `sha${Math.random()}` })
    return Promise.resolve()
  }

  async function mutateFile(path: string, mutate: (c: string) => string): Promise<void> {
    const { content } = await readFile(path)
    const newContent = mutate(content)
    if (newContent !== content) {
      await writeFile(path, newContent, "")
    }
  }

  return {
    client: { readFile, writeFile, mutateFile },
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

    it("does not duplicate existing archive entries", async () => {
      const m = mockClient()
      m.setIdeas(RAW_IDEA)
      m.setArchive(EXISTING_ARCHIVE)
      const mgr = createBacklogManager(m.client)

      const raw = await mgr.getNextIdea()
      if (!raw) throw new Error("Expected an idea")
      await mgr.moveToArchive(raw)
      await mgr.moveToArchive(raw)

      const archived = await m.client.readFile("archive.md")
      const idCount = archived.content.match(/id: 1/g)?.length ?? 0
      expect(idCount).toBe(1)
    })
  })
})
