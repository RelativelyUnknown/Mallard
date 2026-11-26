/**
 * The scenario matrix every golden is recorded over: which `now` values and
 * which dashboard filters. Declarative on purpose — the later stacks re-resolve
 * the same specs, so a golden entry is keyed by `label`, never by a number.
 *
 * `now` values are LOCAL wall-clock times resolved inside each zone, because
 * the edges they probe (month boundary, DST day, just-after-midnight) are
 * properties of the local calendar.
 */
import type { DatePreset, SourceKind, Surface } from '../../src/extension-backend/domain/types';
import type { GoldenTz } from './support/time';

export interface NowSpec {
  label: string;
  /** `YYYY-MM-DDTHH:mm` local wall time in the zone being recorded. */
  local: (tz: GoldenTz) => string;
}

/** The local calendar day on which each zone changes its offset in the fixture year (Nov 2026 window). */
export const DST_DAY: Record<GoldenTz, string> = {
  UTC: '2026-11-01', // no change: same calendar day, 24 hours
  'America/Los_Angeles': '2026-11-01', // fall back: 25-hour day
  'Asia/Kolkata': '2026-11-01', // no change
  'Australia/Lord_Howe': '2026-10-04', // spring forward by 30 minutes
  'Pacific/Auckland': '2026-09-27', // spring forward: 23-hour day
  'Pacific/Chatham': '2026-09-27',
};

export const NOW_SPECS: NowSpec[] = [
  { label: 'main', local: () => '2026-11-02T09:30' },
  { label: 'month-end', local: () => '2026-01-31T23:50' },
  { label: 'month-start', local: () => '2026-02-01T00:10' },
  { label: 'dst-day', local: (tz) => `${DST_DAY[tz]}T12:00` },
  { label: 'dst-midnight', local: (tz) => `${DST_DAY[tz]}T00:05` },
];

export interface FilterSpec {
  label: string;
  models?: string[];
  surfaces?: Surface[];
  repos?: string[];
  branches?: string[];
  sources?: SourceKind[];
  /** Relative preset; the dashboard sends it and UsageService re-resolves it against `now`. */
  rangePreset?: DatePreset;
  /** Explicit range: local calendar dates `[start, end)`. */
  rangeLocal?: [string, string];
}

const SONNET = 'claude-sonnet-4-5-20250929';

/** Full matrix, recorded at the `main` now. */
export const FILTER_SPECS: FilterSpec[] = [
  { label: 'none' },
  { label: 'preset-today', rangePreset: 'today' },
  { label: 'preset-7d', rangePreset: '7d' },
  { label: 'preset-30d', rangePreset: '30d' },
  { label: 'preset-month', rangePreset: 'month' },
  { label: 'model-one', models: [SONNET] },
  { label: 'model-two', models: ['gpt-4.1', 'claude-opus-4-5-20251101'] },
  { label: 'repo-alpha', repos: ['alpha'] },
  { label: 'repo-unattributed', repos: ['unattributed'] },
  { label: 'repo-alpha+unattributed', repos: ['alpha', 'unattributed'] },
  { label: 'surface-agent', surfaces: ['agent'] },
  { label: 'source-local', sources: ['local'] },
  { label: 'source-claude+surfaces', sources: ['claude-code'], surfaces: ['chat', 'agent'] },
  { label: 'branch-main', branches: ['main'] },
  { label: 'branch-feature-x+30d', branches: ['feature/x'], rangePreset: '30d' },
  { label: 'combo-model+repo+range', models: [SONNET], repos: ['beta'], rangeLocal: ['2026-10-25', '2026-11-03'] },
  { label: 'range-month-edge', rangeLocal: ['2026-01-31', '2026-02-02'] },
  { label: 'range-dst-spring-la', rangeLocal: ['2026-03-08', '2026-03-09'] },
  { label: 'range-dst-end-south', rangeLocal: ['2026-04-05', '2026-04-06'] },
];

/** The reduced matrix recorded at every other `now`. */
export const EDGE_FILTER_SPECS: FilterSpec[] = FILTER_SPECS.filter((f) =>
  ['none', 'preset-today', 'preset-7d', 'preset-month'].includes(f.label),
);

/** Fixed instants the ingest passes run at (UTC). Pass 2 is "live": rows within 5 min of it get heuristic attribution. */
export const INGEST_NOW_1 = Date.parse('2026-11-02T06:00:00.000Z');
export const INGEST_NOW_2 = Date.parse('2026-11-02T06:30:00.000Z');

/** What the active editor looks like when a live row is parsed (the heuristic repo/branch/language inputs). */
export const EDITOR_STATE = { repo: 'ide-repo', branch: 'ide-branch', language: 'typescript' } as const;

/** Days of raw events kept before rollup in the compaction scenario (the settings minimum). */
export const COMPACTION_RETENTION_DAYS = 30;
