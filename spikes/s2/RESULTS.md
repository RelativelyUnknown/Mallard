# S2 results: can synchronous `node:sqlite` live on the extension-host main thread?

Verdict: **GO, with conditions** (details at the bottom). Raw per-run data is in `results/*.json`; the full
tables are appended in the appendix of this file.

## Machine

| | |
|---|---|
| CPU | Intel Xeon @ 2.10 GHz, 4 vCPU (Firecracker VM), 15.7 GB RAM |
| OS / FS | Linux 6.18, ext4 on a virtio disk (fsync is cheap here; real laptops and Windows can be slower or faster) |
| Node / V8 / SQLite | v22.23.5 / 12.4 / SQLite 3.54.1 (Node 22.13 to 22.15 bundle an older SQLite; every statement used here is SQLite 3.35+ compatible) |
| TZ for the aggregator | America/Los_Angeles (DST); equivalence also checked in 7 zones, see "Reads" |

This is a slow single-thread machine (2.1 GHz Xeon). A current laptop core is typically 1.5x to 2.5x faster (my estimate, not measured), so
scale the millisecond figures down accordingly; the ratios between variants should hold. Every cell below is
5 fresh runs (7 for reads), pooled; p99 over fewer than 100 samples is effectively the max.

## 1. Writes: 100k events, prepared upsert, one transaction per batch, `setImmediate` between batches

Schema as in the plan (id TEXT PK, ts, modelId, surface, source, repo, branch, attribution, language, requests,
5 token columns; indexes on ts, modelId, repo). Per-batch wall time is the event-loop block (it is one synchronous
`BEGIN IMMEDIATE ... COMMIT`). Independent check: `monitorEventLoopDelay` agrees with the batch times within 1 to 2 ms
(see appendix, last column).

| mode | batch | batches | p50 ms | p95 ms | p99 ms | max ms | rows/s |
|---|---|---|---|---|---|---|---|
| **WAL + synchronous=NORMAL** | 1000 | 500 | 5.3 | **23.2** | 25.3 | 27.2 | 118.8k |
| | **2000** | 250 | 10.6 | **32.3** | 36.9 | 39.7 | 125.8k |
| | 5000 | 100 | 33.1 | **57.8** | 60.5 | 62.3 | 129.9k |
| | 10000 | 50 | 76.1 | **87.0** | 95.2 | 95.2 | 135.0k |
| | time-boxed 15 ms (about 3.4k rows) | 151 | 16.9 | **38.6** | 41.5 | 41.6 | 135.1k |
| WAL + synchronous=FULL | 2000 | 250 | 14.1 | 27.7 | 30.4 | 32.5 | 120.6k |
| WAL + synchronous=OFF | 2000 | 250 | 9.9 | 16.1 | 18.9 | 22.2 | 188.2k |
| | 5000 | 100 | 27.6 | 37.2 | 40.4 | 43.5 | 186.0k |
| rollback journal (SQLite defaults) | 2000 | 250 | 18.0 | 24.8 | 28.1 | 30.4 | 106.5k |
| | 5000 | 100 | 38.9 | 50.8 | 54.6 | 55.0 | 126.2k |

What dominates the tail: `COMMIT` in WAL mode carries the auto-checkpoint (1000 pages), p95 22 to 25 ms at 2k rows
(a checkpoint fsyncs the WAL and the main file). With `wal_autocheckpoint=20000` (no checkpoint inside 100k rows)
the 2k-row p95 drops to 11 ms, which is the pure CPU cost of 2000 upserts with four B-trees (about 5 us per row). Doing the
checkpoint explicitly does not make it cheaper (50 to 70 ms per `PRAGMA wal_checkpoint(PASSIVE)` every 20k rows), it only
moves the block. `synchronous=OFF` removes it (fsync-free) at the price of possible corruption after an OS crash; the
database is rebuildable from logs, so that is an option, but I did not need it to pass.

Cold start: first batch of a fresh process (2000 rows, 7 fresh processes) p50 9.0 ms, max 14.9 ms versus 9.2 ms
steady state; no meaningful JIT penalty. Open + prepare 2.6 ms.

Tail risk: the first pass of this bench (not kept) had one 1007 ms batch (WAL, 5k) and one 397 ms batch (first run in the
process), plausibly fsync stalls on the VM disk. The second full pass (this one) had no stalls (worst batch of 5000 rows or fewer: 67 ms), and a
20-run soak of 2000-row batches (1000 batches per mode) had max 89 ms (WAL), 27 ms (OFF), 46 ms (default). So
stalls exist but are rare here; treat the p99 under real fsync cost as unknown on Windows and network drives.

## 1b. Which rows were freshly inserted? (export stream needs them)

DB pre-filled with 100k rows; 40k incoming rows per cell, 5 runs. "fresh" = all new ids plus 2% in-batch duplicates
(streamed partial usage lines); "mixed" = 50% already stored (half with higher tokens, half lower) plus in-batch duplicates;
"reingest" = 100% identical rows already stored. Every strategy's fresh set was compared with an independent
JS ground truth per batch (all correct except F6, which by design does not update). p50 / p95 ms per 2000-row batch:

