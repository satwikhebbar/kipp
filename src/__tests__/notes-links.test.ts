import { expect, it } from "vitest"
import { firstNoteUrl } from "../notes/links"

it.each([
  ["No URL here", [], null],
  ["See https://example.com/a?b=2#part then https://substack.com/a", [], "https://example.com/a?b=2#part"],
  ["See (https://example.com/a).", [], "https://example.com/a"],
  ["See https://example.com/a_(b).", [], "https://example.com/a_(b)"],
  [
    "😀 article then https://later.com",
    [{ type: "text_link", offset: 3, length: 7, url: "https://first.com/?x=1#two" }],
    "https://first.com/?x=1#two",
  ],
  [
    "https://misleading.com then https://later.com",
    [{ type: "text_link", offset: 0, length: 22, url: "https://real.com" }],
    "https://real.com",
  ],
  [
    "https://misleading.com then https://later.com",
    [{ type: "text_link", offset: 0, length: 22, url: "javascript:alert(1)" }],
    "https://later.com",
  ],
  ["https://first.com next", [{ type: "url", offset: 0, length: 17 }], "https://first.com"],
  ["https://first.com", [{ type: "text_link", offset: -1, length: 50, url: "https://bad.com" }], "https://first.com"],
  ["click", [{ type: "text_link", offset: 0, length: 5, url: "https://user:password@example.com" }], null],
  ["click", [{ type: "text_link", offset: 0, length: 5, url: "https://" }], null],
  ["click", [{ type: "text_link", offset: 0.5, length: 4, url: "https://bad.com" }], null],
])("extracts the first original destination from %s", (text, entities, expected) => {
  expect(firstNoteUrl(text as string, entities as Parameters<typeof firstNoteUrl>[1])).toBe(expected)
})
