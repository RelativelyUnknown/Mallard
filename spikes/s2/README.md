# Spike S2: event-loop bench for `node:sqlite` on the extension-host main thread

Question: can synchronous `node:sqlite` replace DuckDB on the main thread without UI jank? What matters is the longest
time the (shared) extension-host event loop is blocked. Go criteria from the plan (Phase 0, S2): p95 main-thread block
under 50 ms per write batch, and a snapshot read (SELECT + aggregate) under 150 ms at 50k raw rows; otherwise SQL
pre-aggregation (15-minute UTC buckets), then a worker thread.

Results and the verdict are in [`RESULTS.md`](./RESULTS.md); raw per-run data is in `results/*.json`.
This directory is throwaway spike code (plain ESM `.mjs`, no dependencies, not part of the build or lint).

## Requirements

- Node 22.13+ (`node:sqlite`), run with `--disable-warning=ExperimentalWarning`. The harness was run on v22.23.5.
  `bench-read.mjs` also times `setReturnArrays`, which exists only on newer Node 22 releases (believed 22.16+); it detects
  that and skips the array variants.
- About 1.5 GB of free scratch space (databases plus the 500 MiB NDJSON file; all deleted on exit).
- Linux/macOS. `ndjson/bench.mjs` tries `echo 3 > /proc/sys/vm/drop_caches` for the cold-cache rows and skips them without root.

## Run

```bash
spikes/s2/run-all.sh                  # everything, about 25 minutes on a 4-vCPU 2.1 GHz box
spikes/s2/run-all.sh insert read      # selected steps: tests insert cold fresh read verify ndjson concurrency worker
QUICK=1 spikes/s2/run-all.sh          # smoke run (2 runs per cell, 60 MB NDJSON)
TZ=Asia/Kolkata S2_TMP=/mnt/fast spikes/s2/run-all.sh read     # other zone / scratch location
NODE=/path/to/node spikes/s2/run-all.sh                        # test another runtime
```

Environment: `TZ` (default `America/Los_Angeles`; the aggregator buckets in local time, so DST and :30/:45 offsets matter),
`S2_TMP` (scratch directory, default `$TMPDIR/mallard-s2`). Keep the machine idle while it runs; the benches are
timing-sensitive and several steps spawn child processes.

Each script can also be run directly, for example
`node --disable-warning=ExperimentalWarning spikes/s2/bench-insert.mjs --runs 5 --batches 1000,2000,t15 --modes wal,default`
(see the header comment of each file for its options). `bench-read.mjs` needs `--expose-gc`.

## Files

| file | what it does |
|---|---|
| `lib/data.mjs` | deterministic synthetic events (session-clustered "realistic" and uniform "worst case"), rollup-like rows, schema, journal presets (`wal`, `wal-full`, `wal-off`, `wal-ckpt0`, `wal-ckpt-big`, `default`) |
| `lib/stats.mjs` | percentile summary (nearest rank), event-loop histogram conversion, markdown tables, machine info, result writer |
| `lib/aggregate.mjs` | read-time pricing + the snapshot aggregator (local day/hour/weekday buckets, per model/repo/branch totals, heuristic share) |
| `bench-insert.mjs` | 100k-row inserts, batch sizes 1k/2k/5k/10k/time-boxed, journal presets, per-batch block, `monitorEventLoopDelay` |
| `bench-cold.mjs` | first batches of a fresh process (JIT/prepare cost) |
| `bench-fresh.mjs` | eight ways to learn which rows of a batch were freshly inserted, three scenarios, ground-truth checked |
| `bench-read.mjs` | 50k-row snapshot read: `.all()` vs `.iterate()`, objects vs arrays, naive vs cached local bucketing, raw vs SQL 15-min `GROUP BY`, sliced with yields; `--verify-only` checks all variants agree (run per zone) |
| `ndjson/stream.mjs` | the Buffer-scanning NDJSON streamer prototype (exact byte offsets, unterminated tail never consumed, byte prefilter, yields) |
| `ndjson/gen.mjs` | synthetic Claude-Code-style JSONL generator (`node ndjson/gen.mjs out.jsonl --mb 500`) |
| `ndjson/selftest.mjs` | 265 correctness scenarios for the streamer |
| `ndjson/bench.mjs` | 500 MiB full scan vs `readline`, chunk-size sweep, cold cache, 1000-line append + resume |
| `bench-concurrency.mjs`, `concurrency-child.mjs` | writers and a `data_version`-polling reader in separate processes; counts BUSY, dropped batches, writer block |
| `bench-worker.mjs`, `worker-db.mjs` | `node:sqlite` inside a `worker_thread`: snapshot latency, main-thread block, ingest through the worker |
| `semantics.mjs` | executable notes on SQLite/`node:sqlite` behaviours the design leans on (NULL-propagating `max()`, `lastInsertRowid` staleness, `data_version`, BUSY_SNAPSHOT, >2^53 integers, `readOnly`) |
| `make-appendix.mjs` | regenerates the appendix of `RESULTS.md` from `results/*.json` |
| `results/` | JSON per bench (machine info, per-run data, markdown table) plus the console logs |

## How to read the numbers

- "Block" is the wall time of one uninterrupted synchronous section on the main thread. For writes that is one
  `BEGIN IMMEDIATE ... COMMIT`; for reads one query + aggregation, or one slice when sliced. The independent check is
  `perf_hooks.monitorEventLoopDelay({ resolution: 1 })` (timer resolution subtracted) and, for the worker bench, a
  `setImmediate` spin probe.
- Percentiles are nearest-rank over pooled samples from all runs of a cell. With 50 to 100 samples per cell, p99 is the
  max; the JSON keeps per-run p95/max so run-to-run spread is visible.
- The first (cold) run of each read variant is reported separately; warm statistics exclude it.
- Absolute milliseconds are for the machine recorded in the JSON (2.1 GHz Xeon vCPU). Re-run the same script on
  target hardware before locking budgets; fsync/checkpoint cost is the least portable term.
