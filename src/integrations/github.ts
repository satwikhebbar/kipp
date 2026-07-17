const GITHUB_API = "https://api.github.com"

export class GithubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "GithubError"
  }
}

export interface GithubFile {
  content: string
  sha: string
}

export interface GithubClient {
  readFile(path: string): Promise<GithubFile>
  writeFile(path: string, content: string, sha?: string): Promise<void>
  mutateFile(path: string, mutate: (content: string) => string): Promise<void>
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function b64decode(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
}

export function createGitHubClient(env: {
  GITHUB_PAT: string
  DATA_REPO_OWNER: string
  DATA_REPO_NAME: string
}): GithubClient {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.GITHUB_PAT}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "kipp-workflow",
  }

  function url(path: string) {
    return `${GITHUB_API}/repos/${env.DATA_REPO_OWNER}/${env.DATA_REPO_NAME}/contents/${path}`
  }

  async function fetchWithRetry(req: () => Promise<Response>, retries = 2): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await req()
      if (res.ok || attempt >= retries || res.status < 500) return res
    }
  }

  async function readFile(path: string): Promise<GithubFile> {
    const res = await fetchWithRetry(() => fetch(url(path), { headers }))
    if (!res.ok) {
      const body = await res.text()
      throw new GithubError(res.status, `GitHub read ${path} error ${res.status}: ${body}`)
    }
    const data = (await res.json()) as { content: string; sha: string }
    return { content: b64decode(data.content), sha: data.sha }
  }

  async function writeFile(path: string, content: string, sha?: string): Promise<void> {
    const body: Record<string, unknown> = { message: `update ${path}`, content: b64encode(content) }
    if (sha) body.sha = sha
    const res = await fetchWithRetry(() =>
      fetch(url(path), {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    if (!res.ok) {
      const text = await res.text()
      throw new GithubError(res.status, `GitHub write ${path} error ${res.status}: ${text}`)
    }
  }

  async function mutateFile(path: string, mutate: (content: string) => string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { content, sha } = await readFile(path)
      const newContent = mutate(content)
      if (newContent === content) return
      try {
        await writeFile(path, newContent, sha)
        return
      } catch (err) {
        if (err instanceof GithubError && err.status === 409 && attempt < 2) continue
        throw err
      }
    }
  }

  return { readFile, writeFile, mutateFile }
}
