import { z } from "zod"
import { validNoteUrl } from "./links"

export const MAX_NOTE_CHARACTERS = 10_000

export const destinationSchema = z
  .object({
    accountId: z.string().min(1),
    connectionId: z.string().min(1),
    organizationId: z.string().min(1),
    channelId: z.string().min(1),
    service: z.literal("substack"),
  })
  .strict()

// Later phases extend these discriminants without changing approval or guard ownership.
export const commandSchema = z
  .object({
    destination: destinationSchema,
    text: z.string().min(1).max(MAX_NOTE_CHARACTERS),
    attachmentUrl: z.string().refine(validNoteUrl).nullable(),
    timing: z.object({ kind: z.literal("now") }).strict(),
  })
  .strict()
export type BufferDestination = z.infer<typeof destinationSchema>
export type BufferCreateCommand = z.infer<typeof commandSchema>
export type BufferCreateResult =
  | { kind: "accepted"; postId: string; dueAt?: string; link?: string }
  | { kind: "created-unexpected"; postId: string; reason: string }
  | { kind: "rejected"; reason: string; repair: "reauthorize" | "reconnect-channel" | "configuration" | "none" }
  | { kind: "unknown"; reason: string; postId?: string }

export const approvedPublicationSchema = z
  .object({
    publicationId: z.string().min(1),
    workflowId: z.string().min(1),
    candidateVersion: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    command: commandSchema,
    approval: z
      .object({
        userId: z.string().min(1),
        chatId: z.string().min(1),
        deliveryId: z.string().min(1),
        interactionId: z.string().min(1),
        approvedAtMs: z.number().finite(),
      })
      .strict(),
    deadlineMs: z.number().finite(),
  })
  .strict()
export type ApprovedPublication = z.infer<typeof approvedPublicationSchema>

export interface NotesWorkflowParams {
  chatId: string
  userId: string
  firstUrl?: string | null
  requestText: string
  telegramMessageId: number
  receivedAtMs: number
}

export const notesEventSchema = z
  .object({
    deliveryId: z.string().min(1),
    workflowId: z.string().min(1),
    userId: z.string().min(1),
    chatId: z.string().min(1),
    interactionId: z.string().min(1),
    version: z.number().int().positive(),
    kind: z.enum(["notes-publish", "notes-revise", "notes-feedback"]),
    fingerprint: z.string(),
    telegramUpdateId: z.number().int(),
    receivedAtMs: z.number().finite(),
    text: z.string().optional(),
    firstUrl: z.string().refine(validNoteUrl).nullable().optional(),
  })
  .strict()
export type NotesInteractionEvent = z.infer<typeof notesEventSchema>
