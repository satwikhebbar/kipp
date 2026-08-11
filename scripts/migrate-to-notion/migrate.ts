import { fileURLToPath } from "node:url"
import { createGitHubClient } from "../../src/integrations/github"
import { createNotionClient } from "../../src/integrations/notion"
import { createIdeaManager, type IdeaManager } from "../../src/linkedin/ideas/manager"
import { type LegacyIdea, parseIdeas } from "./parser"

const LEGACY_PREFIXES = { "ideas.md": "legacy:backlog:", "archive.md": "legacy:archive:" } as const

export interface MigrationConfig {
  GITHUB_PAT: string
  DATA_REPO_OWNER: string
  DATA_REPO_NAME: string
  NOTION_API_KEY: string
  NOTION_IDEAS_DATA_SOURCE_ID: string
}

export interface MigrationReport {
  created: number
  skipped: number
  total: number
  failures: Array<{ key: string; error: string }>
}

/** Migrates one legacy file's ideas into Notion, keyed by its legacy idempotency prefix. */
export async function migrateFile(
  manager: IdeaManager,
  client: ReturnType<typeof createGitHubClient>,
  file: "ideas.md" | "archive.md",
): Promise<{ created: number; skipped: number; failures: Array<{ key: string; error: string }> }> {
  const prefix = LEGACY_PREFIXES[file]
  const { content } = await client.readFile(file)
  const ideas = parseIdeas(content)
  const report = { created: 0, skipped: 0, failures: [] as Array<{ key: string; error: string }> }
  for (const idea of ideas) {
    const key = `${prefix}${idea.id}`
    try {
      const existing = await manager.findByIdempotencyKey(key)
      if (existing) {
        report.skipped++
        continue
      }
      await manager.createIdea({
        title: idea.title,
        status: idea.status,
        source: idea.source,
        body: idea.body,
        substackUrl: idea.substackUrl,
        chatId: idea.correlation?.telegramChatId,
        idempotencyKey: key,
      })
      report.created++
    } catch (err) {
      report.failures.push({ key, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}

/** Runs the full one-time migration: reads ideas.md and archive.md, then creates missing Notion pages. */
export async function runMigration(config: MigrationConfig): Promise<MigrationReport> {
  const github = createGitHubClient(config)
  const notion = createNotionClient({
    NOTION_API_KEY: config.NOTION_API_KEY,
    NOTION_IDEAS_DATA_SOURCE_ID: config.NOTION_IDEAS_DATA_SOURCE_ID,
    NOTION_FREE_TIER: "false",
  })
  const manager = createIdeaManager(notion)

  const reports = await Promise.all([
    migrateFile(manager, github, "ideas.md"),
    migrateFile(manager, github, "archive.md"),
  ])
  return reports.reduce<MigrationReport>(
    (acc, report) => ({
      created: acc.created + report.created,
      skipped: acc.skipped + report.skipped,
      total: acc.total + report.created + report.skipped + report.failures.length,
      failures: [...acc.failures, ...report.failures],
    }),
    { created: 0, skipped: 0, total: 0, failures: [] },
  )
}

/** Reads the migration configuration from the process environment. */
function envConfig(env: NodeJS.ProcessEnv): MigrationConfig {
  const required = [
    "GITHUB_PAT",
    "DATA_REPO_OWNER",
    "DATA_REPO_NAME",
    "NOTION_API_KEY",
    "NOTION_IDEAS_DATA_SOURCE_ID",
  ] as const
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`)
  }
  return {
    GITHUB_PAT: env.GITHUB_PAT as string,
    DATA_REPO_OWNER: env.DATA_REPO_OWNER as string,
    DATA_REPO_NAME: env.DATA_REPO_NAME as string,
    NOTION_API_KEY: env.NOTION_API_KEY as string,
    NOTION_IDEAS_DATA_SOURCE_ID: env.NOTION_IDEAS_DATA_SOURCE_ID as string,
  }
}

export async function main(): Promise<void> {
  const config = envConfig(process.env)
  const report = await runMigration(config)
  console.log(JSON.stringify(report, null, 2))
  if (report.failures.length > 0) process.exitCode = 1
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
