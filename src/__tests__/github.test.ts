import { describe, expect, it, vi } from "vitest"
import type { GithubClient, GithubFile } from "../integrations/github"

function mockClient(): {
  client: GithubClient
  files: Map<string, { content: string; sha: string }>
  log: string[]
} {
  const files = new Map<string, { content: string; sha: string }>()
  const log: string[] = []

  files.set("ideas.md", {
    content: "---\nid: 1\ntitle: Test\nstatus: raw\ncreated: now\nsource: manual\n---\n\nbody",
    sha: "abc",
  })
  files.set("archive.md", { content: "", sha: "def" })

  const client: GithubClient = {
    async readFile(path: string): Promise<GithubFile> {
      const f = files.get(path)
      if (!f) throw Object.assign(new Error(`Not found`), { status: 404 })
      log.push(`read:${path}`)
      return f
    },
    async writeFile(path: string, content: string, sha: string): Promise<void> {
      const f = files.get(path)
      if (!f) throw Object.assign(new Error(`Not found`), { status: 404 })
      if (f.sha !== sha && sha !== "force") {
        const err: Error & { status?: number } = new Error(`Conflict on ${path}`)
        err.status = 409
        throw err
      }
      log.push(`write:${path}`)
      files.set(path, { content, sha: `sha${Math.random()}` })
    },
    async mutateFile(path: string, mutate: (c: string) => string): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        const { content, sha } = await client.readFile(path)
        const newContent = mutate(content)
        if (newContent === content) return
        try {
          await client.writeFile(path, newContent, sha)
          return
        } catch (err: unknown) {
          const e = err as Error & { status?: number }
          if (e.status === 409 && attempt < 2) continue
          throw err
        }
      }
    },
  }

  return { client, files, log }
}

describe("GithubClient mutateFile", () => {
  it("retries on 409 and succeeds", async () => {
    const { client, files, log } = mockClient()
    let call = 0
    const origWrite = client.writeFile.bind(client)
    vi.spyOn(client, "writeFile").mockImplementation(async (path, content, sha) => {
      call++
      if (call === 1) {
        const f = files.get(path) as { content: string; sha: string }
        files.set(path, { ...f, sha: "stale" })
      }
      return origWrite(path, content, sha)
    })

    await client.mutateFile("ideas.md", () => "new content")
    expect(call).toBeGreaterThanOrEqual(2)
    expect(log.filter((l) => l.startsWith("write:"))).toHaveLength(1)
    const saved = files.get("ideas.md") as { content: string; sha: string }
    expect(saved.content).toBe("new content")
  })

  it("throws on non-409 error", async () => {
    const { client } = mockClient()
    vi.spyOn(client, "readFile").mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }))

    await expect(client.mutateFile("ideas.md", () => "x")).rejects.toThrow("Not found")
  })

  it("does not write if mutate returns same content", async () => {
    const { client } = mockClient()
    vi.spyOn(client, "writeFile")

    await client.mutateFile("ideas.md", (c) => c)
    expect(client.writeFile).not.toHaveBeenCalled()
  })
})

describe("GithubClient readFile", () => {
  it("throws 404 for missing file", async () => {
    const { client } = mockClient()
    await expect(client.readFile("nonexistent.md")).rejects.toThrow()
  })
})

describe("GithubClient writeFile", () => {
  it("throws on sha mismatch", async () => {
    const { client } = mockClient()
    await expect(client.writeFile("ideas.md", "x", "wrong-sha")).rejects.toThrow("Conflict")
  })
})
