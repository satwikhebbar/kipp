import type { z } from "zod"

export type PrivacyClassification = "public" | "private" | "sensitive"

export interface ToolDefinition<TInput extends z.ZodType = z.ZodType, TOutput extends z.ZodType = z.ZodType> {
  name: string
  description: string
  input: TInput
  output: TOutput
  privacy: PrivacyClassification
  handler: (input: z.infer<TInput>) => Promise<z.infer<TOutput>>
}

export type ToolRegistry = Readonly<Record<string, ToolDefinition>>

export type ToolResult =
  | { ok: true; output: unknown }
  | {
      ok: false
      category: "unknown-tool" | "not-allowed" | "invalid-input" | "invalid-output" | "handler-failed"
      /** Schema paths only: these never include submitted values or provider text. */
      validationPaths?: string[]
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
      }
    try {
      const output = await definition.handler(parsedInput.data)
      if (!definition.output.safeParse(output).success) return { ok: false, category: "invalid-output" }
      return { ok: true, output }
    } catch {
      return { ok: false, category: "handler-failed" }
    }
  }
}
