import { type GithubClient, GithubError } from "../integrations/github"
import { HTTP_STATUS } from "../runtime/http"

/** Reads the first existing prompt file from a list of paths, falling back to a default. */
export async function readPrompt(client: GithubClient, paths: string[], fallback: string): Promise<string> {
  for (const path of paths) {
    try {
      const { content } = await client.readFile(path)
      return content
    } catch (err) {
      if (err instanceof GithubError && err.status === HTTP_STATUS.NOT_FOUND) continue
      throw err
    }
  }
  return fallback
}
