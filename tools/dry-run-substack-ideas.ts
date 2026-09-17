import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createToolProvider } from "../src/providers"
import { parseSubstackArticle, type SubstackArticle } from "../src/substack/article"
import {
  runSubstackIdeaToolSession,
  type SubstackIdeaCandidate,
  type SubstackIdeaSessionResult,
  selectSubstackIdeas,
} from "../src/substack/idea-agent"
import { parseRssFeed } from "../src/triggers/rss"

const DEFAULT_FEED_URL = "https://satwikhebbar.substack.com/feed"
const DEFAULT_ARTICLE_URLS = [
  "https://satwikhebbar.substack.com/p/the-agentic-leaders-field-guide",
  "https://satwikhebbar.substack.com/p/dealing-with-great-expectations",
  "https://satwikhebbar.substack.com/p/thriving-in-the-age-of-good-enough",
]
const DEFAULT_PROVIDER = "gemini"
const DEFAULT_RETRIES = 3
const REVIEW_DIRECTORY = "tmp/substack-idea-dry-runs"

/** Runs the production extraction path against published RSS source material without mutating Notion, Durable Objects, or Telegram. */
async function main(): Promise<void> {
  const vars = { ...(await readDevVars()), ...process.env }
  const apiKey = vars.LLM_API_KEY
  if (!apiKey) throw new Error("LLM_API_KEY must be set")
  const requestedUrls = process.argv.slice(2)
  const articleUrls = requestedUrls.length > 0 ? requestedUrls : DEFAULT_ARTICLE_URLS
  const feed = await fetch(DEFAULT_FEED_URL)
  if (!feed.ok) throw new Error(`RSS fetch failed (HTTP ${feed.status})`)
  const itemsByUrl = new Map(parseRssFeed(await feed.text()).map((item) => [item.link, item]))
  const provider = createToolProvider(
    apiKey,
    vars.LLM_PROVIDER || DEFAULT_PROVIDER,
    vars.LLM_MODEL,
    Number(vars.LLM_MAX_RETRIES ?? DEFAULT_RETRIES),
  )
  const reviewPath = join(REVIEW_DIRECTORY, `${reviewTimestamp()}.md`)
  const review = [
    "# Substack idea dry run",
    "",
    `Generated ${new Date().toISOString()}. This run made no Notion, Durable Object, or Telegram writes.`,
  ]
  let failedArticleCount = 0

  for (const url of articleUrls) {
    const item = itemsByUrl.get(url)
    if (!item) throw new Error(`Article is not present in ${DEFAULT_FEED_URL}: ${url}`)
    const article = parseSubstackArticle({
      title: item.title,
      subtitle: item.subtitle,
      sourceUrl: item.link,
      contentHtml: item.contentHtml,
    })
    const result = await runSubstackIdeaToolSession(provider, article)
    if (result.terminal) appendArticleReview(review, article, result.terminal.ideas, result)
    else {
      failedArticleCount++
      appendFailedArticleReview(review, article, result)
    }
    console.log(
      JSON.stringify({
        article: article.title,
        sectionCount: article.sections.length,
        parsedCharacters: article.sections.reduce((total, section) => total + section.content.length, 0),
        outcome: result.terminal ? "accepted" : (result.failureReason ?? "unknown"),
        ideaCount: result.terminal?.ideas.length ?? 0,
        ideaTitles: result.terminal?.ideas.map((idea) => idea.title) ?? [],
        providerTurns: result.providerTurns,
        toolCalls: result.toolCallCount,
      }),
    )
  }

  await mkdir(REVIEW_DIRECTORY, { recursive: true })
  await writeFile(reviewPath, `${review.join("\n")}\n`, "utf8")
  console.log(`Wrote candidate review: ${reviewPath}`)
  if (failedArticleCount) process.exitCode = 1
}