| strategy | fresh | mixed | reingest | exact? |
|---|---|---|---|---|
| F0 upsert, no detection (floor) | 15.2 / 39.3 | 42.4 / 57.0 | 7.2 / 9.7 | n/a |
| F0g same, guarded `WHERE coalesce(excluded.x,0) > coalesce(x,0)` | 13.3 / 40.3 | 41.6 / 58.2 | 4.6 / 8.5 | n/a |
| F1 pre-`SELECT id ... IN (5000)` then upsert (today's pattern) | 16.6 / 41.1 | 48.0 / 60.0 | 10.9 / 15.6 | yes inside `BEGIN IMMEDIATE` |
| F2 upsert, `run().lastInsertRowid` vs running max | 14.7 / 40.1 | 42.0 / 67.9 | 8.5 / 10.2 | **no**: stale after tail deletes |
| F3 upsert `RETURNING rowid` via `get()` | 23.5 / 51.2 | 45.8 / 63.3 | 8.9 / 13.3 | yes |
| **F4g `ON CONFLICT DO NOTHING`, `changes === 1`, guarded `UPDATE` on conflict** | **14.9 / 39.3** | 43.8 / 61.6 | **6.5 / 10.7** | **yes, stateless** |
| F5 `DO NOTHING RETURNING id` via `get()` | 20.3 / 43.4 | 48.8 / 66.3 | 9.4 / 14.8 | yes |
| F6 `INSERT OR IGNORE` + changes (no max upsert) | 15.8 / 40.2 | 11.1 / 37.9 | 4.6 / 7.5 | yes, loses partial-usage upgrades |
| F8 multi-row `VALUES` upsert `RETURNING id, rowid` | 12.8 / 40.1 | 46.3 / 62.4 | 9.2 / 16.4 | yes, but variable-length statements |

Findings:

- F4g is within noise of the floor and exact. `RETURNING` through `get()` (F3, F5) costs +2 to +8 ms per 2000 rows (JS row
  object per statement). The pre-SELECT (F1) costs +1 to +6 ms per 2000 rows and needs `BEGIN IMMEDIATE`, otherwise two windows race.
- F2 is cheapest but wrong in one reachable case: `last_insert_rowid` is connection state and goes stale when the tail row
  is deleted (`semantics.mjs` #3 demonstrates it); do not use it.
- SQLite's scalar `max(a, b)` returns NULL if either side is NULL (`semantics.mjs` #1). The plan's
  `SET promptTokens = max(promptTokens, excluded.promptTokens)` therefore never repairs a NULL; use the guarded
  `WHERE coalesce(excluded.x,0) > coalesce(x,0)` form.
- "mixed" is about 3x the cost of "fresh" per row, and a larger page cache does not help (`cache_size=-65536` and
  `mmap_size`: p95 53 and 54 ms versus 54 ms). Cause: each rewritten existing row dirties a distinct 4 KB page, so the WAL
  grows by roughly one frame per update. At 2000 rows the mixed p95 is 57 to 68 ms (miss), at 5000 rows 106 to 146 ms.
  This only happens when a rewritten log is re-read with changed values; an unchanged re-read is cheap (reingest column).
  Mitigation: time-box batches (15 ms) or drop to 1000 rows for the re-ingest path.

## 2. Reads: snapshot = filtered SELECT feeding a JS aggregator

Aggregator per row: read-time price lookup (5 token categories), local day / hour / weekday buckets, per-model, repo,
repo+branch+model totals, category totals, heuristic cost share. Data: 50k raw "clustered" events (sessions of 20 to 400
requests in one repo/branch/model, 90 days) plus 5k rollup-like rows (older). The default 365-day window returns
53,876 rows; 30 days returns 19,183; "365d + 3 models" 30,008; "+ 5 repos" 9,461. Times are p50 (p95 in the JSON), ms.

365-day window, 53,876 raw rows or 6,314 SQL groups (clustered data):

| path | objects (Node 22.13+) | arrays (`setReturnArrays`, Node 22.16+ only) |
|---|---|---|
| raw `.all()`, naive local `Date` per row (repo helpers) | 301 | 138 |
| raw `.all()`, local fields cached per 15-min bucket | 262 | 107 |
| raw `.iterate()`, naive | 291 | 152 |
| raw `.iterate()`, cached | 299 | 109 |
| raw fetch only (no aggregation), `.all()` / `.iterate()` | 158 / 181 | 92 / 86 |
| raw `ORDER BY ts` `.iterate()`, cached | 250 | n/a |
| **SQL `GROUP BY` 15-min UTC bucket, `.all()` / `.iterate()`** | **92 / 109** | 73 / 80 |
| raw, sliced into 7-day windows with yields (total; longest slice p95/max) | 266; 22 / 32 ms | 116; 10 / 17 ms |
| **SQL group-by sliced into 7-day windows with yields** | **89; 6 / 9.5 ms** | 70; 5 / 9 ms |

30-day window (19k rows): raw objects 73 to 103 ms, SQL group-by 22 to 36 ms. With 3-model + 5-repo filters: every path
has p50 under 85 ms.

- Criterion "snapshot read under 150 ms at 50k raw rows": **raw rows through row objects miss it by about 2x** (260 to
  300 ms, and 158 to 181 ms of that is just materialising 54k objects of 14 columns). Raw rows through arrays pass narrowly (107 to 152 ms) but
  `setReturnArrays` is not in the Node 22.13 to 22.15 API set (I believe it arrived in 22.16; S1 should confirm on the actual
  host), so it cannot be assumed at the VS Code 1.101 minimum. **SQL pre-aggregation passes comfortably (92 to 109 ms)** and about 75 ms of
  that is SQLite's own sort for the `GROUP BY` (fetch-only 74 ms); the JS aggregation of 6.3k rows is about 20 to 35 ms.
- Reduction: clustered data 53,876 -> 6,314 groups (8.5x); 30 days 19,183 -> 935 (20x). **Worst case (uniform random
  repo/branch/model/time) 53,876 -> 53,861 groups: no reduction, and the SQL path becomes slower (430 to 480 ms)**. Real agent sessions
  are bursty (a request every ~20 s), so the realistic ratio is much closer to the clustered case, but there is no hard bound.
- `.all()` vs `.iterate()`: equal speed within noise (0 to 14% slower for iterate with row objects); `.iterate()` peaks at 12 to 16 MB of heap versus
  58 to 73 MB for `.all()` of 54k objects. Prefer `iterate()`.
- Per-row local-time bucketing with `new Date(y,m,d)` costs about 30 to 45 ms at 54k rows (0.6 to 0.8 us/row; run-to-run
  noise is about +-10%, so the object+`iterate()` pair shows no gain in one pass); caching the local fields per
  15-minute UTC bucket removes it. The 15-minute grain is exact for every IANA zone whose offsets (and DST changes) fall on
  15-minute boundaries. **Verified identical** (raw rows vs SQL 15-min pre-aggregation vs sliced, all aggregates to 1e-9
  relative) in UTC, America/Los_Angeles, Asia/Kolkata, Australia/Lord_Howe, Pacific/Auckland, Pacific/Chatham and
  America/St_Johns on the clustered data, and in America/Los_Angeles and Australia/Lord_Howe on the uniform data.
- Slicing (one query per 7-day window, `setImmediate` between windows, aggregator state carried across) costs nothing in total
  (SQL path 89 vs 92 to 109 ms) and caps the block at 6 to 9.5 ms (SQL) or 22 to 32 ms p95/max (raw objects). Even the uniform
  worst case stays at p95 27 to 32 ms, max 47 to 75 ms per slice.
- Caveat for pre-aggregation: it is exact only because pricing is linear in tokens and requests. A per-request tiered rate
  (long-context surcharge above N prompt tokens) cannot be applied after summing.
- `node:sqlite` throws `ERR_OUT_OF_RANGE` for integers above 2^53 (for example `SUM(ts)` over a big table); token and
  credit sums are far below that. `ts` in ms is safe.

## 3. NDJSON tail (500 MiB synthetic Claude-style JSONL)

100,556 lines, 524 MB, lines 121 B to 22.9 KB (p50 4.0 KB, p90 12.3 KB), 16,755 `assistant` lines with `"usage"` plus
454 prefilter false positives (subagent `toolUseResult.usage` objects). Multi-byte text (é, 日本語, emoji) so byte offsets differ
from character offsets. Each measurement is a fresh process, 5 runs. All variants produce identical token totals.

| variant | full file p50 ms | MiB/s | `JSON.parse` calls | longest sync slice p50/max ms | EL-delay max ms (p50/worst) | max RSS MB |
|---|---|---|---|---|---|---|
| **needle-first Buffer scan, 1 MiB chunks (proposed)** | **412** | 1213 | 17,209 | **1.6 / 3.6** | 2.8 / 3.9 | 51 |
| line-split Buffer scan, 1 MiB | 436 | 1147 | 17,209 | 1.8 / 2.4 | 2.4 / 2.8 | 53 |
| needle-first 64 KiB / 256 KiB / 4 MiB chunks | 845 / 444 / 391 | 592 / 1126 / 1277 | 17,209 | 0.7 / 0.6 / 4.0 (max 2.3 / 1.3 / 8.0) | | 52 to 55 |
| `readline` + `JSON.parse` every line | 3175 | 157 | 100,556 | per-line callbacks | 2.4 / 3.5 | 89 |
| `readline` + `includes('"usage"')` + parse | 2857 | 175 | 17,209 | per-line callbacks | 5.4 / 11.5 | 96 |

- The Buffer streamer is **7.7x faster than the readline baseline** and parses 5.8x fewer lines. Cold page cache
  (`drop_caches`): 488 ms vs 3458 ms. Event-loop impact is small either way (readline yields on every stream chunk), so the
  justification is throughput and memory (89 to 96 MB vs 51 MB RSS), not blocking.
- 1 MiB chunks are the sweet spot: 64 KiB doubles the time, 4 MiB gives only 5% more but a 4 to 8 ms synchronous slice.
- needle-first (memmem the needle, then find the enclosing line with `lastIndexOf`/`indexOf` of 0x0A) is within 6% of the
  simple line-split loop: per-line overhead (a `0x0A` search, a `subarray`, a needle search) is small next to scanning 524 MB
  that is already in the page cache. Use whichever is easier to review.
  Both are covered by `ndjson/selftest.mjs`.
- Incremental: after a full scan, append 1000 lines (the last one cut in half, as a writer mid-flush) and resume from the stored
  byte offset: median **3.9 ms** (first 13.6 ms), longest sync slice 0.6 ms; the cut line is not consumed and `nextOffset`
  stops exactly at its start; after the writer finishes the line, resuming picks up exactly that one line in 0.34 ms. Rewrite
  detection needs `stat` + a head hash: reading and sha1-ing the first 4 KiB takes 0.47 ms median.
- Correctness: `ndjson/selftest.mjs` runs 265 scenarios (chunk sizes 1 B to 1 MiB, both strategies, CRLF, empty lines, lines
  longer than the chunk, multi-byte characters straddling chunks, needle at line start/end, unterminated tail, resume from
  every line offset, append-in-pieces); a deliberate mutation of the line-boundary logic fails it immediately.

## 4. Concurrency: two windows writing the same logs, one reader polling `PRAGMA data_version`

Writers ingest the same 60k ids in different order (real upsert conflicts) in 2000-row batches over a 50k-row seed DB; the
reader polls `data_version` every 20 ms and re-reads all rows (50k growing to 110k) on every bump. 5 runs per row, 30 batches per
writer per run. Final row count was 110,000 in every run except the deferred+pre-SELECT row (below).

| scenario | BUSY (writers / reader) | batches dropped | writer sync block p95 / max ms | notes |
|---|---|---|---|---|
| 1 writer + reader, `busy_timeout=5000`, `BEGIN IMMEDIATE` | 0 / 0 | 0 | 53.9 / 63.9 | reader never blocks the writer in WAL |
| 1 writer + reader, `busy_timeout=0` | 0 / 0 | 0 | 51.1 / 71.1 | |
| 2 writers + reader, `busy_timeout=5000`, `BEGIN IMMEDIATE` | 0 / 0 | 0 | 93.4 / **345.0** | the busy handler sleeps inside the synchronous call: the waiting window's thread is blocked |
| 2 writers, `busy_timeout=250` | 0 / 0 | 0 | 91.7 / 269.7 | still blocks up to 250 ms per wait |
| **2 writers, `busy_timeout=0` + async retry with 3 to 15 ms jitter** | 294 handled / 0 | 0 | **18.0 / 86.6** | block only covers the attempt; batch latency incl. waits p95 102 / max 232 ms |
| 2 writers, `busy_timeout=0`, no retry | 150 / 0 | **150 of 300** | 0.0 / 159.5 | half the batches lost |
| 2 writers, `busy_timeout=5000`, **deferred `BEGIN`**, pre-SELECT then write | 199 (`5` x180, `517` x19) / 0 | **199 of 300** | 21.5 / 70.3 | `busy_timeout` does not help; final rows 78k to 98k instead of 110k |
| 2 writers, `busy_timeout=5000`, `BEGIN IMMEDIATE`, pre-SELECT then write | 0 / 0 | 0 | 119.1 / 449.5 | correct, but the wait blocks |

- `PRAGMA integrity_check` was `ok` after every run; reader row counts were monotonic; the reader saw zero BUSY anywhere.
- `PRAGMA data_version` works as the plan assumes: it changes only for commits by *other* connections (own writes need an
  in-process counter) and costs 110 to 146 us per call at p50 (max 0.6 ms) while two writers and a reader compete; polling at 1 s is negligible.
- A continuously reading second connection keeps the checkpoint from completing: the WAL reached 43 MB in these stress
  runs and the single-writer batch p95 rose from 32 ms (idle) to 51 to 54 ms. Reads in this scenario took p50 85 to 126 ms at
  80k rows average. A reader that does not poll continuously (as in the product) will not do this, but plan a
  `wal_checkpoint(TRUNCATE)` on idle/deactivate.

## 5. Worker-thread variant (criteria were missed for raw rows, so it was prototyped)

`worker-db.mjs`: `node:sqlite` inside a `worker_thread`, own connection, requests/results via `postMessage`. Main-thread
block measured with a `setImmediate` spin probe (microsecond resolution) plus `monitorEventLoopDelay`. 7 runs.

| snapshot at 54k rows | in-thread (= main block) p50 / p95 ms | worker latency p50 / p95 ms | added latency | main-thread longest gap p50 / worst |
|---|---|---|---|---|
| raw rows (objects) | 260.8 / 334.7 | 279.6 / 300.1 | +0.7 ms | 1.0 / 1.6 ms |
| SQL 15-min GROUP BY | 91.9 / 107.5 | 99.5 / 113.8 | +0.7 ms | 0.6 / 5.6 ms |

- If the worker only runs the SELECT and returns the 54k raw rows to the main thread, the structured clone blocks the
  main thread for p50 24 / max 28 ms and the main thread still has to aggregate; return aggregates, not rows.
- Ingest through a worker (100k rows, 2000/batch, two batches in flight, results = fresh ids): total 1057 ms vs 1028 ms
  in-thread (94.6k vs 97.3k rows/s); main-thread longest gap **3.3 ms p50 / 8.4 ms worst** versus 44.6 / 72.4 ms in-thread.
  `postMessage` of a 2000-row batch costs the main thread 1.6 ms p50 / 2.3 ms max.
- Worker spawn to ready: 40 ms (spawn, open DB, prepare statements). A single worker serialises requests, so a snapshot
  that arrives during ingest waits at most one batch; use a second worker/connection for reads if that matters.
- Cost: an extra esbuild entry point for the worker file, message protocol, lifecycle/error handling, and the in-memory
  fallback has to exist in both shapes. Not needed unless the main-thread numbers below fail on target hardware.

## Verdict against the plan's criteria

| criterion | result | status |
|---|---|---|
| p95 main-thread block per write batch < 50 ms | WAL+NORMAL: 1k rows 23 ms, **2k rows 32 ms**, time-boxed 15 ms (3.4k rows) 39 ms; 5k rows 58 ms and 10k rows 87 ms fail | **GO at 1k to 2k rows** |
| snapshot read < 150 ms at 50k raw rows | raw rows via row objects 260 to 300 ms (fail); raw via arrays 107 to 152 ms (needs Node 22.16+); **SQL 15-min pre-aggregation 92 to 109 ms** | **GO via SQL pre-aggregation** (no worker needed) |
| fall back to worker | prototype works: +0.7 ms latency, main block 1 to 6 ms | not required; keep as contingency |

Recommendations for A2/A3:

1. WAL + `synchronous=NORMAL`, `BEGIN IMMEDIATE`, batches of **2000 rows or 15 ms, whichever comes first** (1000 on the
   re-ingest path), `setImmediate` between batches. Default `wal_autocheckpoint`.
2. Fresh-row detection: **`INSERT ... ON CONFLICT(id) DO NOTHING` + `changes === 1`, and on conflict a guarded
   `UPDATE events SET promptTokens = ? WHERE id = ? AND coalesce(?,0) > coalesce(promptTokens,0)`**. Exact, stateless, no
   cost over the plain upsert. Not `lastInsertRowid`, not `RETURNING` through `get()`.
3. Reads: SQL `GROUP BY` (15-min UTC bucket, model, surface, source, repo, branch, attribution, language) with `iterate()`, in
   7-day windows with a `setImmediate` yield between windows, aggregator state carried across windows; cache local-day/hour/
   weekday per 15-min bucket. Do not depend on `setReturnArrays` until S1 shows it on the minimum host.
4. Busy handling: `busy_timeout=0` on the writer connection with an async jittered retry around `BEGIN IMMEDIATE`; never a
   deferred `BEGIN` followed by a read-then-write. A synchronous busy wait blocks the extension host.
5. Re-run this harness on the S1 target runtimes (Node 22.13/22.15 SQLite, Windows, macOS) before locking numbers;
   the WAL checkpoint/fsync cost is the least portable term.

## Appendix: full tables (generated from `results/*.json`)

### A1. Inserts (100k rows; 5 runs per cell; EL = monitorEventLoopDelay, 1 ms timer resolution subtracted)

| mode | batch | n batches | p50 ms | p95 ms | p99 ms | max ms | COMMIT p95/max ms | explicit ckpt p95/max (n) | rows/s (median run) | total s | ELdelay p50/p95/p99/max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wal | 1000 | 500 | 5.3 | 23.2 | 25.3 | 27.2 | 18.5/21.0 | - | 118781 | 0.84 | 4.3/21.9/24.1/26.2 |
| wal | 2000 | 250 | 10.6 | 32.3 | 36.9 | 39.7 | 22.0/24.9 | - | 125799 | 0.79 | 9.8/30.9/36.0/38.8 |
| wal | 5000 | 100 | 33.1 | 57.8 | 60.5 | 62.3 | 31.2/33.3 | - | 129874 | 0.77 | 34.3/54.3/59.6/61.4 |
| wal | 10000 | 50 | 76.1 | 87.0 | 95.2 | 95.2 | 38.8/40.9 | - | 134962 | 0.74 | 76.7/80.3/80.3/94.4 |
| wal | t15 (~3400 rows) | 151 | 16.9 | 38.6 | 41.5 | 41.6 | 23.5/26.4 | - | 135124 | 0.74 | 16.2/36.3/36.8/40.7 |
| wal-off | 1000 | 500 | 4.7 | 8.4 | 10.8 | 14.1 | 2.7/4.2 | - | 180706 | 0.55 | 3.8/7.2/9.2/13.1 |
| wal-off | 2000 | 250 | 9.9 | 16.1 | 18.9 | 22.2 | 4.0/5.1 | - | 188210 | 0.53 | 9.2/12.7/14.9/21.2 |
| wal-off | 5000 | 100 | 27.6 | 37.2 | 40.4 | 43.5 | 7.4/8.2 | - | 186003 | 0.54 | 26.4/29.7/33.7/43.1 |
| wal-off | 10000 | 50 | 50.2 | 53.5 | 59.8 | 59.8 | 8.3/8.6 | - | 202409 | 0.49 | 49.0/51.9/51.9/58.9 |
| wal-off | t15 (~3550 rows) | 142 | 16.8 | 19.7 | 20.3 | 20.4 | 4.6/5.3 | - | 201685 | 0.50 | 16.1/18.7/19.3/19.4 |
| wal-ckpt0 | 1000 | 500 | 4.9 | 7.1 | 7.8 | 9.5 | 0.9/2.7 | 67.2/67.6 (25) | 128828 | 0.78 | 3.9/6.2/58.0/66.6 |
| wal-ckpt0 | 2000 | 250 | 9.3 | 12.1 | 14.5 | 15.6 | 1.4/1.9 | 58.6/62.6 (25) | 142736 | 0.70 | 8.3/46.5/51.7/61.6 |
| wal-ckpt0 | 5000 | 100 | 25.9 | 38.1 | 44.1 | 46.0 | 3.1/3.6 | 54.7/58.4 (25) | 128277 | 0.78 | 25.4/50.2/52.8/57.5 |
| wal-ckpt0 | 10000 | 50 | 49.2 | 63.8 | 72.9 | 72.9 | 4.0/4.3 | 50.0/56.9 (25) | 141037 | 0.71 | 46.3/54.2/62.9/71.9 |
| wal-ckpt0 | t15 (~3500 rows) | 145 | 16.9 | 17.5 | 18.0 | 18.1 | 2.3/2.9 | 69.9/93.0 (24) | 147780 | 0.68 | 16.0/33.1/59.4/92.1 |
| wal-ckpt-big | 1000 | 500 | 5.0 | 7.9 | 8.4 | 9.1 | 1.0/1.5 | - | 176853 | 0.57 | 4.2/6.7/7.1/8.1 |
| wal-ckpt-big | 2000 | 250 | 9.5 | 11.1 | 12.1 | 12.4 | 1.4/2.5 | - | 205271 | 0.49 | 8.7/10.3/10.8/11.4 |
| wal-ckpt-big | 5000 | 100 | 24.6 | 37.6 | 39.6 | 39.7 | 3.4/4.4 | - | 193785 | 0.52 | 23.8/29.9/35.5/38.7 |
| wal-ckpt-big | 10000 | 50 | 50.0 | 65.5 | 68.7 | 68.7 | 4.9/5.0 | - | 193402 | 0.52 | 51.4/62.1/62.1/67.7 |
| wal-ckpt-big | t15 (~3350 rows) | 155 | 17.2 | 18.0 | 19.7 | 19.8 | 2.9/4.6 | - | 193929 | 0.52 | 16.3/16.9/17.6/18.8 |
| wal-full | 1000 | 500 | 6.5 | 17.0 | 20.0 | 34.2 | 12.5/21.6 | - | 120588 | 0.83 | 5.5/16.6/18.2/33.2 |
| wal-full | 2000 | 250 | 14.1 | 27.7 | 30.4 | 32.5 | 16.4/20.7 | - | 120643 | 0.83 | 13.3/26.7/29.5/31.6 |
| wal-full | 5000 | 100 | 33.9 | 51.1 | 62.1 | 67.0 | 26.7/32.5 | - | 129214 | 0.77 | 37.5/50.2/52.7/66.0 |
| wal-full | 10000 | 50 | 73.7 | 92.7 | 101.7 | 101.7 | 33.8/34.4 | - | 134799 | 0.74 | 72.8/91.2/91.2/100.8 |
| wal-full | t15 (~3500 rows) | 148 | 21.4 | 34.4 | 36.4 | 53.1 | 19.3/38.0 | - | 132615 | 0.75 | 20.8/33.3/35.4/52.1 |
| default | 1000 | 500 | 9.7 | 12.8 | 15.1 | 24.0 | 6.6/19.0 | - | 100973 | 0.99 | 8.8/11.2/13.3/23.0 |
| default | 2000 | 250 | 18.0 | 24.8 | 28.1 | 30.4 | 10.4/12.7 | - | 106526 | 0.94 | 17.2/23.3/26.3/29.9 |
| default | 5000 | 100 | 38.9 | 50.8 | 54.6 | 55.0 | 14.9/15.8 | - | 126177 | 0.79 | 37.7/49.9/52.3/54.1 |
| default | 10000 | 50 | 70.3 | 91.6 | 108.4 | 108.4 | 24.8/25.3 | - | 145773 | 0.69 | 70.5/83.1/83.1/107.5 |
| default | t15 (~2550 rows) | 197 | 22.9 | 29.0 | 41.0 | 67.0 | 12.4/49.0 | - | 113086 | 0.88 | 21.5/24.0/28.6/66.0 |

### A1b. Insert soak (20 runs x 50 batches of 2000 rows per mode)

| mode | batch | n batches | p50 ms | p95 ms | p99 ms | max ms | COMMIT p95/max ms | explicit ckpt p95/max (n) | rows/s (median run) | total s | ELdelay p50/p95/p99/max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wal | 2000 | 1000 | 13.9 | 37.4 | 41.0 | 89.3 | 25.1/80.6 | - | 109547 | 0.91 | 11.7/36.0/38.7/88.4 |
| wal-off | 2000 | 1000 | 10.3 | 16.5 | 20.2 | 27.3 | 5.2/18.6 | - | 181776 | 0.55 | 9.4/13.1/15.4/26.6 |
| default | 2000 | 1000 | 18.8 | 26.3 | 29.6 | 45.6 | 11.1/18.9 | - | 103766 | 0.96 | 17.5/24.4/26.6/44.6 |

### A1c. Cold start (fresh process, 4 consecutive 2000-row batches)

| batch # | p50 ms | p95 ms | max ms (n=7 fresh processes) |
| --- | --- | --- | --- |
| 1 (cold) | 9.0 | 14.9 | 14.9 |
| 2 | 9.2 | 10.1 | 10.1 |
| 3 | 9.2 | 11.3 | 11.3 |
| 4 | 9.2 | 10.3 | 10.3 |

### A2. Fresh-row detection strategies

| scenario | batch | strategy | p50 ms | p95 ms | p99 ms | max ms | fresh set correct | table state = F0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fresh | 2000 | F0 upsert, no detection | 15.2 | 39.3 | 48.2 | 51.4 | - | yes |
| fresh | 2000 | F0g guarded upsert, no detection | 13.3 | 40.3 | 42.6 | 45.1 | - | yes |
| fresh | 2000 | F1 pre-SELECT IN(5000) + upsert | 16.6 | 41.1 | 48.3 | 52.5 | yes | yes |
| fresh | 2000 | F2 upsert + run().lastInsertRowid | 14.7 | 40.1 | 41.8 | 46.8 | yes | yes |
| fresh | 2000 | F2g guarded upsert + run().lastInsertRowid | 14.4 | 39.3 | 43.4 | 44.5 | yes | yes |
| fresh | 2000 | F3 upsert RETURNING rowid (get) | 23.5 | 51.2 | 58.5 | 62.2 | yes | yes |
| fresh | 2000 | F4 DO NOTHING + changes, UPDATE on conflict | 14.3 | 38.3 | 41.5 | 43.5 | yes | yes |
| fresh | 2000 | F4g DO NOTHING + changes, guarded UPDATE on conflict | 14.9 | 39.3 | 42.1 | 42.3 | yes | yes |
| fresh | 2000 | F5 DO NOTHING RETURNING id (get), UPDATE on conflict | 20.3 | 43.4 | 59.2 | 60.3 | yes | yes |
| fresh | 2000 | F6 INSERT OR IGNORE + changes (no max upsert) | 15.8 | 40.2 | 42.3 | 49.8 | yes | no |
| fresh | 2000 | F8 multi-row upsert RETURNING id,rowid (all) | 12.8 | 40.1 | 45.3 | 49.6 | yes | yes |
| fresh | 5000 | F0 upsert, no detection | 52.6 | 69.8 | 90.1 | 90.1 | - | yes |
| fresh | 5000 | F0g guarded upsert, no detection | 54.0 | 70.3 | 75.4 | 75.4 | - | yes |
| fresh | 5000 | F1 pre-SELECT IN(5000) + upsert | 60.6 | 75.7 | 80.3 | 80.3 | yes | yes |
| fresh | 5000 | F2 upsert + run().lastInsertRowid | 54.3 | 66.9 | 74.3 | 74.3 | yes | yes |
| fresh | 5000 | F2g guarded upsert + run().lastInsertRowid | 54.2 | 67.8 | 73.2 | 73.2 | yes | yes |
| fresh | 5000 | F3 upsert RETURNING rowid (get) | 82.0 | 111.0 | 117.3 | 117.3 | yes | yes |
| fresh | 5000 | F4 DO NOTHING + changes, UPDATE on conflict | 53.8 | 72.9 | 74.0 | 74.0 | yes | yes |
| fresh | 5000 | F4g DO NOTHING + changes, guarded UPDATE on conflict | 55.8 | 71.1 | 80.4 | 80.4 | yes | yes |
| fresh | 5000 | F5 DO NOTHING RETURNING id (get), UPDATE on conflict | 78.8 | 107.3 | 134.2 | 134.2 | yes | yes |
| fresh | 5000 | F6 INSERT OR IGNORE + changes (no max upsert) | 54.3 | 69.8 | 75.9 | 75.9 | yes | no |
| fresh | 5000 | F8 multi-row upsert RETURNING id,rowid (all) | 60.1 | 73.9 | 117.0 | 117.0 | yes | yes |
| mixed | 2000 | F0 upsert, no detection | 42.4 | 57.0 | 59.3 | 59.5 | - | yes |
| mixed | 2000 | F0g guarded upsert, no detection | 41.6 | 58.2 | 66.6 | 69.8 | - | yes |
| mixed | 2000 | F1 pre-SELECT IN(5000) + upsert | 48.0 | 60.0 | 63.8 | 65.7 | yes | yes |
| mixed | 2000 | F2 upsert + run().lastInsertRowid | 42.0 | 67.9 | 93.8 | 110.6 | yes | yes |
| mixed | 2000 | F2g guarded upsert + run().lastInsertRowid | 41.5 | 57.1 | 64.8 | 73.2 | yes | yes |
| mixed | 2000 | F3 upsert RETURNING rowid (get) | 45.8 | 63.3 | 64.7 | 70.1 | yes | yes |
| mixed | 2000 | F4 DO NOTHING + changes, UPDATE on conflict | 43.2 | 57.7 | 64.6 | 66.4 | yes | yes |
| mixed | 2000 | F4g DO NOTHING + changes, guarded UPDATE on conflict | 43.8 | 61.6 | 68.2 | 93.5 | yes | yes |
| mixed | 2000 | F5 DO NOTHING RETURNING id (get), UPDATE on conflict | 48.8 | 66.3 | 82.8 | 220.2 | yes | yes |
| mixed | 2000 | F6 INSERT OR IGNORE + changes (no max upsert) | 11.1 | 37.9 | 40.3 | 45.3 | yes | no |
| mixed | 2000 | F8 multi-row upsert RETURNING id,rowid (all) | 46.3 | 62.4 | 150.1 | 264.0 | yes | yes |
| mixed | 5000 | F0 upsert, no detection | 75.3 | 105.6 | 120.5 | 120.5 | - | yes |
| mixed | 5000 | F0g guarded upsert, no detection | 81.7 | 108.2 | 127.2 | 127.2 | - | yes |
| mixed | 5000 | F1 pre-SELECT IN(5000) + upsert | 95.0 | 117.1 | 132.3 | 132.3 | yes | yes |
| mixed | 5000 | F2 upsert + run().lastInsertRowid | 81.7 | 113.5 | 118.7 | 118.7 | yes | yes |
| mixed | 5000 | F2g guarded upsert + run().lastInsertRowid | 88.1 | 119.8 | 131.6 | 131.6 | yes | yes |
| mixed | 5000 | F3 upsert RETURNING rowid (get) | 109.4 | 146.0 | 154.4 | 154.4 | yes | yes |
| mixed | 5000 | F4 DO NOTHING + changes, UPDATE on conflict | 86.7 | 122.5 | 132.7 | 132.7 | yes | yes |
| mixed | 5000 | F4g DO NOTHING + changes, guarded UPDATE on conflict | 88.0 | 120.3 | 121.2 | 121.2 | yes | yes |
| mixed | 5000 | F5 DO NOTHING RETURNING id (get), UPDATE on conflict | 104.5 | 131.7 | 158.5 | 158.5 | yes | yes |
| mixed | 5000 | F6 INSERT OR IGNORE + changes (no max upsert) | 50.8 | 67.3 | 70.8 | 70.8 | yes | no |
| mixed | 5000 | F8 multi-row upsert RETURNING id,rowid (all) | 100.1 | 133.0 | 139.1 | 139.1 | yes | yes |
| reingest | 2000 | F0 upsert, no detection | 7.2 | 9.7 | 9.8 | 10.0 | - | yes |
| reingest | 2000 | F0g guarded upsert, no detection | 4.6 | 8.5 | 8.8 | 8.8 | - | yes |
| reingest | 2000 | F1 pre-SELECT IN(5000) + upsert | 10.9 | 15.6 | 16.7 | 17.3 | yes | yes |
| reingest | 2000 | F2 upsert + run().lastInsertRowid | 8.5 | 10.2 | 10.5 | 10.9 | yes | yes |
| reingest | 2000 | F2g guarded upsert + run().lastInsertRowid | 4.9 | 8.2 | 8.7 | 8.8 | yes | yes |
| reingest | 2000 | F3 upsert RETURNING rowid (get) | 8.9 | 13.3 | 13.5 | 13.5 | yes | yes |
| reingest | 2000 | F4 DO NOTHING + changes, UPDATE on conflict | 7.6 | 13.3 | 14.8 | 15.2 | yes | yes |
| reingest | 2000 | F4g DO NOTHING + changes, guarded UPDATE on conflict | 6.5 | 10.7 | 11.3 | 11.9 | yes | yes |
| reingest | 2000 | F5 DO NOTHING RETURNING id (get), UPDATE on conflict | 9.4 | 14.8 | 16.0 | 16.2 | yes | yes |
| reingest | 2000 | F6 INSERT OR IGNORE + changes (no max upsert) | 4.6 | 7.5 | 8.2 | 8.3 | yes | yes |
| reingest | 2000 | F8 multi-row upsert RETURNING id,rowid (all) | 9.2 | 16.4 | 24.1 | 25.9 | yes | yes |
| reingest | 5000 | F0 upsert, no detection | 23.0 | 31.0 | 44.6 | 44.6 | - | yes |
| reingest | 5000 | F0g guarded upsert, no detection | 17.8 | 19.3 | 20.1 | 20.1 | - | yes |
| reingest | 5000 | F1 pre-SELECT IN(5000) + upsert | 28.8 | 34.4 | 38.4 | 38.4 | yes | yes |
| reingest | 5000 | F2 upsert + run().lastInsertRowid | 15.6 | 22.2 | 23.9 | 23.9 | yes | yes |
| reingest | 5000 | F2g guarded upsert + run().lastInsertRowid | 12.8 | 20.4 | 20.7 | 20.7 | yes | yes |
| reingest | 5000 | F3 upsert RETURNING rowid (get) | 25.7 | 34.3 | 35.3 | 35.3 | yes | yes |
| reingest | 5000 | F4 DO NOTHING + changes, UPDATE on conflict | 20.8 | 33.7 | 35.8 | 35.8 | yes | yes |
| reingest | 5000 | F4g DO NOTHING + changes, guarded UPDATE on conflict | 16.2 | 27.9 | 29.3 | 29.3 | yes | yes |
| reingest | 5000 | F5 DO NOTHING RETURNING id (get), UPDATE on conflict | 24.7 | 39.2 | 42.3 | 42.3 | yes | yes |
| reingest | 5000 | F6 INSERT OR IGNORE + changes (no max upsert) | 10.0 | 17.9 | 18.5 | 18.5 | yes | yes |
| reingest | 5000 | F8 multi-row upsert RETURNING id,rowid (all) | 17.7 | 30.5 | 49.3 | 49.3 | yes | yes |

### A3. Snapshot reads, clustered data (50k raw + 5k rollups; ms)

| scenario | variant | rows from SQLite | cold ms (run 1) | p50 ms | p95 ms | max ms | event-loop block when sliced | heap growth during call MB (uncollected) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| range 365d (default; all rows) | raw all() obj naive-local | 53876 | 318.6 | 301.2 | 393.6 | 393.6 | - | 59.1 |
| range 365d (default; all rows) | raw iterate() obj naive-local | 53876 | 332.7 | 291.5 | 314.6 | 314.6 | - | 16.4 |
| range 365d (default; all rows) | raw all() obj cached-local | 53876 | 313.2 | 262.4 | 286.0 | 286.0 | - | 72.7 |
| range 365d (default; all rows) | raw iterate() obj cached-local | 53876 | 451.5 | 298.9 | 456.6 | 456.6 | - | 11.9 |
| range 365d (default; all rows) | sql15 all() obj cached-local | 6314 | 87.3 | 91.9 | 118.8 | 118.8 | - | 8.9 |
| range 365d (default; all rows) | sql15 iterate() obj cached-local | 6314 | 119.3 | 108.9 | 127.7 | 127.7 | - | 12.7 |
| range 365d (default; all rows) | raw all() obj (fetch only) | 53876 | 269.9 | 157.7 | 218.7 | 218.7 | - | 57.7 |
| range 365d (default; all rows) | raw iterate() obj (fetch only) | 53876 | 199.8 | 180.9 | 203.7 | 203.7 | - | 12.0 |
| range 365d (default; all rows) | sql15 all() obj (fetch only) | 6314 | 76.6 | 73.7 | 119.2 | 119.2 | - | 6.6 |
| range 365d (default; all rows) | raw all() arr naive-local | 53876 | 208.9 | 137.8 | 144.9 | 144.9 | - | 27.1 |
| range 365d (default; all rows) | raw iterate() arr naive-local | 53876 | 156.7 | 151.8 | 223.6 | 223.6 | - | 13.7 |
| range 365d (default; all rows) | raw all() arr cached-local | 53876 | 171.8 | 107.0 | 126.0 | 126.0 | - | 23.2 |
| range 365d (default; all rows) | raw iterate() arr cached-local | 53876 | 107.5 | 109.1 | 112.4 | 112.4 | - | 15.0 |
| range 365d (default; all rows) | sql15 all() arr cached-local | 6314 | 72.6 | 73.1 | 78.3 | 78.3 | - | 4.3 |
| range 365d (default; all rows) | sql15 iterate() arr cached-local | 6314 | 72.4 | 80.1 | 87.9 | 87.9 | - | 5.7 |
| range 365d (default; all rows) | raw all() arr (fetch only) | 53876 | 85.5 | 91.6 | 98.0 | 98.0 | - | 18.2 |
| range 365d (default; all rows) | raw iterate() arr (fetch only) | 53876 | 104.4 | 85.9 | 94.2 | 94.2 | - | 15.2 |
| range 365d (default; all rows) | sql15 all() arr (fetch only) | 6314 | 71.6 | 75.3 | 108.0 | 108.0 | - | 1.9 |
| range 365d (default; all rows) | raw-ordered iterate() obj cached-local | 53876 | 258.8 | 250.0 | 259.4 | 259.4 | - | 15.2 |
| range 365d (default; all rows) | raw sliced 7d windows + yields obj | 53876 | n/a | 266.1 | 275.9 | 275.9 | slice p95 22.1 / max 31.5 | - |
| range 365d (default; all rows) | raw sliced 7d windows + yields arr | 53876 | n/a | 116.0 | 118.9 | 118.9 | slice p95 9.6 / max 16.5 | - |
| range 365d (default; all rows) | sql15 sliced 7d windows + yields obj | 6314 | n/a | 88.5 | 102.0 | 102.0 | slice p95 6.0 / max 9.5 | - |
| range 365d (default; all rows) | sql15 sliced 7d windows + yields arr | 6314 | n/a | 69.9 | 81.9 | 81.9 | slice p95 5.2 / max 8.7 | - |
| range 30d | raw all() obj naive-local | 19183 | 91.1 | 89.3 | 139.7 | 139.7 | - | 21.1 |
| range 30d | raw iterate() obj naive-local | 19183 | 98.5 | 102.6 | 160.8 | 160.8 | - | 13.6 |
| range 30d | raw all() obj cached-local | 19183 | 76.2 | 72.7 | 85.9 | 85.9 | - | 25.9 |
| range 30d | raw iterate() obj cached-local | 19183 | 86.4 | 88.9 | 100.2 | 100.2 | - | 6.4 |
| range 30d | sql15 all() obj cached-local | 935 | 22.9 | 21.8 | 26.3 | 26.3 | - | 1.6 |
| range 30d | sql15 iterate() obj cached-local | 935 | 24.2 | 36.1 | 39.1 | 39.1 | - | 2.2 |
| range 30d | raw all() obj (fetch only) | 19183 | 47.7 | 45.6 | 67.9 | 67.9 | - | 20.6 |
| range 30d | raw iterate() obj (fetch only) | 19183 | 55.6 | 60.5 | 63.8 | 63.8 | - | 16.6 |
| range 30d | sql15 all() obj (fetch only) | 935 | 18.9 | 21.2 | 21.7 | 21.7 | - | 1.0 |
| range 30d | raw all() arr naive-local | 19183 | 40.8 | 39.7 | 40.7 | 40.7 | - | 10.0 |
| range 30d | raw iterate() arr naive-local | 19183 | 47.5 | 49.8 | 64.7 | 64.7 | - | 8.0 |
| range 30d | raw all() arr cached-local | 19183 | 29.0 | 29.3 | 40.8 | 40.8 | - | 11.9 |
| range 30d | raw iterate() arr cached-local | 19183 | 39.8 | 53.7 | 62.5 | 62.5 | - | 16.4 |
| range 30d | sql15 all() arr cached-local | 935 | 22.9 | 27.3 | 33.5 | 33.5 | - | 0.9 |
| range 30d | sql15 iterate() arr cached-local | 935 | 27.1 | 21.6 | 34.1 | 34.1 | - | 1.1 |
| range 30d | raw all() arr (fetch only) | 19183 | 21.7 | 22.5 | 27.7 | 27.7 | - | 6.6 |
| range 30d | raw iterate() arr (fetch only) | 19183 | 29.2 | 29.0 | 30.3 | 30.3 | - | 11.1 |
| range 30d | sql15 all() arr (fetch only) | 935 | 20.1 | 19.9 | 22.7 | 22.7 | - | 0.3 |
| range 30d | raw-ordered iterate() obj cached-local | 19183 | 82.6 | 88.6 | 121.6 | 121.6 | - | 6.4 |
| range 30d | raw sliced 7d windows + yields obj | 19183 | n/a | 96.1 | 119.0 | 119.0 | slice p95 32.6 / max 36.4 | - |
| range 30d | raw sliced 7d windows + yields arr | 19183 | n/a | 41.8 | 54.8 | 54.8 | slice p95 14.2 / max 20.7 | - |
| range 30d | sql15 sliced 7d windows + yields obj | 935 | n/a | 24.9 | 26.3 | 26.3 | slice p95 7.0 / max 7.8 | - |
| range 30d | sql15 sliced 7d windows + yields arr | 935 | n/a | 22.5 | 24.6 | 24.6 | slice p95 6.9 / max 7.1 | - |
| 365d + 3 models | raw all() obj naive-local | 30008 | 239.0 | 141.7 | 178.9 | 178.9 | - | 34.0 |
| 365d + 3 models | raw iterate() obj naive-local | 30008 | 165.9 | 163.3 | 171.0 | 171.0 | - | 7.8 |
| 365d + 3 models | raw all() obj cached-local | 30008 | 128.6 | 122.9 | 149.9 | 149.9 | - | 38.5 |
| 365d + 3 models | raw iterate() obj cached-local | 30008 | 185.1 | 157.5 | 208.2 | 208.2 | - | 12.5 |
| 365d + 3 models | sql15 all() obj cached-local | 3329 | 57.7 | 50.7 | 52.1 | 52.1 | - | 5.0 |
| 365d + 3 models | sql15 iterate() obj cached-local | 3329 | 56.4 | 56.8 | 61.7 | 61.7 | - | 7.0 |
| 365d + 3 models | raw all() obj (fetch only) | 30008 | 75.0 | 77.5 | 102.4 | 102.4 | - | 32.3 |
| 365d + 3 models | raw iterate() obj (fetch only) | 30008 | 107.2 | 108.6 | 134.4 | 134.4 | - | 19.2 |
| 365d + 3 models | sql15 all() obj (fetch only) | 3329 | 47.6 | 53.8 | 65.4 | 65.4 | - | 3.5 |
| 365d + 3 models | raw all() arr naive-local | 30008 | 83.4 | 97.5 | 104.3 | 104.3 | - | 19.2 |
| 365d + 3 models | raw iterate() arr naive-local | 30008 | 127.6 | 88.4 | 93.2 | 93.2 | - | 6.0 |
| 365d + 3 models | raw all() arr cached-local | 30008 | 55.3 | 60.2 | 91.5 | 91.5 | - | 13.6 |
| 365d + 3 models | raw iterate() arr cached-local | 30008 | 75.3 | 76.6 | 111.6 | 111.6 | - | 10.6 |
| 365d + 3 models | sql15 all() arr cached-local | 3329 | 62.0 | 46.9 | 52.2 | 52.2 | - | 2.5 |
| 365d + 3 models | sql15 iterate() arr cached-local | 3329 | 48.2 | 56.5 | 67.9 | 67.9 | - | 3.3 |
| 365d + 3 models | raw all() arr (fetch only) | 30008 | 60.5 | 45.3 | 69.6 | 69.6 | - | 10.3 |
| 365d + 3 models | raw iterate() arr (fetch only) | 30008 | 85.2 | 82.0 | 96.9 | 96.9 | - | 17.4 |
| 365d + 3 models | sql15 all() arr (fetch only) | 3329 | 48.0 | 47.8 | 57.0 | 57.0 | - | 1.0 |
| 365d + 3 models | raw-ordered iterate() obj cached-local | 30008 | 173.6 | 184.4 | 235.0 | 235.0 | - | 12.5 |
| 365d + 3 models | raw sliced 7d windows + yields obj | 30008 | n/a | 202.1 | 218.8 | 218.8 | slice p95 17.6 / max 28.1 | - |
| 365d + 3 models | raw sliced 7d windows + yields arr | 30008 | n/a | 88.5 | 98.5 | 98.5 | slice p95 8.1 / max 11.8 | - |
| 365d + 3 models | sql15 sliced 7d windows + yields obj | 3329 | n/a | 54.7 | 56.6 | 56.6 | slice p95 3.9 / max 5.7 | - |
| 365d + 3 models | sql15 sliced 7d windows + yields arr | 3329 | n/a | 44.7 | 48.4 | 48.4 | slice p95 3.5 / max 4.8 | - |
| 365d + 3 models + 5 repos | raw all() obj naive-local | 9461 | 46.5 | 46.5 | 48.2 | 48.2 | - | 10.8 |
| 365d + 3 models + 5 repos | raw iterate() obj naive-local | 9461 | 62.9 | 68.8 | 84.8 | 84.8 | - | 6.8 |
| 365d + 3 models + 5 repos | raw all() obj cached-local | 9461 | 39.4 | 40.4 | 52.3 | 52.3 | - | 13.3 |
| 365d + 3 models + 5 repos | raw iterate() obj cached-local | 9461 | 73.7 | 84.3 | 96.2 | 96.2 | - | 3.5 |
| 365d + 3 models + 5 repos | sql15 all() obj cached-local | 1118 | 39.6 | 38.9 | 40.6 | 40.6 | - | 1.8 |
| 365d + 3 models + 5 repos | sql15 iterate() obj cached-local | 1118 | 26.6 | 26.0 | 39.1 | 39.1 | - | 2.5 |
| 365d + 3 models + 5 repos | raw all() obj (fetch only) | 9461 | 46.3 | 46.5 | 52.6 | 52.6 | - | 10.3 |
| 365d + 3 models + 5 repos | raw iterate() obj (fetch only) | 9461 | 73.9 | 45.4 | 49.9 | 49.9 | - | 16.0 |
| 365d + 3 models + 5 repos | sql15 all() obj (fetch only) | 1118 | 22.7 | 25.9 | 36.7 | 36.7 | - | 1.2 |
| 365d + 3 models + 5 repos | raw all() arr naive-local | 9461 | 30.8 | 32.6 | 48.2 | 48.2 | - | 9.8 |
| 365d + 3 models + 5 repos | raw iterate() arr naive-local | 9461 | 45.9 | 46.9 | 60.4 | 60.4 | - | 12.0 |
| 365d + 3 models + 5 repos | raw all() arr cached-local | 9461 | 42.7 | 41.9 | 43.3 | 43.3 | - | 6.4 |
| 365d + 3 models + 5 repos | raw iterate() arr cached-local | 9461 | 31.5 | 31.3 | 31.9 | 31.9 | - | 8.6 |
| 365d + 3 models + 5 repos | sql15 all() arr cached-local | 1118 | 23.0 | 22.3 | 22.9 | 22.9 | - | 1.0 |
| 365d + 3 models + 5 repos | sql15 iterate() arr cached-local | 1118 | 23.3 | 23.7 | 33.7 | 33.7 | - | 1.3 |
| 365d + 3 models + 5 repos | raw all() arr (fetch only) | 9461 | 21.7 | 22.4 | 24.1 | 24.1 | - | 3.3 |
| 365d + 3 models + 5 repos | raw iterate() arr (fetch only) | 9461 | 25.6 | 28.7 | 40.2 | 40.2 | - | 5.6 |
| 365d + 3 models + 5 repos | sql15 all() arr (fetch only) | 1118 | 22.7 | 34.9 | 35.7 | 35.7 | - | 0.3 |
| 365d + 3 models + 5 repos | raw-ordered iterate() obj cached-local | 9461 | 56.2 | 56.7 | 69.8 | 69.8 | - | 3.5 |
| 365d + 3 models + 5 repos | raw sliced 7d windows + yields obj | 9461 | n/a | 63.9 | 67.2 | 67.2 | slice p95 5.4 / max 8.4 | - |
| 365d + 3 models + 5 repos | raw sliced 7d windows + yields arr | 9461 | n/a | 36.1 | 39.9 | 39.9 | slice p95 2.9 / max 5.2 | - |
| 365d + 3 models + 5 repos | sql15 sliced 7d windows + yields obj | 1118 | n/a | 30.2 | 34.2 | 34.2 | slice p95 2.1 / max 3.4 | - |
| 365d + 3 models + 5 repos | sql15 sliced 7d windows + yields arr | 1118 | n/a | 26.4 | 28.1 | 28.1 | slice p95 1.9 / max 3.0 | - |

### A3. Snapshot reads, uniform data (50k raw + 5k rollups; ms)

| scenario | variant | rows from SQLite | cold ms (run 1) | p50 ms | p95 ms | max ms | event-loop block when sliced | heap growth during call MB (uncollected) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| range 365d (default; all rows) | raw all() obj naive-local | 53876 | 384.4 | 388.5 | 447.9 | 447.9 | - | 65.7 |
| range 365d (default; all rows) | raw iterate() obj naive-local | 53876 | 488.0 | 385.4 | 426.9 | 426.9 | - | 25.4 |
| range 365d (default; all rows) | raw all() obj cached-local | 53876 | 381.7 | 328.0 | 403.5 | 403.5 | - | 69.8 |
| range 365d (default; all rows) | raw iterate() obj cached-local | 53876 | 354.0 | 384.7 | 482.7 | 482.7 | - | 25.2 |
| range 365d (default; all rows) | sql15 all() obj cached-local | 53861 | 431.3 | 445.5 | 464.4 | 464.4 | - | 69.7 |
| range 365d (default; all rows) | sql15 iterate() obj cached-local | 53861 | 431.5 | 480.1 | 581.1 | 581.1 | - | 25.2 |
| range 365d (default; all rows) | raw all() obj (fetch only) | 53876 | 204.7 | 197.7 | 216.9 | 216.9 | - | 57.5 |
| range 365d (default; all rows) | raw iterate() obj (fetch only) | 53876 | 216.6 | 229.1 | 253.3 | 253.3 | - | 11.8 |
| range 365d (default; all rows) | sql15 all() obj (fetch only) | 53861 | 331.0 | 316.2 | 345.4 | 345.4 | - | 57.5 |
| range 365d (default; all rows) | raw all() arr naive-local | 53876 | 215.3 | 235.8 | 283.4 | 283.4 | - | 31.5 |
| range 365d (default; all rows) | raw iterate() arr naive-local | 53876 | 248.1 | 232.7 | 334.0 | 334.0 | - | 20.8 |
| range 365d (default; all rows) | raw all() arr cached-local | 53876 | 199.3 | 209.3 | 224.7 | 224.7 | - | 30.3 |
| range 365d (default; all rows) | raw iterate() arr cached-local | 53876 | 211.1 | 211.6 | 256.9 | 256.9 | - | 12.1 |
| range 365d (default; all rows) | sql15 all() arr cached-local | 53861 | 278.7 | 311.4 | 331.4 | 331.4 | - | 26.8 |
| range 365d (default; all rows) | sql15 iterate() arr cached-local | 53861 | 310.9 | 295.1 | 331.2 | 331.2 | - | 12.2 |
| range 365d (default; all rows) | raw all() arr (fetch only) | 53876 | 143.0 | 142.9 | 167.2 | 167.2 | - | 18.0 |
| range 365d (default; all rows) | raw iterate() arr (fetch only) | 53876 | 154.2 | 150.6 | 185.6 | 185.6 | - | 15.1 |
| range 365d (default; all rows) | sql15 all() arr (fetch only) | 53861 | 245.3 | 223.2 | 256.7 | 256.7 | - | 18.0 |
| range 365d (default; all rows) | raw-ordered iterate() obj cached-local | 53876 | 393.8 | 362.3 | 414.2 | 414.2 | - | 28.8 |
| range 365d (default; all rows) | raw sliced 7d windows + yields obj | 53876 | n/a | 379.9 | 415.4 | 415.4 | slice p95 27.2 / max 74.6 | - |
| range 365d (default; all rows) | raw sliced 7d windows + yields arr | 53876 | n/a | 219.3 | 292.0 | 292.0 | slice p95 17.5 / max 36.5 | - |
| range 365d (default; all rows) | sql15 sliced 7d windows + yields obj | 53861 | n/a | 442.1 | 450.9 | 450.9 | slice p95 31.8 / max 46.6 | - |
| range 365d (default; all rows) | sql15 sliced 7d windows + yields arr | 53861 | n/a | 295.1 | 319.1 | 319.1 | slice p95 21.8 / max 35.8 | - |
| range 30d | raw all() obj naive-local | 16781 | 98.7 | 106.3 | 160.4 | 160.4 | - | 29.5 |
| range 30d | raw iterate() obj naive-local | 16781 | 116.9 | 111.9 | 138.4 | 138.4 | - | 10.9 |
| range 30d | raw all() obj cached-local | 16781 | 89.3 | 98.1 | 107.2 | 107.2 | - | 24.3 |
| range 30d | raw iterate() obj cached-local | 16781 | 109.0 | 109.8 | 157.4 | 157.4 | - | 6.5 |
| range 30d | sql15 all() obj cached-local | 16771 | 119.7 | 119.8 | 120.3 | 120.3 | - | 24.3 |
| range 30d | sql15 iterate() obj cached-local | 16771 | 123.3 | 127.3 | 130.4 | 130.4 | - | 6.5 |
| range 30d | raw all() obj (fetch only) | 16781 | 61.5 | 61.3 | 65.5 | 65.5 | - | 18.0 |
| range 30d | raw iterate() obj (fetch only) | 16781 | 72.3 | 70.6 | 73.7 | 73.7 | - | 12.5 |
| range 30d | sql15 all() obj (fetch only) | 16771 | 83.1 | 87.5 | 95.0 | 95.0 | - | 18.0 |
| range 30d | raw all() arr naive-local | 16781 | 56.2 | 52.8 | 55.6 | 55.6 | - | 8.1 |
| range 30d | raw iterate() arr naive-local | 16781 | 68.0 | 67.0 | 74.6 | 74.6 | - | 6.8 |
| range 30d | raw all() arr cached-local | 16781 | 54.6 | 47.6 | 68.2 | 68.2 | - | 12.0 |
| range 30d | raw iterate() arr cached-local | 16781 | 57.3 | 59.9 | 74.8 | 74.8 | - | 16.0 |
| range 30d | sql15 all() arr cached-local | 16771 | 83.4 | 72.4 | 81.7 | 81.7 | - | 12.0 |
| range 30d | sql15 iterate() arr cached-local | 16771 | 94.9 | 90.2 | 116.5 | 116.5 | - | 16.0 |
| range 30d | raw all() arr (fetch only) | 16781 | 37.6 | 35.7 | 43.6 | 43.6 | - | 5.7 |
| range 30d | raw iterate() arr (fetch only) | 16781 | 42.6 | 44.5 | 47.1 | 47.1 | - | 9.7 |
| range 30d | sql15 all() arr (fetch only) | 16771 | 60.0 | 61.6 | 95.8 | 95.8 | - | 5.7 |
| range 30d | raw-ordered iterate() obj cached-local | 16781 | 108.5 | 110.4 | 120.3 | 120.3 | - | 6.5 |
| range 30d | raw sliced 7d windows + yields obj | 16781 | n/a | 112.0 | 151.7 | 151.7 | slice p95 38.1 / max 40.1 | - |
| range 30d | raw sliced 7d windows + yields arr | 16781 | n/a | 63.7 | 87.4 | 87.4 | slice p95 20.0 / max 20.9 | - |
| range 30d | sql15 sliced 7d windows + yields obj | 16771 | n/a | 131.9 | 146.5 | 146.5 | slice p95 34.6 / max 38.1 | - |
| range 30d | sql15 sliced 7d windows + yields arr | 16771 | n/a | 94.6 | 125.0 | 125.0 | slice p95 28.7 / max 29.2 | - |
| 365d + 3 models | raw all() obj naive-local | 14635 | 115.0 | 123.7 | 128.6 | 128.6 | - | 23.8 |
| 365d + 3 models | raw iterate() obj naive-local | 14635 | 145.7 | 158.2 | 186.0 | 186.0 | - | 5.1 |
| 365d + 3 models | raw all() obj cached-local | 14635 | 118.5 | 119.4 | 137.3 | 137.3 | - | 21.8 |
| 365d + 3 models | raw iterate() obj cached-local | 14635 | 143.2 | 154.4 | 178.9 | 178.9 | - | 17.6 |
| 365d + 3 models | sql15 all() obj cached-local | 14631 | 129.9 | 144.4 | 164.7 | 164.7 | - | 21.8 |
| 365d + 3 models | sql15 iterate() obj cached-local | 14631 | 188.0 | 171.8 | 200.5 | 200.5 | - | 17.6 |
| 365d + 3 models | raw all() obj (fetch only) | 14635 | 85.1 | 95.2 | 110.7 | 110.7 | - | 15.6 |
| 365d + 3 models | raw iterate() obj (fetch only) | 14635 | 109.7 | 105.2 | 124.6 | 124.6 | - | 8.8 |
| 365d + 3 models | sql15 all() obj (fetch only) | 14631 | 113.1 | 99.1 | 111.5 | 111.5 | - | 15.6 |
| 365d + 3 models | raw all() arr naive-local | 14635 | 86.3 | 87.3 | 95.9 | 95.9 | - | 14.8 |
| 365d + 3 models | raw iterate() arr naive-local | 14635 | 127.3 | 103.6 | 137.5 | 137.5 | - | 3.8 |
| 365d + 3 models | raw all() arr cached-local | 14635 | 82.8 | 87.2 | 119.9 | 119.9 | - | 12.4 |
| 365d + 3 models | raw iterate() arr cached-local | 14635 | 111.6 | 103.3 | 120.6 | 120.6 | - | 15.8 |
| 365d + 3 models | sql15 all() arr cached-local | 14631 | 101.7 | 107.5 | 137.4 | 137.4 | - | 12.4 |
| 365d + 3 models | sql15 iterate() arr cached-local | 14631 | 119.6 | 111.8 | 122.0 | 122.0 | - | 15.8 |
| 365d + 3 models | raw all() arr (fetch only) | 14635 | 71.7 | 73.2 | 83.1 | 83.1 | - | 4.9 |
| 365d + 3 models | raw iterate() arr (fetch only) | 14635 | 91.0 | 78.8 | 94.3 | 94.3 | - | 8.4 |
| 365d + 3 models | sql15 all() arr (fetch only) | 14631 | 90.9 | 90.0 | 104.8 | 104.8 | - | 4.9 |
| 365d + 3 models | raw-ordered iterate() obj cached-local | 14635 | 138.9 | 139.6 | 147.5 | 147.5 | - | 17.6 |
| 365d + 3 models | raw sliced 7d windows + yields obj | 14635 | n/a | 142.3 | 192.2 | 192.2 | slice p95 10.6 / max 14.6 | - |
| 365d + 3 models | raw sliced 7d windows + yields arr | 14635 | n/a | 104.5 | 112.3 | 112.3 | slice p95 8.0 / max 9.1 | - |
| 365d + 3 models | sql15 sliced 7d windows + yields obj | 14631 | n/a | 156.2 | 164.2 | 164.2 | slice p95 10.9 / max 17.1 | - |
| 365d + 3 models | sql15 sliced 7d windows + yields arr | 14631 | n/a | 117.2 | 120.9 | 120.9 | slice p95 8.5 / max 9.0 | - |
| 365d + 3 models + 5 repos | raw all() obj naive-local | 2056 | 64.4 | 64.7 | 68.0 | 68.0 | - | 3.7 |
| 365d + 3 models + 5 repos | raw iterate() obj naive-local | 2056 | 66.6 | 71.2 | 97.7 | 97.7 | - | 4.9 |
| 365d + 3 models + 5 repos | raw all() obj cached-local | 2056 | 63.9 | 63.1 | 65.0 | 65.0 | - | 3.6 |
| 365d + 3 models + 5 repos | raw iterate() obj cached-local | 2056 | 68.1 | 68.4 | 74.0 | 74.0 | - | 4.9 |
| 365d + 3 models + 5 repos | sql15 all() obj cached-local | 2056 | 61.8 | 65.8 | 113.0 | 113.0 | - | 3.6 |
| 365d + 3 models + 5 repos | sql15 iterate() obj cached-local | 2056 | 66.5 | 69.9 | 72.9 | 72.9 | - | 4.9 |
| 365d + 3 models + 5 repos | raw all() obj (fetch only) | 2056 | 56.6 | 63.4 | 70.3 | 70.3 | - | 2.2 |
| 365d + 3 models + 5 repos | raw iterate() obj (fetch only) | 2056 | 63.1 | 64.2 | 71.4 | 71.4 | - | 3.4 |
| 365d + 3 models + 5 repos | sql15 all() obj (fetch only) | 2056 | 61.6 | 61.0 | 62.7 | 62.7 | - | 2.2 |
| 365d + 3 models + 5 repos | raw all() arr naive-local | 2056 | 66.3 | 60.1 | 62.2 | 62.2 | - | 2.2 |
| 365d + 3 models + 5 repos | raw iterate() arr naive-local | 2056 | 61.7 | 62.8 | 67.9 | 67.9 | - | 2.7 |
| 365d + 3 models + 5 repos | raw all() arr cached-local | 2056 | 69.3 | 59.1 | 66.2 | 66.2 | - | 2.1 |
| 365d + 3 models + 5 repos | raw iterate() arr cached-local | 2056 | 63.3 | 63.4 | 64.5 | 64.5 | - | 2.6 |
| 365d + 3 models + 5 repos | sql15 all() arr cached-local | 2056 | 62.8 | 62.8 | 64.1 | 64.1 | - | 2.1 |
| 365d + 3 models + 5 repos | sql15 iterate() arr cached-local | 2056 | 65.5 | 67.1 | 73.5 | 73.5 | - | 2.6 |
| 365d + 3 models + 5 repos | raw all() arr (fetch only) | 2056 | 60.7 | 58.0 | 58.9 | 58.9 | - | 0.7 |
| 365d + 3 models + 5 repos | raw iterate() arr (fetch only) | 2056 | 58.8 | 56.4 | 58.4 | 58.4 | - | 1.2 |
| 365d + 3 models + 5 repos | sql15 all() arr (fetch only) | 2056 | 58.8 | 60.3 | 69.9 | 69.9 | - | 0.7 |
| 365d + 3 models + 5 repos | raw-ordered iterate() obj cached-local | 2056 | 68.0 | 67.4 | 69.8 | 69.8 | - | 4.9 |
| 365d + 3 models + 5 repos | raw sliced 7d windows + yields obj | 2056 | n/a | 73.3 | 83.7 | 83.7 | slice p95 5.5 / max 9.2 | - |
| 365d + 3 models + 5 repos | raw sliced 7d windows + yields arr | 2056 | n/a | 75.9 | 93.0 | 93.0 | slice p95 6.1 / max 14.5 | - |
| 365d + 3 models + 5 repos | sql15 sliced 7d windows + yields obj | 2056 | n/a | 78.2 | 94.3 | 94.3 | slice p95 6.0 / max 7.8 | - |
| 365d + 3 models + 5 repos | sql15 sliced 7d windows + yields arr | 2056 | n/a | 76.0 | 98.5 | 98.5 | slice p95 6.4 / max 9.6 | - |

### A4. NDJSON (500 MiB)

| variant | full file p50 ms | p95 ms | max ms | MiB/s | JSON.parse calls | longest sync slice ms (p50/max) | EL-delay max ms (p50/max of runs) | EL-delay p99 ms (p50) | max RSS MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nf-1MB | 412 | 428 | 428 | 1213 | 17209 | 1.6/3.6 | 2.8/3.9 | 0.9 | 51 |
| ls-1MB | 436 | 477 | 477 | 1147 | 17209 | 1.8/2.4 | 2.4/2.8 | 1.0 | 53 |
| nf-64K | 845 | 874 | 874 | 592 | 17209 | 0.7/2.3 | 1.0/4.1 | 0.4 | 52 |
| nf-256K | 444 | 508 | 508 | 1126 | 17209 | 0.6/1.3 | 0.7/2.0 | 0.4 | 52 |
| nf-4MB | 391 | 395 | 395 | 1277 | 17209 | 4.0/8.0 | 3.8/17.0 | 3.6 | 55 |
| rl-all | 3175 | 3399 | 3399 | 157 | 100556 | n/a (stream callbacks) | 2.4/3.5 | 0.7 | 89 |
| rl-pre | 2857 | 2921 | 2921 | 175 | 17209 | n/a (stream callbacks) | 5.4/11.5 | 0.7 | 96 |

### A5. Concurrency

| scenario (5 runs each) | BUSY seen by writers | BUSY seen by reader | batches dropped | writer sync block p95 / max ms | writer batch incl. waits p95 / max ms | reader 50k+ read p50 / p95 / max ms | data_version call us p50/max | reader saw bumps (median) | max WAL MB | integrity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1W+1R  busy=5000  BEGIN IMMEDIATE | 0 | 0 | 0 | 53.9 / 63.9 | 53.9 / 63.9 | 85.5 / 114.6 / 199.5 | 110 / 582 | 5 | 43 | ok |
| 1W+1R  busy=0     BEGIN IMMEDIATE | 0 | 0 | 0 | 51.1 / 71.1 | 51.1 / 71.1 | 89.5 / 114.2 / 158.3 | 117 / 382 | 4 | 43 | ok |
| 2W+1R  busy=5000  BEGIN IMMEDIATE (sync wait in busy handler) | 0 | 0 | 0 | 93.4 / 345.0 | 93.4 / 345.0 | 108.7 / 149.1 / 183.6 | 115 / 489 | 5 | 44 | ok |
| 2W+1R  busy=250   BEGIN IMMEDIATE | 0 | 0 | 0 | 91.7 / 269.7 | 91.7 / 269.7 | 126.7 / 155.0 / 200.4 | 111 / 279 | 5 | 43 | ok |
| 2W+1R  busy=0     BEGIN IMMEDIATE + async retry/backoff | 294 (5:database is lockedx294) | 0 | 0 | 18.0 / 86.6 | 102.1 / 232.1 | 105.5 / 154.1 / 194.4 | 125 / 366 | 5 | 43 | ok |
| 2W+1R  busy=0     BEGIN IMMEDIATE, no retry (batch dropped) | 150 (5:database is lockedx150) | 0 | 150 | 0.0 / 159.5 | 0.1 / 159.5 | 98.6 / 152.9 / 208.5 | 123 / 315 | 4 | 43 | ok |
| 2W+1R  busy=5000  deferred BEGIN + pre-SELECT then write | 199 (517:database is lockedx19, 5:database is lockedx180) | 0 | 199 | 21.5 / 70.3 | 21.5 / 70.3 | 107.8 / 139.3 / 181.2 | 146 / 443 | 3 | 34 | ok |
| 2W+1R  busy=5000  BEGIN IMMEDIATE + pre-SELECT then write | 0 | 0 | 0 | 119.1 / 449.5 | 119.1 / 449.5 | 113.7 / 179.0 / 196.7 | 144 / 313 | 7 | 43 | ok |

### A6. Worker snapshots

| snapshot @ 54k rows | in-thread total = main block p50 / p95 ms | worker latency p50 / p95 ms | work inside worker p50 ms | added latency p50 ms | main-thread longest loop gap, p50 / worst of runs ms | postMessage call ms (p50) |
| --- | --- | --- | --- | --- | --- | --- |
| raw rows (objects) | 260.8 / 334.7 | 279.6 / 300.1 | 278.9 | 0.7 | 1.0 / 1.6 | 0.025 |
| SQL 15-min GROUP BY | 91.9 / 107.5 | 99.5 / 113.8 | 98.8 | 0.7 | 0.6 / 5.6 | 0.030 |

### A6b. Worker ingest

| 100k-row ingest, 2000/batch | total ms (p50) | rows/s (p50) | main-thread longest loop gap, p50 / worst ms | main EL-delay p99 ms (p50) | postMessage(2000 rows) p50 / worst ms |
| --- | --- | --- | --- | --- | --- |
| in-thread (F4g) | 1028 | 97276 | 44.6 / 72.4 | 43.6 | - |
| worker (2 batches in flight) | 1057 | 94597 | 3.3 / 8.4 | 1.1 | 1.6 / 2.3 |

### A7. Machine record

```json
{
  "node": "v22.23.5",
  "v8": "12.4.254.21-node.57",
  "sqlite": "3.54.1",
  "platform": "linux 6.18.44-fc-v880",
  "arch": "x64",
  "cpuModel": "Intel(R) Xeon(R) Processor @ 2.10GHz",
  "cpuCount": 4,
  "cpuMHz": 0,
  "totalMemGB": 15.7,
  "tz": "America/Los_Angeles"
}
```
