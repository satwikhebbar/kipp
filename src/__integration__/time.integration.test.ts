import { createRequire } from "node:module"
import { expect, it } from "vitest"

/** Checks Luxon bundling and representative timezone resolution in workerd; exhaustive cases live in time.test.ts. */
it("loads the production time wrapper and resolves unique, gap and overlap times in workerd", async () => {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(require.resolve("wrangler/package.json"))
  const { build } = runtimeRequire("esbuild")
  const { Miniflare } = runtimeRequire("miniflare")
  const bundled = await build({
    stdin: {
      contents: `import { resolveLocalDateTime } from "./src/core/time.ts";
        export default { fetch() {
          return Response.json([
            resolveLocalDateTime("2026-07-28", "19:00", "Asia/Kolkata"),
            resolveLocalDateTime("2026-03-08", "02:30", "America/New_York"),
            resolveLocalDateTime("2026-11-01", "01:30", "America/New_York")
          ]);
        }};`,
      resolveDir: process.cwd(),
      sourcefile: "shared-time-runtime-check.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  })
  const runtime = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-08",
  })
  try {
    const response = await runtime.dispatchFetch("https://time.test")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { kind: "unique", epochMs: Date.parse("2026-07-28T13:30:00.000Z") },
      { kind: "nonexistent" },
      {
        kind: "ambiguous",
        earlier: Date.parse("2026-11-01T05:30:00.000Z"),
        later: Date.parse("2026-11-01T06:30:00.000Z"),
      },
    ])
  } finally {
    await runtime.dispose()
  }
}, 30_000)
