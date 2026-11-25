# Golden recordings: intended differences

`test/golden/expected/` freezes what today's stack (DuckDB store, ingest-time pricing, JSON rules,
`config.json`, `layout.ts`) produces for the synthetic fixtures in `test/golden/fixtures/`. The later
streams re-implement `test/golden/pipeline.ts` against their own code and must reproduce every
recording **except** the items below. Anything that differs and is not listed here is a regression.

Each entry says what is recorded today, what the refactor may change it to, and what to compare
instead. IDs (`D1`...) are for cross-reference from PRs; `B1`... are bugs in today's behaviour that
the recordings pin (record current behaviour, do not fix in Phase 1a).

## How the goldens work

| | |
|---|---|
| Fixtures | `test/golden/fixtures/` (made-up data). Regenerate with `npx tsx test/golden/generate-fixtures.ts`; `test/unit/golden/fixtures.test.ts` fails if the files drift from the generator. |
| Harness | `test/golden/pipeline.ts`: `ingestFixtures`, `snapshot`/`snapshotRecord`, `exportCsv`, `exportJson`, `streamBatch`, `alertSequence`, `layoutVectors` (+ `usageSnapshot`, `compact`, `pricingVectors`). `goldens.ts` lists exactly what is recorded. |
| Re-record | `npx tsx test/golden/record.ts` (or `bun run golden:record`). Needs DuckDB's `sqlite` extension (auto-downloaded once). Deterministic: re-running on an unchanged tree changes no file. |
| Check | `test/unit/golden/*.test.ts` recompute each golden in all six zones (UTC, America/Los_Angeles, Asia/Kolkata, Australia/Lord_Howe, Pacific/Auckland, Pacific/Chatham) and diff against `expected/`. They run in `npx c8 mocha` and under any ambient `TZ`. |
| File names | `<name>.json` when the output is identical in all six zones, `<name>.<zone>.json` (`/` becomes `_`) when it depends on the zone. `canon()` sorts keys and rounds floats to 10 significant digits. |
| Time | Zone pinned per call (`withTz`), `Date.now()` frozen (`withClock`), `new Date()` frozen only inside `buildStreamBatch` (`withFrozenDateSync`). Ingest passes run at 2026-11-02T06:00Z (backfill) and 06:30Z (live); snapshot `now`s are local wall times (`scenarios.ts`: main, month-end, month-start, dst-day, dst-midnight). |
| Ids | Copilot NDJSON ids embed `fileKeyOf(absolute path)`; the harness rewrites that key to `{otel.jsonl}`, `{otel-map.jsonl}`. A new stack that keeps the id format only needs the same relabelling (the key is a pure function of the path). |
| Normalised | Order that DuckDB leaves unspecified is sorted before recording (see **U1**). |

Recorded names: `events` (mapped events, persisted rows, per-pass report), `snapshots` (SnapshotSourceData: 19 filters at `main`, 4 at each of four edge nows), `usage` (composed wire snapshot, 4 configurations), `export` (CSV + JSON), `stream-events` / `stream-envelope` (wire batches), `compaction` (rollup rows + snapshots), `branches`, `alerts` (built-in alerts, alert rules and restriction states over a 15-step series), `layout`, `pricing`.

---

## D. Differences the refactor may introduce

### D1 Read-time repricing: history reprices, cost is no longer frozen at ingest
- **Today:** `credits`, `cost`, `costByCategory` are computed once by the connector with the prices of that moment and stored. `events` / `stored` / `export` / `stream-*` carry them.
- **After:** rows keep tokens and `requests`; credits and cost are computed at read time from the current `PricingSnapshot`.
- **Compare instead:** feed the new stack the frozen `fixtures/pricing/*` and expect today's numbers (the recordings were made with exactly those inputs, so equality holds to the 10-digit rounding). Separately assert that changing the price feed changes old rows' cost. Where an old row depended on a price that has since been replaced (not the case for fixtures), the new value wins.

