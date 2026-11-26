# Phase 0 spikes

Throwaway evidence and reusable prototypes for the store / config / alerts / layout overhaul. Nothing here is shipped: `spikes/` is excluded from lint, type-check, coverage and the VSIX.

| Dir | Question | Verdict |
|---|---|---|
| `s1-s4/` | Does `node:sqlite` load in the real VS Code extension host, and can settings hold arrays/objects of config? | GO. `require('node:sqlite')` works with no flag from VS Code 1.101 (Node 22.15.1) through stable; 1.100.3 (Node 20) fails. Settings arrays/objects round-trip and change live; nothing is validated at runtime. |
| `s2/` | Can synchronous `node:sqlite` run on the extension-host main thread without jank? | GO with conditions: write batches of 1-2k rows (p95 32 ms at 2k); reads only via SQL pre-aggregation into 15-minute UTC buckets (92-109 ms for ~54k rows); no worker thread needed. See `s2/RESULTS.md`. |
| `s3/` | Can gridstack 14.x replace `layout.ts` with keyboard accessibility intact? | GO. Adapter (`src/gridstackEngine.ts`), fake engine, keyboard layer and tier-to-row constants are working prototypes with tests. See `s3/README.md`. |

Reusable pieces for later streams:

- Stream A: `s2/ndjson/stream.mjs` (byte-offset NDJSON tailer, 265-scenario selftest), `s2/bench-*.mjs` (budgets to re-check on target runtimes), `s2/semantics.mjs` (fresh-row detection).
- Stream B: `s1-s4/lib/settingsChecks.cjs` (settings behaviour checks).
- Stream D: `s3/src/` (`gridEngine.ts`, `gridstackEngine.ts`, `fakeEngine.ts`, `keyboard.ts`, `constants.ts`).

The decisions and design adjustments derived from these results are in the refactor plan, "Phase 0 results".
