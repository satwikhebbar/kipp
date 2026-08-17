export interface Env {
  PIPELINE_WORKFLOW: Workflow
  CALENDAR_WORKFLOW?: Workflow
  TOKEN_VAULT: DurableObjectNamespace
  INTERACTION_ROUTER: DurableObjectNamespace
  IDEA_INGEST: DurableObjectNamespace
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  TELEGRAM_ALLOWED_USER_ID: string
  PROMPT_STYLE_PATH?: string
  LINKEDIN_CLIENT_ID: string
  LINKEDIN_CLIENT_SECRET: string
  LINKEDIN_ACCESS_TOKEN: string
  LINKEDIN_REDIRECT_ORIGIN?: string
  GOOGLE_CALENDAR_CLIENT_ID?: string
  GOOGLE_CALENDAR_CLIENT_SECRET?: string
  GOOGLE_CALENDAR_REDIRECT_ORIGIN?: string
  LINKEDIN_AUTHOR_URN: string
  DEPLOYMENT_ENV?: string
  LOG_LEVEL?: string
  ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK?: string
  TOKEN_ENCRYPTION_KEY_IDS: string
  ACCESS_TEAM: string
  ACCESS_AUDIENCE: string
  ACCESS_ADMIN_EMAILS: string
  LLM_API_KEY: string
  LLM_PROVIDER: string
  LLM_MODEL?: string
  LLM_MAX_RETRIES?: string
  GITHUB_PAT: string
  DATA_REPO_OWNER: string
  DATA_REPO_NAME: string
  NOTION_API_KEY: string
  NOTION_IDEAS_DATA_SOURCE_ID: string
  NOTION_FREE_TIER?: string
  SUBSTACK_RSS_URL: string
  POSTING_CADENCE_DAYS: string
  WAIT_FOR_FEEDBACK_HOURS: string
  TIMEZONE?: string
}

export type IdeaStatus = "raw" | "drafted" | "awaiting-feedback" | "awaiting-feedback-expired" | "finalized" | "skipped"

export type Source = "substack" | "telegram" | "manual"

export interface WorkflowCost {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number | null
  model: string
}

/** Metadata-only shape returned by list/query operations; body is absent. */
export interface IdeaSummary {
  pageId: string
  id: string
  title?: string
  status: IdeaStatus
  created: string
  source: Source
  substackUrl?: string
  substackBody?: string
  idempotencyKey?: string
  correlation?: { telegramChatId?: string }
}

/** Hydrated idea: summary metadata plus the page body. */
export interface Idea extends IdeaSummary {
  body: string
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
  pageId: string
  ideaId: string
  source: Source
  /** Originating Telegram chat for failure notification; defaults to the operator chat. */
  chatId?: string
}

export interface WorkflowEvent {
  type: "telegram-reply"
  userId: number
  text?: string
  interactionId?: string
  interactionVersion?: number
  interactionKind?: WorkflowInteractionKind
  telegramUpdateId?: number
}

export const INTERACTION_KIND = {
  APPROVE: "approve",
  REVISE: "revise",
  REVISION_FEEDBACK: "revision-feedback",
  CALENDAR_CLARIFICATION: "calendar-clarification",
  CALENDAR_CONFLICT_ALTERNATIVE: "calendar-conflict-alternative",
  CALENDAR_CONFLICT_REPLACE: "calendar-conflict-replace",
  CALENDAR_CONFLICT_CANCEL: "calendar-conflict-cancel",
  CALENDAR_RECURRENCE_ADJUSTMENTS: "calendar-recurrence-adjustments",
  CALENDAR_RECURRENCE_NEW_TIME: "calendar-recurrence-new-time",
  CALENDAR_EDIT: "calendar-edit",
  CALENDAR_EDIT_FEEDBACK: "calendar-edit-feedback",
  CALENDAR_RETRY: "calendar-retry",
  CALENDAR_CANCEL: "calendar-cancel",
} as const

export type WorkflowInteractionKind = (typeof INTERACTION_KIND)[keyof typeof INTERACTION_KIND]

/**
 * A normalized, provider-neutral interaction delivered from Telegram to a
 * workflow. The opaque id is deliberately the only identifier exposed in a
 * Telegram callback.
 */
export interface WorkflowInteraction {
  interactionId: string
  version: number
  telegramUpdateId: number
  kind: WorkflowInteractionKind
  text?: string
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

export interface LinkedInTokens {
  access_token: string
  expires_in: number
  created_at: string
  refresh_token?: string
  refresh_token_expires_in?: number
  scope?: string
}

export interface GoogleCalendarTokens {
  access_token: string
  expires_in: number
  created_at: string
  refresh_token?: string
  scope?: string
}

export const TOKEN_PROVIDER = {
  LINKEDIN: "linkedin",
  GOOGLE_CALENDAR: "google-calendar",
} as const

export type TokenProvider = (typeof TOKEN_PROVIDER)[keyof typeof TOKEN_PROVIDER]
