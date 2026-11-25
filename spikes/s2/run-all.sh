#!/usr/bin/env bash
# Runs the S2 event-loop benchmark suite. Results land in spikes/s2/results/*.json (+ *.log).
#
#   spikes/s2/run-all.sh                 # everything (about 25 minutes)
#   spikes/s2/run-all.sh insert read     # only the named steps
#   QUICK=1 spikes/s2/run-all.sh         # smoke run: 2 runs each, 60 MB ndjson file
#
# Steps: tests insert cold fresh read verify ndjson concurrency worker
# Env:   S2_RESULTS (output directory, default spikes/s2/results; use it for smoke runs)
#        TZ (default America/Los_Angeles; DST + non-hour offsets matter for the local-bucketing aggregator)
#        S2_TMP (scratch dir for databases and the big NDJSON file; default $TMPDIR/mallard-s2, needs ~1.5 GB free)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TZ="${TZ:-America/Los_Angeles}"
export S2_TMP="${S2_TMP:-${TMPDIR:-/tmp}/mallard-s2}"
RESULTS="${S2_RESULTS:-$here/results}"
export S2_RESULTS="$RESULTS"
mkdir -p "$S2_TMP" "$RESULTS"
NODE="${NODE:-node}"
FLAGS=(--disable-warning=ExperimentalWarning)
RUNS=5; MB=500; READ_RUNS=7
if [[ "${QUICK:-}" == "1" ]]; then RUNS=2; MB=60; READ_RUNS=3; fi

steps=("$@")
[[ ${#steps[@]} -eq 0 ]] && steps=(tests insert cold fresh read verify ndjson concurrency worker)

run() { echo; echo "=== $* ==="; "$@"; }

for step in "${steps[@]}"; do
  case "$step" in
    tests)
      run "$NODE" "${FLAGS[@]}" "$here/ndjson/selftest.mjs"
      run "$NODE" "${FLAGS[@]}" "$here/semantics.mjs" ;;
    insert)
      run "$NODE" "${FLAGS[@]}" "$here/bench-insert.mjs" --runs "$RUNS" | tee "$RESULTS/insert.log"
      # tail-risk soak: many runs of the recommended batch size
      run "$NODE" "${FLAGS[@]}" "$here/bench-insert.mjs" --runs "$((RUNS * 4))" --modes wal,wal-off,default --batches 2000 --tag _soak | tail -6 ;;
    cold)
      run "$NODE" "${FLAGS[@]}" "$here/bench-cold.mjs" ;;
    fresh)
      run "$NODE" "${FLAGS[@]}" "$here/bench-fresh.mjs" --runs "$RUNS" | tee "$RESULTS/fresh.log" ;;
    read)
      run "$NODE" "${FLAGS[@]}" --expose-gc "$here/bench-read.mjs" --data clustered --runs "$READ_RUNS" | tee "$RESULTS/read-clustered.log"
      run "$NODE" "${FLAGS[@]}" --expose-gc "$here/bench-read.mjs" --data uniform --runs "$READ_RUNS" | tee "$RESULTS/read-uniform.log" ;;
    verify)
      # raw vs 15-minute SQL pre-aggregation must agree to the last digit in every zone, incl. :30/:45 offsets and DST
      for tz in UTC America/Los_Angeles Asia/Kolkata Australia/Lord_Howe Pacific/Auckland Pacific/Chatham America/St_Johns; do
        TZ="$tz" "$NODE" "${FLAGS[@]}" --expose-gc "$here/bench-read.mjs" --verify-only | tail -1
      done ;;
    ndjson)
      run "$NODE" "${FLAGS[@]}" "$here/ndjson/bench.mjs" --mb "$MB" --runs "$RUNS" | tee "$RESULTS/ndjson.log" ;;
    concurrency)
      run "$NODE" "${FLAGS[@]}" "$here/bench-concurrency.mjs" --runs "$RUNS" --rows 60000 | tee "$RESULTS/concurrency.log" ;;
    worker)
      run "$NODE" "${FLAGS[@]}" "$here/bench-worker.mjs" --runs "$READ_RUNS" | tee "$RESULTS/worker.log" ;;
    *) echo "unknown step: $step" >&2; exit 2 ;;
  esac
done
echo; echo "done; JSON results in $RESULTS"
