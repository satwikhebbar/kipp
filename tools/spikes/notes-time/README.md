# Notes time-handling spike

Reproduce the comparison without adding libraries to Kipp's package manifest:

```sh
rtk proxy npm install --prefix /private/tmp/kipp-notes-time-spike --ignore-scripts --no-audit --no-fund --package-lock=false luxon@3.7.2 @js-temporal/polyfill@0.5.1
rtk proxy node tools/spikes/notes-time/run.mjs
```

`NOTES_TIME_DEPS` can point to another isolated `node_modules` directory. The
runner uses Wrangler's installed esbuild and Miniflare/workerd. Running it needs
local loopback listener permission. It performs no external service calls and
overwrites `results.json` with observed versions, exact instants and bundle sizes.

The 19 common checks comprise eight local-time resolutions, four day lengths,
three civil-date additions, three weekly starts, and one skipped-day rejection.
An additional Samoa boundary case deliberately records a limitation of the
sampled Intl prototype; the runner asserts that counterexample remains visible.
Four assertions reproduce current Calendar behavior in the same runtime.

`adapters.mjs` contains comparison prototypes, not production helpers. Promote
the cases into the existing Calendar/unit suites when implementing the shared
resolver. The retained runner can compare a replacement implementation later.

See [the findings](../../../docs/research/substack-notes-time-spike.md).
