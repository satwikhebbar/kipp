import type { BufferCreateCommand } from "../../notes/types"

/** Maps an approved Substack command to the verified Buffer publishing contract. */
export function mapSubstackPost(command: BufferCreateCommand) {
  return {
    channelId: command.destination.channelId,
    text: command.text,
    assets: [],
    schedulingType: "automatic",
    mode: "shareNow",
    needsApproval: false,
    saveToDraft: false,
  }
}
