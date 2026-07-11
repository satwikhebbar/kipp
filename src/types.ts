export interface Env {
  PIPELINE_WORKFLOW: Workflow
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  TELEGRAM_ALLOWED_USER_ID: string
  LINKEDIN_ACCESS_TOKEN: string
  LINKEDIN_REFRESH_TOKEN: string
  LLM_API_KEY: string
  LLM_PROVIDER: string
  GITHUB_PAT: string
  DATA_REPO_OWNER: string
  DATA_REPO_NAME: string
  SUBSTACK_RSS_URL: string
  POSTING_CADENCE_DAYS: string
}

export type IdeaStatus = "raw" | "drafted" | "awaiting-feedback" | "awaiting-feedback-expired" | "finalized" | "skipped"

export type Source = "substack" | "telegram" | "manual"

export interface Correlation {
  telegramChatId?: string
  botMessageId?: number
  workflowInstanceId?: string
}

export interface Idea {
  id: string
  title: string
  status: IdeaStatus
  created: string
  source: Source
  substackUrl?: string
  teaser?: string
  body: string
  draft?: string
  critique?: string
  reviewCount?: number
  correlation?: Correlation
}

export interface ArchivedIdea {
  id: string
  title: string
  finalized: string
  linkedinUrl: string
  linkedinUrn: string
  draftText: string
  totalTokens: number
  revisionCount: number
}

export interface LLMUsage {
  inputTokens: number
  outputTokens: number
}

export interface LLMResponse {
  text: string
  usage: LLMUsage
}

export interface ChecklistItem {
  check: string
  passed: boolean
  feedback: string | null
}

export interface ClassificationResult {
  action: "approve" | "feedback"
  feedbackText: string | null
}

export interface WorkflowParams {
  ideaId: string
  ideaTitle: string
  ideaBody: string
  substackBody?: string
}

export interface WorkflowEvent {
  type: "telegram-reply"
  userId: number
  text: string
}

export interface TelegramUpdate {
  userId: number
  text: string
  messageId: number
}

export interface GithubFile {
  content: string
  sha: string
  path: string
}