### D2 Cache and thinking tokens are persisted
- **Today:** `stored` (what the store reads back) has `cacheCreationTokens`, `cacheReadTokens`, `thinkingTokens` = `null` for every row; only `events` (the mapped events) and the wire `stream-events` carry them (`msg_m02`, `msg_stream1`, `msg_m05`...).
- **After:** `stored` equals `events` for those fields. `export` rows may gain the three columns.
- **Compare instead:** `stored[].{prompt,completion}Tokens`, credits, cost against today; the three new fields against `events`.

### D3 Claude cost on rolled-up rows
- **Today (`compaction`):** a rolled row's `cost` is the sum of per-event costs priced when each event was ingested, but its tokens are only prompt + completion (cache/thinking are dropped).
- **After:** rollups sum all token columns and `requests`, and price the sum at read time.
- **Compare instead:** Claude rolled rows' `cost`/`costByCategory` within a small relative tolerance (per-token prices are linear, so pricing the summed tokens should equal the sum of per-event costs up to float rounding; any larger gap is a real difference). Everything else on rolled rows (`promptTokens`, `completionTokens`, `credits`) must match exactly except D4/D5.

### D4 Copilot fallback `costByCategory` split on rollup rows is approximate
- **Today:** events whose model has no token price get `cost = credits x pricePerCredit` and a per-event input/output split by token ratio; a rolled row sums those splits (`roll:2026-01-06:o3-mini:...` records `{input 0.01056, output 0.00264}`).
- **After:** the split of a rolled row is computed once from the rolled token totals.
- **Compare instead:** `cost` exactly; `costByCategory` per category within the spread between "sum of per-event splits" and "split of the sums" (only rows that merge events with different token ratios differ).

### D5 Rolled-up rows land in hour 0 (and now carry no branch/language)
- **Today:** a rolled row has `ts` = local midnight, so every rolled credit shows up in `hourly[0]` (`compaction.*.snapshots[0].data.hourly`: 245.8 of 573.7 credits at hour 0 in UTC) and `weekday`/`daily` use that midnight. Rolled rows drop `branch` and `language`; zero-token days store `promptTokens: 0` rather than `null`.
- **After:** the same quirk is acceptable (rollups per local day), including the dropped branch/language and 0-vs-null token columns. If rollups gain an hour or keep branch, the hourly and branch goldens change accordingly.
- **Compare instead:** daily totals (`daily`, `totals`, `models`, `repos`, `sankey`) exactly; `hourly` only for non-rolled days.

### D6 Event count after compaction counts requests, not rows
- **Today:** `totals.*.eventCount`, `daily[].eventCount`, `sankey[].count` count stored rows, so a rolled day counts as 1 however many requests it holds (`compaction.*`: 147 rows for 162 requests).
- **After:** rollups sum `requests`, so counts return to the number of requests.
- **Compare instead:** the `compaction` goldens' counts against the `events` count; credits/cost/tokens must match today.

### D7 Built-in velocity implementation unified
- **Today:** the built-in alert uses first-to-last (`alerts.*` step 23:00: "about 100 credits/hour"); rules use the least-squares slope of `ctx.velocity.creditsPerHour` (same step: `Rule velocity 101.10 cr/h`; at 22:40 only the rule fires, the built-in does not).
- **After:** both use the least-squares implementation.
- **Compare instead:** the built-in velocity alert fires at the steps where the rule-based (least-squares) velocity crosses the threshold; its number is the least-squares one. All other alert steps must match.

### D8 Cooldown keys are `YYYY-MM` and cooldowns persist
- **Today:** monthly budget keys are `budget-80-<getMonth()>` / `budget-100-<getMonth()>` (month index only, collides across years); daily key is `daily-<toDateString()>`; the cooldown map lives in memory and is lost on reload, and entries older than 24 h are pruned regardless of their rule's cooldown.
- **After:** `YYYY-MM` month keys, state in `globalState`, pruning by each rule's cooldown.
- **Compare instead:** the toast sequence in `alerts.*` is unchanged (the keys are internal). The month rollover steps (23:30 to 01:00 on 31 Jan to 1 Feb) must still re-fire the 80 % alert immediately under the new month key.

