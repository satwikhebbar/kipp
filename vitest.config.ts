import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "forks",
    exclude: ["scripts/**/*.test.ts", "src/__integration__/**", "dist/**", "**/node_modules/**"],
  },
})
