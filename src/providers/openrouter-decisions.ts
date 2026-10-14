import {
  ToolProviderHttpError,
  ToolProviderProtocolError,
  type ToolProviderRequestEvent,
  ToolProviderTimeoutError,
} from "./llm"

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
const OPENROUTER_DECISIONS_DEFAULT_MODEL = "openai/gpt-6-luna-decisions"
const OPENROUTER_DECISIONS_DEFAULT_REQUEST_TIMEOUT_MS = 180_000
const MAX_PROVIDER_ERROR_MESSAGE_CHARACTERS = 500

/** A shared-evidence value; named-field objects are preferred by the endpoint. */
export type DecisionState = string | Record<string, unknown> | readonly unknown[]

/** A yes/no question; the answer is `noul` — the probability the condition is true. */
export interface NoulQuestion {
  type: "noul"
  instructions: string | Record<string, unknown>
  criteria?: { true: string | Record<string, unknown>; false: string | Record<string, unknown> }
}

/** An unordered classification; the answer is the winning option plus a probability per option. */
export interface ChoiceQuestion {
  type: "choice"
  instructions: string | Record<string, unknown>
  criteria: Record<string, string | Record<string, unknown>>
}

/** An ordered rating; the answer is the probability-weighted score plus a probability per level. */
export interface ScoreQuestion {
  type: "score"
  instructions: string | Record<string, unknown>
  criteria: Array<string | Record<string, unknown>>
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  type: "noul"
  noul: number
}

export interface ChoiceAnswer {
  type: "choice"
  choice: string
  probabilities?: Record<string, number>
  confidence?: number
}

export interface ScoreAnswer {
  type: "score"
  score: number
  legend?: Record<string, string>
  probabilities?: Record<string, number>
  confidence?: number
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface DecisionUsage {
  inputTokens: number
  outputTokens: number
  /** Cost in USD as returned by the endpoint; not recomputed from tokens. */
  costUsd: number
}

export interface DecisionResult {
  id: string
  /** The exact model build that answered (may include a build suffix). */
  model: string
  provider: string
  answers: Record<string, DecisionAnswer>
  usage: DecisionUsage
}

export interface DecisionsClient {
  decide(input: {
    state: DecisionState
    questions: Record<string, DecisionQuestion>
    /** Observability grouping (a conversation or workflow id). */
    sessionId?: string
    /** Per-end-user attribution. */
    user?: string
  }): Promise<DecisionResult>
}

export interface DecisionsClientOptions {
  /** Abort an individual request after this many milliseconds. */
  requestTimeoutMs?: number
  /** Emits safe request-boundary metadata; callers must never log provider payloads. */
  onRequestEvent?: (event: ToolProviderRequestEvent) => void
}

interface OpenRouterDecisionsResponse {
  id?: string
  model?: string
  provider?: string
  answers?: Record<
    string,
    {
      type?: string
      noul?: unknown
      choice?: unknown
      score?: unknown
      probabilities?: unknown
      confidence?: unknown
      legend?: unknown
    }
  >
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
}

/** Creates an OpenRouter Decisions client (`/api/alpha/decisions`), distinct from the chat-completions client. */
export function createOpenRouterDecisionsClient(
  apiKey: string,
  modelName: string = OPENROUTER_DECISIONS_DEFAULT_MODEL,
  options: DecisionsClientOptions = {},
): DecisionsClient {
  return {
    async decide({ state, questions, sessionId, user }) {
      const questionIds = Object.keys(questions)
      const requestBody = JSON.stringify({
        model: modelName,
        state,
        questions,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(user ? { user } : {}),
      })
      const timeoutMs = options.requestTimeoutMs ?? OPENROUTER_DECISIONS_DEFAULT_REQUEST_TIMEOUT_MS
      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
      const startedAt = Date.now()
      options.onRequestEvent?.({
        phase: "dispatched",
        durationMs: 0,
        messageCharacters: requestBody.length,
        requestBodyCharacters: requestBody.length,
      })
      let response: Response
      try {
        response = await fetch(OPENROUTER_DECISIONS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: requestBody,
          ...(signal ? { signal } : {}),
        })
      } catch (error) {
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - startedAt,
          failureCategory: signal?.aborted ? "timeout" : error instanceof Error ? error.name : "transport-error",
        })
        throw normalizeTimeout(error, signal, timeoutMs)
      }
      options.onRequestEvent?.({ phase: "http-response", durationMs: Date.now() - startedAt, status: response.status })
      if (!response.ok) {
        const providerMessage = await readProviderErrorMessage(response)
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - startedAt,
          status: response.status,
          failureCategory: "http-error",
        })
        throw new ToolProviderHttpError("OpenRouter", response.status, providerMessage)
      }
      let data: OpenRouterDecisionsResponse
      try {
        data = (await response.json()) as OpenRouterDecisionsResponse
      } catch (error) {
        options.onRequestEvent?.({
          phase: "failed",
          durationMs: Date.now() - startedAt,
          status: response.status,
          failureCategory: signal?.aborted ? "timeout" : error instanceof Error ? error.name : "response-parse-error",
        })
        throw normalizeTimeout(error, signal, timeoutMs)
      }
      const answers = parseAnswers(data.answers, questions, questionIds)
      options.onRequestEvent?.({
        phase: "parsed",
        durationMs: Date.now() - startedAt,
        status: response.status,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      })
      return {
        id: data.id ?? "",
        model: data.model ?? modelName,
        provider: data.provider ?? "",
        answers,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          costUsd: data.usage?.cost ?? 0,
        },
      }
    },
  }
}

