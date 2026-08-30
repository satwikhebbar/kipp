import { readFileSync } from "node:fs"

const ENV_TYPE_PATH = "src/core/types.ts"
const MANIFEST_PATH = "config/runtime-variables.json"
const BINDING_NAMES = new Set(["PIPELINE_WORKFLOW", "CALENDAR_WORKFLOW", "TOKEN_VAULT", "INTERACTION_ROUTER", "IDEA_INGEST"])

const envSource = readFileSync(ENV_TYPE_PATH, "utf8")
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
const envBlock = envSource.match(/export interface Env \{([\s\S]*?)\n\}/)?.[1]
if (!envBlock) throw new Error(`Could not read Env from ${ENV_TYPE_PATH}`)

const envVariables = [...envBlock.matchAll(/^  ([A-Z][A-Z0-9_]*)(?:\?)?:/gm)]
  .map((match) => match[1])
  .filter((name) => !BINDING_NAMES.has(name))
const additionalVariables = manifest.additionalVariables ?? []
const expectedVariables = [...new Set([...envVariables, ...additionalVariables])].sort()
const configuredVariables = Object.keys(manifest.variables).sort()
const missing = expectedVariables.filter((name) => !configuredVariables.includes(name))
const stale = configuredVariables.filter((name) => !expectedVariables.includes(name))

if (missing.length || stale.length) {
  if (missing.length) console.error(`Missing runtime-variable manifest entries: ${missing.join(", ")}`)
  if (stale.length) console.error(`Stale runtime-variable manifest entries: ${stale.join(", ")}`)
  process.exit(1)
}

for (const [name, entry] of Object.entries(manifest.variables)) {
  if (!entry || !["secret", "text"].includes(entry.kind)) throw new Error(`${name} must declare kind secret or text`)
  if (!["required", "optional", "forbidden"].includes(entry.production))
    throw new Error(`${name} must declare a production provision state`)
  if (!["required", "optional", "forbidden"].includes(entry.development))
    throw new Error(`${name} must declare a development provision state`)
}

console.log(`Runtime-variable contract is current (${expectedVariables.length} variables).`)