/** Adds one article's complete candidates to the local review artifact without changing production data. */
function appendArticleReview(
  review: string[],
  article: SubstackArticle,
  ideas: SubstackIdeaCandidate[],
  result: SubstackIdeaSessionResult,
): void {
  review.push(
    "",
    `## ${article.title}`,
    "",
    `Source: ${article.sourceUrl}`,
    `Parsed: ${article.sections.length} sections; ${article.sections.reduce((total, section) => total + section.content.length, 0)} characters.`,
    `Session: ${result.providerTurns} provider turns; ${result.toolCallCount} tool calls; ${result.toolExecutions.map((execution) => execution.outcome).join(", ")}.`,
  )
  appendRejectedSubmissionFeedback(review, result)
  const selectedIdeas = new Set(selectSubstackIdeas(ideas))

  for (const [index, idea] of ideas.entries()) {
    review.push("", `### ${index + 1}. ${idea.title}`, "", `Virality score: ${idea.viralityScore}/10.`)
    review.push(`Score justification: ${idea.scoreJustification}`)
    review.push(`Selected for saving: ${selectedIdeas.has(idea) ? "yes" : "no"}.`)
    if (idea.context) review.push("", "#### Context", "", idea.context)
    review.push("", "#### Excerpt", "", idea.excerpt)
    review.push("", "#### Core argument", "", idea.coreArgument)
  }
}

/** Records failed submissions too, so a review run remains useful when the bounded session exhausts its budget. */
function appendFailedArticleReview(
  review: string[],
  article: SubstackArticle,
  result: SubstackIdeaSessionResult,
): void {
  review.push(
    "",
    `## ${article.title}`,
    "",
    `Source: ${article.sourceUrl}`,
    `Outcome: no accepted submission (${result.failureReason ?? "unknown"}).`,
    `Session: ${result.providerTurns} provider turns; ${result.toolCallCount} tool calls; ${result.toolExecutions.map((execution) => execution.outcome).join(", ")}.`,
  )
  appendRejectedSubmissionFeedback(review, result)
  review.push("", "#### Unaccepted submission attempts")
  for (const input of submittedIdeaInputs(result)) review.push("", "```json", JSON.stringify(input, null, 2), "```")
}

/** Adds safe ToolGuard feedback for rejected submissions without retaining submitted values or provider prose. */
function appendRejectedSubmissionFeedback(review: string[], result: SubstackIdeaSessionResult): void {
  const rejectedSubmissions = result.toolExecutions.filter(
    (execution) => execution.tool === "submit_substack_ideas" && execution.outcome === "failed",
  )
  if (!rejectedSubmissions.length) return

  review.push("", "#### Rejected submission feedback")
  for (const [index, execution] of rejectedSubmissions.entries()) {
    review.push("", `${index + 1}. ${execution.failureCategory ?? "unknown failure"}.`)
    if (execution.validationPaths?.length) review.push(`Fields: ${execution.validationPaths.join(", ")}.`)
    if (execution.validationErrors?.length) review.push(`Validation: ${execution.validationErrors.join("; ")}.`)
  }
}

/** Recovers only the model's submitted idea payloads from an unsuccessful private dry-run transcript. */
function submittedIdeaInputs(result: SubstackIdeaSessionResult): unknown[] {
  return result.messages.flatMap((message) =>
    "toolCalls" in message
      ? message.toolCalls.filter((call) => call.name === "submit_substack_ideas").map((call) => call.input)
      : [],
  )
}

/** Produces a filesystem-safe, sortable file name for a single review run. */
function reviewTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

/** Reads local Worker-style variables without evaluating their values as shell code. */
async function readDevVars(): Promise<Record<string, string>> {
  try {
    return Object.fromEntries(
      (await readFile(process.env.DEV_VARS_PATH || ".dev.vars", "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=")
          return [
            line.slice(0, separator).trim(),
            line
              .slice(separator + 1)
              .trim()
              .replace(/^"|"$/g, ""),
          ]
        }),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

await main()