/**
 * Validates the response answer set against the questions that were sent: every
 * requested id must return an answer whose `type` matches, and the type's
 * payload must be present. A missing key or unexpected type is an error, never a
 * default (per the Decisions API contract).
 */
function parseAnswers(
  raw: OpenRouterDecisionsResponse["answers"],
  questions: Record<string, DecisionQuestion>,
  questionIds: string[],
): Record<string, DecisionAnswer> {
  if (!raw) throw new ToolProviderProtocolError("OpenRouter Decisions returned no answers")
  const answers: Record<string, DecisionAnswer> = {}
  for (const id of questionIds) {
    const answer = raw[id]
    const expected = questions[id]?.type
    if (!answer || answer.type !== expected)
      throw new ToolProviderProtocolError(`OpenRouter Decisions answer "${id}" is missing or has an unexpected type`)
    if (answer.type === "noul") {
      if (typeof answer.noul !== "number") throw new ToolProviderProtocolError(`answer "${id}" has no noul probability`)
      answers[id] = { type: "noul", noul: answer.noul }
    } else if (answer.type === "choice") {
      if (typeof answer.choice !== "string") throw new ToolProviderProtocolError(`answer "${id}" has no choice`)
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        ...(isNumberRecord(answer.probabilities) ? { probabilities: answer.probabilities } : {}),
        ...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
      }
    } else {
      if (typeof answer.score !== "number") throw new ToolProviderProtocolError(`answer "${id}" has no score`)
      answers[id] = {
        type: "score",
        score: answer.score,
        ...(isStringRecord(answer.legend) ? { legend: answer.legend } : {}),
        ...(isNumberRecord(answer.probabilities) ? { probabilities: answer.probabilities } : {}),
        ...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
      }
    }
  }
  return answers
}

/** True when every value is a finite number. */
function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "number")
  )
}

/** True when every value is a string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  )
}

/** Normalize timeout. */
function normalizeTimeout(error: unknown, signal: AbortSignal | undefined, timeoutMs: number | undefined): unknown {
  if (signal?.aborted && timeoutMs !== undefined) return new ToolProviderTimeoutError("OpenRouter", timeoutMs)
  return error
}

/** Read provider error message. */
async function readProviderErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    if (typeof body.error?.message !== "string") return undefined
    return body.error.message.replace(/\s+/g, " ").trim().slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARACTERS) || undefined
  } catch {
    return undefined
  }
}
