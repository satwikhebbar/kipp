/** Comparison form for ingredients; original spelling is retained for display. */
const MIN_PLURAL_BASE_LENGTH = 4
const PLURAL_SUFFIX_LENGTH = 3

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
  if (key.endsWith("ies") && key.length > MIN_PLURAL_BASE_LENGTH) return `${key.slice(0, -PLURAL_SUFFIX_LENGTH)}y`
  if (key.endsWith("s") && !key.endsWith("ss") && !key.endsWith("us") && !key.endsWith("is")) return key.slice(0, -1)
  return key
}
