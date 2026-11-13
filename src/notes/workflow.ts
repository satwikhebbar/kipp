import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type { Env } from "../core/types"
import { runNotesWorkflow } from "./runner"
import type { NotesWorkflowParams } from "./types"

/** Thin durable entrypoint for Notes authoring and approved Buffer submission. */
export class NotesWorkflow extends WorkflowEntrypoint<Env, NotesWorkflowParams> {
  override async run(event: WorkflowEvent<NotesWorkflowParams>, step: WorkflowStep): Promise<void> {
    return runNotesWorkflow(this.env, event, step)
  }
}