### D9 Claude partial-usage: later lines of an already-stored message upsert with max tokens
- **Today:** `msg_late` was first seen with `output_tokens 5`; later lines (180, then 400, with a `tool_use`) arrive in the next pass and are ignored (`INSERT OR IGNORE`). Recorded: `completionTokens 5`, surface `chat`, cost 0.002775. See **B1**.
- **After:** `ON CONFLICT DO UPDATE SET tokens = max(...)`.
- **Compare instead:** expect `msg_late` with `completionTokens 400` (cost 0.0087 at the fixture prices); nothing else changes. Surface after the upsert is unspecified (`chat` kept, or `agent` if the merge also keeps the tool-use signal).

### D10 `estimated` is always true / derived
- **Today:** every recorded event has `estimated: true`; `snapshots[].data.estimatedEventCount == totals.all.eventCount`.
- **After:** derived as `true`; no column.
- **Compare instead:** nothing; keep reporting `true`.

### D11 TS NDJSON streamer: byte offsets, unterminated lines, late lines, heterogeneous JSON
Several recorded behaviours come from DuckDB's `read_ndjson` + the timestamp watermark and change with the streamer. Compare the **final** event set after both passes, not per-pass counts:
- **Unterminated last line.** Today a complete JSON last line without `\n` is ingested in the backfill (`msg_unterm`, `passes[0].inserted.claude`); the streamer defers it until the newline arrives (pass 2 supplies it). A truncated tail is dropped today and completed by pass 2 (`msg_cut`, `msg_postcut`); the streamer ends in the same place. Expected final set: identical ids and values; only `passes[*].inserted` may move between passes.
- **Late line older than the watermark** (`msg_old_late`, ts 2026-01-02, new id, appended in pass 2): today skipped forever (**B2**). The streamer reads it: expect one extra event (sonnet-4-5, 77/33 tokens, repo alpha, branch main, credits 6).
- **Attribute shapes and number-like strings** (**B3**, **B4**): `otel-mixed.jsonl` yields two events (`mix-001` gpt-4o prompt 10, `mix-002` prompt 11) instead of none; `map-007` gets tokens 55/6 and token-priced cost 0.0001975 instead of null tokens and the credit-based 0.0132.
- **Timestamps** that DuckDB infers as typed columns (naive `2026-03-02 08:30:00.250`, offset `-08:00`) must still resolve to the same instants (`map-003`, `map-004`).
- **Ids that embed a path hash** keep their format (`local:<fileKey>:<spanId>`); the live-attribution rule keys off "an `ingest_state` row exists" instead of the `<connector>:watermark` meta row (same observable result: backfill rows get no heuristic repo, live rows do: `msg_live1`, `live-002`).

### D12 Export formats come from TypeScript, not DuckDB `COPY`
- **Today:** CSV header `id,ts,modelId,surface,source,credits,cost,promptTokens,completionTokens,estimated,repo,costByCategory,branch,attribution,language`; doubles print DuckDB-style (`15.0`, `0.0027500000000000003`); `costByCategory` is a quoted JSON string in both formats; JSON export is newline-delimited rows (parsed in `export.json`); rows are `ORDER BY ts DESC` (ties unordered; the recording sorts by ts desc then id).
- **After:** `exportTo` streams CSV/JSON from TS.
- **Compare instead:** same columns in the same order (plus the D2 token columns), values equal numerically, same row set and ts-descending order. Number formatting (`15` vs `15.0`), null rendering and quoting may differ as long as the file parses to the same values.

