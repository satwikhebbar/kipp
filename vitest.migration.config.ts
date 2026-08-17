import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "forks",
    include: ["scripts/migrate-to-notion/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
})
