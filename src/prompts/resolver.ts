import { type GithubClient, GithubError } from "../integrations/github"
import { HTTP_STATUS } from "../runtime/http"

export type PromptResolution = {
  content: string
  source: string
  sha?: string
}

/** Reads the first existing prompt file and reports the exact source used, falling back to the bundled default. */
export async function resolvePrompt(
  client: GithubClient,
  paths: string[],
  fallback: string,
): Promise<PromptResolution> {
  for (const path of paths) {
    try {
      const { content, sha } = await client.readFile(path)
      return { content, source: path, sha }
    } catch (err) {
      if (err instanceof GithubError && err.status === HTTP_STATUS.NOT_FOUND) continue
      throw err
    }
  }
  return { content: fallback, source: "built-in default" }
}

/** Reads the first existing prompt file from a list of paths, falling back to a default. */
export async function readPrompt(client: GithubClient, paths: string[], fallback: string): Promise<string> {
  return (await resolvePrompt(client, paths, fallback)).content
}