### D13 Wire batches: pricing at send time, `tz_offset_minutes` at `sent_at`
- **Today:** events are priced at ingest and `tz_offset_minutes = -new Date().getTimezoneOffset()` reads the real clock, not `sent_at` (**B5**). The recordings pin it by freezing `Date`.
- **After:** price at `buildStreamBatch` with the current snapshot; compute the offset at `sent_at`.
- **Compare instead:** `stream-events` byte-for-byte (after D1/D2, the three token fields are present exactly as recorded); `stream-envelope` equal when `sent_at` is the recorded `now`.

### D14 Snapshot read semantics to copy exactly (not differences, but easy to lose)
Listed so Stream A1's `buildSnapshotSource` can be checked against `snapshots.*`:
- `dims` are scoped to the range filter only, and a filtered read with no range gets the default window `[startOf(now - 365 d), now + 1 d)` (`read.recordFilter.range`). Consequence today: any non-range filter hides models that only occur older than a year from `dims.models` (18 models unfiltered, 16 with a model filter at `main`). Keep, or list the change here.
- Null repo is `unattributed`; `tokens` is prompt + completion only; `sankey` needs `credits > 0`; `categories` keep only `cost > 0`; `heuristicShare` is cost-weighted; `hourly` omits empty hours; weekday 0 = Sunday; local day/hour/weekday bucketing is DST-correct (see the `dst-*` nows and `range-dst-*` filters; the repeated 02:xx hour on fall-back days is one bucket).

### D15 Alerts and restriction (Stream C)
- **Flat rules replace the JSON rules language.** `alerts.*` rule steps (`busy-day`, `month-escalation` thresholds, `sonnet-heavy` keyed metric, `velocity-rule`) are the flat-convertible ones. Messages become fixed-format instead of `{{ template }}` renders (`Busy day: 95 credits so far`, `Month at 235 credits`, `Sonnet used 183.60 credits`, `Rule velocity 101.10 cr/h` change text). Compare `ruleId`/severity/firing step, not text. Rules the converter cannot express (`requiresAuth`, `groups`, `vars`, `active`, multi-condition `when`) are reported instead of converted (`needs-signin` never fires in the recording because billing is signed out).
- **Restriction receives history.** `restrict-velocity` (`velocity.creditsPerHour > 1`) never matches today because `container.ts` passes no history (**B6**); after, it matches whenever history shows a rate above 1, so restriction steps from 22:30 may differ. Compare all other restriction states exactly (`restrict-heavy-day` at 23:00, `restrict-over-budget` at 23:30 with the snooze, `restrict-snoozed` after its `snoozeUntil`).
- **Auto re-enable** uses "metric stops matching or falls below `clearBelow`" instead of `reEnableWhen`; `restrict-over-budget` clears at 00:00 in the recording because the month reset drops the budget percentage below the `reEnableWhen` of 0.9.

### D16 Layout (Stream D)
- `layout.json` records `normalizeLayout`, `configPanelsToLayout`, `layoutToConfigPanels` for old shapes (`span`/`hidden`/`size`, `gridColumn` strings, duplicates, unknown ids, bad spans, `columns`). The v1-to-v2 migrator must map these to `{id, x, y, w, h, hidden}` preserving: order, unknown ids, hidden flags, span-to-`w` (clamped to the column count) and size-tier-to-`h`. Compare the migrator's input interpretation (which entries survive, in which order, with which span/hidden/size), not the v1 output shape. `gridColumn`/`gridRow` and `DEFAULT_DASHBOARD_LAYOUT` disappear from the contract; `panelIds` (13 ids) must stay the single panel list.

### D17 Pricing resolution
- `pricing.json` records `normalizeModelId`, credit multipliers (manifest and defaults) and per-token costs for 24 model spellings against the frozen inputs. `priceRow` (A1) must reproduce `multiplierManifest`, `request` (Copilot credits and credit-based cost) and the feed/bundled token costs. Claude fallback order is feed, then bundled list prices, then 0 (`claude-fable-9`: credits 1.5, cost 0); the credit multiplier is never used for Claude cost.

---

## U. Unspecified order normalised in the recordings

