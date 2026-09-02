#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

function readDevVars() {
  if (!process.env.DEV_VARS_PATH) return readKeyValueFile(".dev.vars")
  return readKeyValueFile(process.env.DEV_VARS_PATH)
}

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

function sqlString(value) {
  const quote = String.fromCharCode(39)
  return `${quote}${String(value).replaceAll(quote, quote + quote)}${quote}`
}

const vars = readDevVars()
const chatId = vars.TELEGRAM_ALLOWED_USER_ID
const apiKey = vars.LLM_API_KEY
const providerName = vars.LLM_PROVIDER || "deepseek"
const model = vars.LLM_MODEL || undefined
const maxRetries = Number(vars.LLM_MAX_RETRIES || 3)

if (!chatId || !apiKey) throw new Error(".dev.vars must include TELEGRAM_ALLOWED_USER_ID and LLM_API_KEY")

const [{ expandMealCatalog }, { createToolProvider }, { SEED_PROFILE, SEED_SCHEDULE }] = await Promise.all([
  import("../src/agent/meal-catalog-expansion.ts"),
  import("../src/providers/index.ts"),
  import("../src/meal-planning/store.ts"),
])

const parentDishNames = [...SEED_PROFILE.dishRepertoire]
console.log(`Expanding ${parentDishNames.length} meals with ${providerName}${model ? ` (${model})` : ""}...`)
const provider = createToolProvider(apiKey, providerName, model, maxRetries)
const result = await expandMealCatalog(provider, { parentDishNames, schedule: SEED_SCHEDULE })

if (result.failures.length > 0 || !result.definitions) {
  console.error(`Catalog expansion failed for ${result.failures.length} meal(s).`)
  for (const failure of result.failures) console.error(`- ${failure.dishName}: ${failure.code} — ${failure.detail}`)
  process.exitCode = 1
} else if (process.argv.includes("--dry-run")) {
  console.log(`Validated ${result.definitions.length} definitions; --dry-run left D1 unchanged.`)
} else {
  const profile = { ...SEED_PROFILE, mealDefinitions: result.definitions }
  const sql = `UPDATE meal_profile SET profile_json = ${sqlString(JSON.stringify(profile))}, updated_at = datetime('now') WHERE chat_id = ${sqlString(chatId)}`
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "kipp-meal-planning-local",
      "--local",
      "--config",
      "wrangler.local.toml",
      "--command",
      sql,
    ],
    { stdio: "inherit" },
  )
  console.log(`Validated and persisted ${result.definitions.length} meal definitions to the local profile.`)
}
