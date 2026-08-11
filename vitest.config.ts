import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "forks",
    exclude: ["src/__integration__/**", "dist/**", "**/node_modules/**"],
  },
})