### U1 Tie order of ranked lists and the sankey list
`models`, `repos`, `languages` are `ORDER BY credits DESC` (ties arbitrary) and `sankey` has no `ORDER BY`, so DuckDB returns a different order from run to run (the first draft of these goldens flaked on it). The harness sorts ties by name and the sankey by model, surface before recording or feeding `UsageService`. A new implementation may order ties differently; the UI should not depend on it (a deterministic tie-break is an improvement).

---

## B. Bugs in today's behaviour that the recordings pin

None are fixed in Phase 1a. Where the new stack fixes one, the matching D entry says what to expect.

- **B1 Partial usage of a streamed message is permanent** when its later lines arrive in a later ingest pass (`msg_late`: stored as 5 output tokens, truly 400; surface stays `chat` although a later line has `tool_use`). Known gap; see D9.
- **B2 Late-flushed lines older than the watermark are skipped forever** (`msg_old_late`), contradicting the comment in `BaseFileConnector.ingestOnce` that moving the watermark to event time avoids it. See D11.
- **B3 One file mixing OTLP-array and map `attributes` yields no events.** DuckDB types the column `JSON`, the connector receives a string and `flattenOtelAttributes` returns `{}` (`otel-mixed.jsonl`: both spans dropped, connector status `empty`).
- **B4 Number-like strings among numeric token attributes are dropped.** In `otel-map.jsonl` the field is inferred as `JSON`, a string `"55"` arrives as `"\"55\""`, `num()` rejects it: `map-007` has null tokens and falls back to the credit cost 0.0132. (Mixed numeric and string values are normal for OTLP `intValue`.)
- **B5 `tz_offset_minutes` is computed from the real clock** (`-new Date().getTimezoneOffset()`), not from `sent_at`: around a DST change a batch can carry the wrong offset, and the value depends on when the process runs.
- **B6 Restriction rules on `velocity.*` never match**: `container.ts` calls `restriction.reconcile` without `history`. (Alert rules do get history.)
- **B7 Copilot spans without a span id collide on `<file>:<ts>:<model>`**: the second same-millisecond, same-model span is silently dropped (`inline_completion` pair at 2026-01-08T11:00:00Z: tokens 40/8 kept, 41/9 lost).
- **B8 Compaction loses attribution detail and breaks counts**: rolled rows drop `branch` and `language`, `creditsByBranch` ignores credits that were rolled up, counts become row counts (D6), zero-token days store 0 instead of null, and the rollup assigns everything to hour 0 (D5).
- **B9 `dims` shrink with any non-range filter** because of the implicit 365-day range (D14): the model/repo/source dropdowns lose entries older than a year while a model filter is active.
- **B10 Built-in budget alert keys use the month index only** (`budget-80-0`), which collides across years; masked today only by the 24 h pruning and in-memory cooldowns (D8).
- **B11 Same-session cooldowns reset on reload**: a window reload re-fires every active built-in and rule alert (cooldowns are in memory only).
- **B12 Claude `thinking` tokens are priced on top of `output_tokens`** (`msg_m05`: 400 thinking at the output rate, 0.0183 total). If Anthropic's `output_tokens` already includes thinking, cost is overstated; the log format carries no `thinking_tokens` field today, so this only matters if a log writes both.

## Environment notes

- The Copilot span DB is read through DuckDB's `sqlite` extension, which is downloaded on first use. Offline, `test/unit/golden/pipeline.test.ts` skips (with a console note) instead of failing; `record.ts` refuses to run. The node:sqlite stack removes this dependency.
- Baseline of this branch: `npx c8 mocha` has one pre-existing failure unrelated to the goldens (`WebhookProtocol — send() outcome matrix: returns retryable on 5xx and retries up to retries times` times out at 10 s in this sandbox).
- `test/bench/baseline.duckdb.json` holds the DuckDB timing baseline (insert, snapshot reads, a 50 MB ingest, event-loop delay) with machine info; rerun with `bun run bench` on the target machine before comparing.
