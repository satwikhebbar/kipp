import type { z } from "zod"

export type PrivacyClassification = "public" | "private" | "sensitive"
export type ToolBatchingPolicy = "allowed" | "isolated"

/** A handler may expose a safe, machine-readable failure category to its caller. */
export class ToolHandlerError extends Error {
  constructor(
    message: string,
    readonly category: "authorization-failed" | "invalid-state",
    /** HTTP status only; never a provider response body or user-supplied value. */
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface ToolDefinition<TInput extends z.ZodType = z.ZodType, TOutput extends z.ZodType = z.ZodType> {
  name: string
  description: string
  input: TInput
  output: TOutput
  privacy: PrivacyClassification
  /** Whether this tool may share one provider response with other nonterminal tool calls. */
  batching: ToolBatchingPolicy
  handler: (input: z.infer<TInput>) => Promise<z.infer<TOutput>>
}

export type ToolRegistry = Readonly<Record<string, ToolDefinition>>

export type ToolResult =
  | { ok: true; output: unknown }
  | {
      ok: false
      category:
        | "unknown-tool"
        | "not-allowed"
        | "invalid-input"
        | "invalid-output"
        | "handler-failed"
        | "authorization-failed"
        | "invalid-state"
        | "batching-not-allowed"
      /** Schema paths only: these never include submitted values or provider text. */
      validationPaths?: string[]
      /** Safe schema expectations (for example, "title: expected object"); never includes submitted values. */
      validationErrors?: string[]
      /** Safe upstream HTTP status when a handler explicitly exposes one. */
      status?: number
    }

/** Deterministic permission and schema boundary around every future tool call. */
export class ToolGuard {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly allowedTools: readonly string[],
  ) {}

  async execute(name: string, input: unknown): Promise<ToolResult> {
    const definition = this.registry[name]
    if (!definition) return { ok: false, category: "unknown-tool" }
    if (!this.allowedTools.includes(name)) return { ok: false, category: "not-allowed" }
    const parsedInput = definition.input.safeParse(input)
    if (!parsedInput.success)
      return {
        ok: false,
        category: "invalid-input",
        validationPaths: [...new Set(parsedInput.error.issues.map((issue) => issue.path.join(".") || "<root>"))],
        validationErrors: [
          ...new Set(
            parsedInput.error.issues.map((issue) => {
              const path = issue.path.join(".") || "<root>"
              // Do not use Zod's human message here: it may echo an untrusted submitted value.
              return issue.code === "invalid_type" ? `${path}: expected ${issue.expected}` : `${path}: ${issue.code}`
            }),
          ),
        ],
      }
    try {
      const output = await definition.handler(parsedInput.data)
      if (!definition.output.safeParse(output).success) return { ok: false, category: "invalid-output" }
      return { ok: true, output }
    } catch (error) {
      if (error instanceof ToolHandlerError)
        return { ok: false, category: error.category, ...(error.status === undefined ? {} : { status: error.status }) }
      return { ok: false, category: "handler-failed" }
    }
  }
}
