# Meal catalog expansion tool

`tools/expand-meal-catalog.mjs` is a maintenance utility for the single-tenant
meal profile. It calls the existing `expandMealCatalog()` provider method,
validates every returned definition, and writes the definitions to the one
`meal_profile` row in D1. It is not a Worker route or a production workflow.

Run it with the repository's installed TypeScript runner and pass one quoted,
comma-separated string of dish names:

```bash
pnpm exec tsx tools/expand-meal-catalog.mjs "Aloo Paratha,Mooli Paratha,Gobi Paratha"
```

By default it reads `.dev.vars` and updates the local D1 database configured by
`wrangler.local.toml`. Existing definitions remain; definitions matching the
supplied names are replaced and new names are appended. Use `--replace` to
replace the entire catalog with only the supplied names:

```bash
pnpm exec tsx tools/expand-meal-catalog.mjs --replace "Aloo Paratha,Mooli Paratha"
```

Use `--dry-run` to call and validate the provider without writing D1. The tool
uses the same OpenRouter Luna model as the meal-planning workflow. To target
production, export the production OpenRouter credential and enable `--production`:

```bash
OPENROUTER_API_KEY="..." \
  pnpm exec tsx tools/expand-meal-catalog.mjs --production "Aloo Paratha,Mooli Paratha"
```

Production uses `wrangler.prod.toml`, executes against the remote database
named `meal-planning`, and updates the single profile row it finds. Set
`MEAL_CATALOG_DB_NAME` if the provisioned production D1 name differs. The tool
never reads `.dev.vars` in production mode and never prints credentials.
