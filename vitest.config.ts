import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "forks",
    exclude: ["scripts/**/*.test.ts", "**/node_modules/**"],
  },
})
