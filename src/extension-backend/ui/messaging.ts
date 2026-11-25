/**
 * Typed, validated message envelopes for host <-> webview traffic.
 * Pure — no `vscode`, no DOM — so it can be bundled into both sides.
 */
import {
  DatePreset,
  Filter,
  PaletteMode,
  RestrictionState,
  SOURCE_KINDS,
  SURFACES,
  Surface,
  SourceKind,
  UsageSnapshot,
  UserConfig,
} from '../domain/types';
import type { LayoutV2 } from '../domain/contracts';
import { isLayoutV2 } from '../domain/layout';

export type CommandId = 'openDashboard' | 'signIn' | 'disableExtension' | 'enableCopilotTelemetry' | 'setGitHubPat';

/** Active editor theme kind, mirrored to the webview so it can derive an
 *  accessible accent (the webview also sees VS Code's body theme class). */
export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export type WebviewBoundMsg =
  | { type: 'snapshot'; payload: UsageSnapshot }
  | { type: 'config'; value: UserConfig }
  | { type: 'layout'; value: LayoutV2 }
  | { type: 'restriction'; value: RestrictionState }
  | { type: 'theme'; kind: ThemeKind; palette: PaletteMode }
  // Sidebar-only: pulse the budget section when an alert fires.
  | { type: 'alertFired'; message: string };

export type HostBoundMsg =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'setFilter'; value: Filter }
  | { type: 'setLayout'; value: LayoutV2 }
  | { type: 'openConfig' }
  | { type: 'command'; id: CommandId }
  | { type: 'restrictSnooze'; minutes: number }
  | { type: 'setCurrency'; value: string }
  // Sidebar-only: toggle a model in/out of the shared filter (host applies it
  // against the authoritative UsageService filter).
  | { type: 'toggleModelFilter'; model: string };

const COMMAND_IDS: CommandId[] = ['openDashboard', 'signIn', 'disableExtension', 'enableCopilotTelemetry', 'setGitHubPat'];

/**
 * Every message type the host accepts. A Record keyed by the union, so adding a
 * HostBoundMsg variant without listing it here is a compile error; the list
 * is exported for tests that need "all valid types" without a second copy.
 */
const HOST_BOUND_TYPE_FLAGS: Record<HostBoundMsg['type'], true> = {
  ready: true,
  refresh: true,
  setFilter: true,
  setLayout: true,
  openConfig: true,
  command: true,
  restrictSnooze: true,
  setCurrency: true,
  toggleModelFilter: true,
};
export const HOST_BOUND_TYPES = Object.keys(HOST_BOUND_TYPE_FLAGS) as ReadonlyArray<HostBoundMsg['type']>;

const DATE_PRESET_FLAGS: Record<DatePreset, true> = { today: true, '7d': true, '30d': true, month: true, all: true };

function isObject(m: unknown): m is Record<string, unknown> {
  return typeof m === 'object' && m !== null;
}

function isPlainObject(m: unknown): m is Record<string, unknown> {
  return isObject(m) && !Array.isArray(m);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Sanity bounds so a hostile webview cannot make the host chew on a huge payload. */
const MAX_LIST_ITEMS = 10_000;
const MAX_STRING_LENGTH = 4096;

function isStringList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_LIST_ITEMS &&
    v.every((s) => typeof s === 'string' && s.length <= MAX_STRING_LENGTH)
  );
}

/**
 * Validate and rebuild a Filter from an untrusted message value. Returns
 * undefined when the shape is wrong (non-object, non-numeric range, lists that
 * are not arrays of strings); unknown keys are dropped and unknown
 * surface/source names are discarded (they could never match a row).
 */
export function parseFilter(value: unknown): Filter | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Filter = {};
  if (value.range !== undefined) {
    const r = value.range;
    if (!isPlainObject(r) || !isFiniteNumber(r.start) || !isFiniteNumber(r.end)) return undefined;
    out.range = { start: r.start, end: r.end };
  }
  for (const key of ['models', 'repos', 'branches'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!isStringList(list)) return undefined;
    out[key] = [...list];
  }
  if (value.rangePreset !== undefined) {
    if (typeof value.rangePreset !== 'string') return undefined;
    // An unknown preset name (newer webview) is dropped, not trusted.
    if (Object.hasOwn(DATE_PRESET_FLAGS, value.rangePreset)) out.rangePreset = value.rangePreset as DatePreset;
  }
  if (value.surfaces !== undefined) {
    if (!isStringList(value.surfaces)) return undefined;
    out.surfaces = value.surfaces.filter((s): s is Surface => SURFACES.has(s as Surface));
  }
  if (value.sources !== undefined) {
    if (!isStringList(value.sources)) return undefined;
    out.sources = value.sources.filter((s): s is SourceKind => SOURCE_KINDS.has(s as SourceKind));
  }
  return out;
}

export function isHostBoundMsg(m: unknown): m is HostBoundMsg {
  if (!isObject(m) || typeof m.type !== 'string') return false;
  switch (m.type) {
    case 'ready':
    case 'refresh':
    case 'openConfig':
      return true;
    case 'setFilter':
      return parseFilter(m.value) !== undefined;
    case 'setLayout':
      return isLayoutV2(m.value);
    case 'restrictSnooze':
      return typeof m.minutes === 'number' && m.minutes > 0 && m.minutes <= 60 * 24 * 7;
    case 'command':
      return COMMAND_IDS.includes(m.id as CommandId);
    case 'setCurrency':
      return typeof m.value === 'string' && /^[A-Za-z]{3}$/.test(m.value);
    case 'toggleModelFilter':
      return typeof m.model === 'string' && m.model.length > 0;
    default:
      return false;
  }
}

export function isWebviewBoundMsg(m: unknown): m is WebviewBoundMsg {
  if (!isObject(m) || typeof m.type !== 'string') return false;
  switch (m.type) {
    case 'theme':
      return true;
    case 'snapshot':
      return isObject(m.payload);
    case 'config':
      return isObject(m.value);
    case 'layout':
      return isLayoutV2(m.value);
    case 'restriction':
      return isObject(m.value);
    case 'alertFired':
      return typeof m.message === 'string';
    default:
      return false;
  }
}
