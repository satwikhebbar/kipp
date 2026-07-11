import { beforeEach, describe, expect, it, vi } from "vitest"
import { createGitHubClient, GithubError } from "../integrations/github"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

const ENV = { GITHUB_PAT: "pat", DATA_REPO_OWNER: "o", DATA_REPO_NAME: "r" }

describe("createGitHubClient", () => {
  beforeEach(() => mockFetch.mockReset())

  it("readFile decodes base64 content", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: b64("hello"), sha: "s1" }),
    })
    const { content, sha } = await createGitHubClient(ENV).readFile("ideas.md")
    expect(content).toBe("hello")
    expect(sha).toBe("s1")
  })

  it("readFile throws GithubError on non-ok", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("not found"),
    })
    await expect(createGitHubClient(ENV).readFile("x.md")).rejects.toThrow(GithubError)
  })

  it("writeFile sends base64 content", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    await createGitHubClient(ENV).writeFile("ideas.md", "hello", "s1")
    const call = mockFetch.mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(body.content).toBe(b64("hello"))
    expect(body.sha).toBe("s1")
  })

  it("writeFile throws GithubError on non-ok", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("validation error"),
    })
    await expect(createGitHubClient(ENV).writeFile("x.md", "x", "s1")).rejects.toThrow(GithubError)
  })

  it("mutateFile retries on 409 and succeeds", async () => {
    let putCount = 0
    mockFetch.mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") {
        putCount++
        if (putCount === 1) {
          return { ok: false, status: 409, text: () => Promise.resolve("Conflict") }
        }
      }
      return {
        ok: true,
        json: () => Promise.resolve({ content: b64("original"), sha: "sha1" }),
      }
    })
    await createGitHubClient(ENV).mutateFile("ideas.md", () => "updated")
    expect(putCount).toBe(2)
  })

  it("mutateFile throws after exhausting retries", async () => {
    mockFetch.mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") {
        return { ok: false, status: 409, text: () => Promise.resolve("Conflict") }
      }
      return {
        ok: true,
        json: () => Promise.resolve({ content: b64("original"), sha: "sha1" }),
      }
    })
    await expect(createGitHubClient(ENV).mutateFile("ideas.md", () => "x")).rejects.toThrow(GithubError)
  })

  it("mutateFile returns early if content unchanged", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: b64("same"), sha: "s1" }),
    })
    await createGitHubClient(ENV).mutateFile("ideas.md", (c) => c)
    // Only one GET call, no PUT
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("handles large payload without crashing", async () => {
    const large = "x".repeat(200_000)
    mockFetch.mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === "PUT") {
        const body = JSON.parse(opts.body as string)
        expect(body.content).toBe(b64(large))
        return { ok: true, json: () => Promise.resolve({}) }
      }
      return {
        ok: true,
        json: () => Promise.resolve({ content: b64(large), sha: "s1" }),
      }
    })
    await createGitHubClient(ENV).mutateFile("ideas.md", () => large)
  })
})
