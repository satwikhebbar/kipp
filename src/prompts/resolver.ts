import { type GithubClient, GithubError } from "../integrations/github"

export async function readPrompt(client: GithubClient, path: string, fallback: string): Promise<string> {
  try {
    const { content } = await client.readFile(path)
    return content
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return fallback
    throw err
  }
}
