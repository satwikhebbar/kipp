/** Comparison form for ingredients; original spelling is retained for display. */
const MIN_PLURAL_BASE_LENGTH = 4
const PLURAL_SUFFIX_LENGTH = 3

/** Normalize ingredient. */
export function normalizeIngredient(value: string): string {
  const key = value.trim().toLocaleLowerCase().replace(/\s+/g, " ")
  const irregular: Record<string, string> = {
    leaves: "leaf",
    knives: "knife",
    loaves: "loaf",
    potatoes: "potato",
    tomatoes: "tomato",
  }
  if (irregular[key]) return irregular[key]
  const words = key.split(" ")
  const last = words[words.length - 1] ?? ""
  const normalizedLast =
    irregular[last] ??
    (last.endsWith("ies") && last.length > MIN_PLURAL_BASE_LENGTH
      ? `${last.slice(0, -PLURAL_SUFFIX_LENGTH)}y`
      : last.endsWith("s") && !last.endsWith("ss") && !last.endsWith("us") && !last.endsWith("is")
        ? last.slice(0, -1)
        : last)
  return words.length > 1 ? [...words.slice(0, -1), normalizedLast].join(" ") : normalizedLast
}
