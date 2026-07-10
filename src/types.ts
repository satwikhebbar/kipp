export type IdeaStatus = "raw" | "drafting" | "awaiting-feedback" | "finalized" | "skipped"

export type Source = "substack" | "telegram" | "manual"

export interface Idea {
  id: string
  title: string
  status: IdeaStatus
  created: string
  source: Source
  substackUrl?: string
  teaser?: string
  body: string
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
  reasoningTokens?: number
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
  updateId: number
  message: {
    messageId: number
    text?: string
    chat: { id: number }
    from: { id: number; username?: string; firstName?: string }
    replyToMessage?: {
      messageId: number
      text?: string
    }
  }
}

export interface GithubFile {
  content: string
  sha: string
  path: string
}
