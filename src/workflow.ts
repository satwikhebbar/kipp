import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type { Env } from "./index"
import type { WorkflowParams } from "./types"

export class PipelineWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { ideaId, ideaTitle } = event.payload

    await step.do("draft", async () => {
      return { draftText: "", usage: { inputTokens: 0, outputTokens: 0 } }
    })

    return { ideaId, ideaTitle }
  }
}
