#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const args = process.argv.slice(2)
const production = args.includes("--production")
const replace = args.includes("--replace")
const dryRun = args.includes("--dry-run")
const namesArgument = args.find((argument) => !argument.startsWith("--"))

if (!namesArgument) {
  console.error('Usage: pnpm exec tsx tools/expand-meal-catalog.mjs [--replace] [--production] [--dry-run] "Dish 1,Dish 2"')
  process.exit(2)
}

const parentDishNames = namesArgument.split(",").map((name) => name.trim()).filter(Boolean)
if (parentDishNames.length === 0) throw new Error("at least one comma-separated dish name is required")

function readKeyValueFile(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=")
        return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, "")]
      }),
  )
}

const vars = production ? process.env : { ...readKeyValueFile(process.env.DEV_VARS_PATH || ".dev.vars"), ...process.env }
const apiKey = vars.LLM_API_KEY
const providerName = vars.LLM_PROVIDER || "deepseek"
const model = vars.LLM_MODEL || undefined
const maxRetries = Number(vars.LLM_MAX_RETRIES || 3)
const databaseName = vars.MEAL_CATALOG_DB_NAME || (production ? "meal-planning" : "kipp-meal-planning-local")
const configPath = production ? "wrangler.prod.toml" : "wrangler.local.toml"

if (!apiKey) throw new Error(production ? "LLM_API_KEY must be exported for production expansion" : ".dev.vars must include LLM_API_KEY")

const [{ expandMealCatalog }, { createToolProvider }, { SEED_SCHEDULE }] = await Promise.all([
  import("../src/agent/meal-catalog-expansion.ts"),
  import("../src/providers/index.ts"),
  import("../src/meal-planning/store.ts"),
])

function executeD1(command) {
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", databaseName, ...(production ? ["--remote"] : ["--local"]), "--config", configPath, "--command", command],
    { encoding: "utf8" },
  )
  const jsonStart = output.indexOf("[")
  if (jsonStart < 0) throw new Error("Wrangler returned no JSON result")
  return JSON.parse(output.slice(jsonStart))
}

function sqlString(value) {
  const quote = String.fromCharCode(39)
  return `${quote}${String(value).replaceAll(quote, quote + quote)}${quote}`
}

const existingResult = executeD1("SELECT chat_id, profile_json FROM meal_profile LIMIT 1")
const existing = existingResult[0]?.results?.[0]
if (!existing) throw new Error("No meal_profile row exists; create the profile through meal-planning setup first")

const currentProfile = JSON.parse(existing.profile_json)
const provider = createToolProvider(apiKey, providerName, model, maxRetries)
console.log(`Expanding ${parentDishNames.length} meal(s) with ${providerName}${model ? ` (${model})` : ""}...`)
const result = await expandMealCatalog(provider, { parentDishNames, schedule: SEED_SCHEDULE })
if (result.failures.length > 0 || !result.definitions) {
  console.error(`Catalog expansion failed for ${result.failures.length} meal(s).`)
  for (const failure of result.failures) console.error(`- ${failure.dishName}: ${failure.code} — ${failure.detail}`)
  process.exit(1)
}

const normalize = (name) => name.trim().toLocaleLowerCase()
const generatedByName = new Map(result.definitions.map((definition) => [normalize(definition.sourceDishName), definition]))
const mergedDefinitions = replace
  ? result.definitions
  : [...(currentProfile.mealDefinitions ?? []).filter((definition) => !generatedByName.has(normalize(definition.name))), ...result.definitions]
const mergedNames = replace
  ? parentDishNames
  : [...(currentProfile.dishRepertoire ?? []).filter((name) => !generatedByName.has(normalize(name))), ...parentDishNames]
const profile = { ...currentProfile, dishRepertoire: mergedNames, mealDefinitions: mergedDefinitions }

if (dryRun) {
  console.log(`Validated ${result.definitions.length} definition(s); --dry-run left ${production ? "production" : "local"} D1 unchanged.`)
} else {
  const update = executeD1(`UPDATE meal_profile SET profile_json = ${sqlString(JSON.stringify(profile))}, updated_at = datetime('now') WHERE chat_id = ${sqlString(existing.chat_id)}`)
  const changes = Number(update[0]?.meta?.changes ?? 0)
  if (changes !== 1) throw new Error(`expected to update one meal profile, updated ${changes}`)
  console.log(`${replace ? "Replaced" : "Updated"} the ${production ? "production" : "local"} catalog with ${mergedDefinitions.length} definition(s).`)
}
