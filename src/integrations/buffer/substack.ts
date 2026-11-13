import type { BufferCreateCommand } from "../../notes/types"

/** Maps an approved Substack command to the verified Buffer publishing contract. */
export function mapSubstackPost(command: BufferCreateCommand) {
  return {
    channelId: command.destination.channelId,
    text: command.text,
    assets: [],
    ...(command.attachmentUrl ? { metadata: { substack: { linkAttachment: { url: command.attachmentUrl } } } } : {}),
    schedulingType: "automatic",
    mode:
      command.timing.kind === "queue"
        ? "addToQueue"
        : command.timing.kind === "schedule"
          ? "customScheduled"
          : "shareNow",
    ...(command.timing.kind === "schedule" ? { dueAt: command.timing.dueAt } : {}),
    needsApproval: false,
    saveToDraft: false,
  }
}
