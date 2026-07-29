import { readdir, readFile } from "node:fs/promises"
import { relative } from "node:path"

const SOURCE_ROOT = new URL("../src/", import.meta.url)
const FUNCTION_DECLARATION = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/

/** Returns all TypeScript files below a directory, excluding test-only trees. */
async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const file = new URL(entry.name, directory)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("__")) files.push(...(await typescriptFiles(new URL(`${entry.name}/`, directory))))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(file)
  }
  return files
}

/** Returns whether the immediately preceding block is a JSDoc comment. */
function hasJSDoc(lines, functionLine) {
  let index = functionLine - 1
  while (index >= 0 && !lines[index].trim()) index--
  if (index < 0 || !lines[index].trim().endsWith("*/")) return false
  while (index >= 0 && !lines[index].trim().startsWith("/**")) index--
  return index >= 0
}

/** Fails when a named function declaration in production source lacks JSDoc. */
async function main() {
  const violations = []
  for (const file of await typescriptFiles(SOURCE_ROOT)) {
    const lines = (await readFile(file, "utf8")).split("\n")
    for (const [index, line] of lines.entries()) {
      const match = line.match(FUNCTION_DECLARATION)
      if (match && !hasJSDoc(lines, index)) violations.push(`${relative(process.cwd(), file.pathname)}:${index + 1} ${match[1]}`)
    }
  }
  if (!violations.length) return
  console.error("Named functions require an immediately preceding JSDoc comment:\n" + violations.join("\n"))
  process.exitCode = 1
}

await main()
