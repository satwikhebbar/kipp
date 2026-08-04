import { describe, expect, it, vi } from "vitest"
import { GithubError } from "../integrations/github"
import { readPrompt, resolvePrompt } from "../linkedin/prompts/resolver"

function mockClient(get: (path: string) => { content: string; sha: string } | Error) {
  return {
    readFile: vi.fn(async (path: string) => {
      const result = get(path)
      if (result instanceof Error) throw result
      return result
    }),
    writeFile: vi.fn(),
    mutateFile: vi.fn(),
  }
}

describe("readPrompt", () => {
  it("returns content from the first path that exists", async () => {
    const client = mockClient((path) => {
      if (path === "custom/style.md") return { content: "Custom", sha: "s1" }
      throw new GithubError(404, "not found")
    })
    const result = await readPrompt(client, ["custom/style.md", "style-prompt.md"], "fallback")
    expect(result).toBe("Custom")
    expect(client.readFile).toHaveBeenCalledTimes(1)
  })

  it("tries the second path when the first is 404", async () => {
    const client = mockClient((path) => {
      if (path === "style-prompt.md") return { content: "Default in repo", sha: "s1" }
      throw new GithubError(404, "not found")
    })
    const result = await readPrompt(client, ["custom/style.md", "style-prompt.md"], "fallback")
    expect(result).toBe("Default in repo")
    expect(client.readFile).toHaveBeenCalledTimes(2)
  })

  it("returns the fallback when all paths are 404", async () => {
    const client = mockClient(() => {
      throw new GithubError(404, "not found")
    })
    const result = await readPrompt(client, ["custom/style.md", "style-prompt.md"], "bundled fallback")
    expect(result).toBe("bundled fallback")
    expect(client.readFile).toHaveBeenCalledTimes(2)
  })

  it("propagates non-404 errors without falling back", async () => {
    const client = mockClient(() => {
      throw new GithubError(500, "server error")
    })
    await expect(readPrompt(client, ["custom/style.md", "style-prompt.md"], "fallback")).rejects.toThrow(GithubError)
    expect(client.readFile).toHaveBeenCalledTimes(1)
  })

  it("works with a single-element paths array", async () => {
    const client = mockClient((path) => {
      if (path === "only-path.md") return { content: "Found", sha: "s1" }
      throw new GithubError(404, "not found")
    })
    const result = await readPrompt(client, ["only-path.md"], "fallback")
    expect(result).toBe("Found")
  })

  it("returns fallback with an empty paths array", async () => {
    const client = mockClient(() => {
      throw new Error("should not be called")
    })
    const result = await readPrompt(client, [], "fallback")
    expect(result).toBe("fallback")
    expect(client.readFile).not.toHaveBeenCalled()
  })
})

describe("resolvePrompt", () => {
  it("reports the path and GitHub version of the selected prompt", async () => {
    const client = mockClient((path) => {
      if (path === "style-prompt.md") return { content: "Current instructions", sha: "abc123" }
      throw new GithubError(404, "not found")
    })

    await expect(resolvePrompt(client, ["custom.md", "style-prompt.md"], "fallback")).resolves.toEqual({
      content: "Current instructions",
      source: "style-prompt.md",
      sha: "abc123",
    })
  })

  it("identifies the bundled default when no repository prompt exists", async () => {
    const client = mockClient(() => {
      throw new GithubError(404, "not found")
    })

    await expect(resolvePrompt(client, ["style-prompt.md"], "fallback")).resolves.toEqual({
      content: "fallback",
      source: "built-in default",
    })
  })
})
