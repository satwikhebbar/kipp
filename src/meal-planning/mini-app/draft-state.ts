export interface LocalFeedbackDraft {
  target: { kind: "plan" } | { kind: "cell"; day: string; slot: string }
  text: string
}

export interface LocalFeedbackBatch {
  drafts: LocalFeedbackDraft[]
  idempotencyKey: string | null
}

/** Parses the version-keyed local value, accepting legacy array-only drafts. */
export function readLocalFeedbackBatch(value: string | null): LocalFeedbackBatch {
  if (!value) return { drafts: [], idempotencyKey: null }
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return { drafts: parsed as LocalFeedbackDraft[], idempotencyKey: null }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { drafts?: unknown }).drafts) &&
      ((parsed as { idempotencyKey?: unknown }).idempotencyKey === null ||
        typeof (parsed as { idempotencyKey?: unknown }).idempotencyKey === "string")
    ) {
      const batch = parsed as LocalFeedbackBatch
      return { drafts: batch.drafts, idempotencyKey: batch.idempotencyKey }
    }
  } catch {}
  return { drafts: [], idempotencyKey: null }
}

/** Allocates a stable key when the first local draft forms a new batch. */
export function addLocalFeedbackDraft(
  batch: LocalFeedbackBatch,
  draft: LocalFeedbackDraft,
  createIdempotencyKey: () => string,
): LocalFeedbackBatch {
  return {
    drafts: [...batch.drafts, draft],
    idempotencyKey: batch.idempotencyKey ?? createIdempotencyKey(),
  }
}
