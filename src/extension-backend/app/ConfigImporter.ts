/**
 * One-time import of a pre-settings `config.json` (Mallard used to keep budgets,
 * alerts, display, currency, export targets and the dashboard layout in
 * `<globalStorage>/config.json`; they are VS Code settings now).
 *
 * On activation, if the file exists it is read leniently (one invalid block never
 * costs the others), the equivalent settings are written, the legacy layout is
 * seeded into globalState if that is still empty, per-target secrets are re-keyed
 * by the generated target ids, and the file is renamed to `config.json.migrated`
 * (never deleted: it keeps the old `rules`/`groups`/`vars`, and whatever the flat
 * alert rules cannot express). The old rules are handed back in the result;
 * `importLegacyAlertRules` converts them. One information message says what moved
 * and what needs a human. The whole thing is idempotent: nothing is renamed until the settings
 * writes succeeded, an unreadable file is left alone and warned about once, and
 * once renamed the import never runs again.
 */
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { TARGET_ID_RE, uniqueTargetId } from '../config/settings';
import type { LegacyGroup, LegacyRule } from '../domain/flatAlertImport';
import { configPanelsToLayout } from '../domain/layout';
import type { ConfigPanelLayout, ExportTarget, UserConfig } from '../domain/types';
import { queueFileFor } from '../export/ExportQueue';
import { defaultLogger, Logger } from '../util/logger';
import { SECRET_KEYS, targetSecretKey, type SecretKey } from './credentials';
import { FLAG_CONFIG_IMPORT_WARNED, getFlag, setFlag } from './EphemeralFlags';
import { LAYOUT_V1_KEY } from './LayoutStore';

const FILE = 'config.json';
const BACKUP = 'config.json.migrated';

/** Raw JSON object, as read from the file. */
type RawObject = Record<string, unknown>;

export interface ImportResult {
  /** `none`: no config.json. `imported`: settings written and the file renamed. `failed`: left in place (unreadable, or a settings write failed). */
  status: 'none' | 'imported' | 'failed';
  /** The `UserConfig` fields written to settings, e.g. `monthlyBudget`, `alerts.velocityEnabled`, `export.webhookTargets`. */
  written: string[];
  /** Top-level blocks that were present but could not be imported (invalid), plus invalid entries inside lists. */
  skipped: string[];
  /** The dashboard layout was copied into globalState. */
  layoutSeeded: boolean;
  /** Where the original now lives (`config.json.migrated`), when it was renamed. */
  backup?: string;
  /**
   * The old `rules` and `groups`, as read from the file (objects only, otherwise
   * unchecked: the converter validates what it relies on). `importLegacyAlertRules`
   * turns them into flat rules.
   */
  legacyRules: LegacyRule[];
  legacyGroups: LegacyGroup[];
}

export interface ImportUi {
  /** The one summary message. */
  info(message: string): void;
  /** The one warning when the file cannot be imported. */
  warn(message: string): void;
}

export interface ImportDeps {
  /** `<globalStorage>`: where config.json and the export retry queues live. */
  storageDir: string;
  config: { update(patch: Partial<UserConfig>): Promise<void> };
  state: vscode.Memento;
  secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;
  ui?: ImportUi;
  logger?: Logger;
}

export const vscodeImportUi: ImportUi = {
  info: (message) => {
    void Promise.resolve(vscode.window.showInformationMessage(message, 'Open Settings')).then((choice) => {
      if (choice) return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:RelativelyUnknown.mallard');
      return undefined;
    });
  },
  warn: (message) => void vscode.window.showWarningMessage(message),
};

// ── Lenient parsing ──────────────────────────────────────────────────────────

const isObject = (v: unknown): v is RawObject => typeof v === 'object' && v !== null && !Array.isArray(v);

const NUMBER_BLOCKS = ['monthlyBudget', 'includedCredits', 'dailyCreditAlert'] as const;
const OPT_NUM = z.number().optional();

/** Per-block schemas for what has a setting to go to. Each is checked on its own so one bad block drops only itself. */
const BLOCKS = {
  alerts: z.object({ velocityEnabled: z.boolean().optional(), velocityCreditsPerHour: OPT_NUM }),
  display: z.object({ dailyBarsWindow: OPT_NUM, heatmapWeeks: OPT_NUM, topN: OPT_NUM }),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  githubBilling: z.object({ mode: z.enum(['vscode-session', 'pat']).optional(), org: z.string().optional() }),
};

const TargetShape = z.object({ name: z.string().min(1), url: z.string().min(1) });
const PanelShape = z.object({
  id: z.string(),
  gridColumn: z.string().optional(),
  gridRow: z.string().optional(),
  hidden: z.boolean().optional(),
  size: z.enum(['compact', 'normal', 'tall']).optional(),
});

/** Entries of `list` that match `schema`; the indexes of the others are reported as `<label>[i]`. */
function validEntries<S extends z.ZodType>(label: string, list: unknown, schema: S, skipped: string[]): Array<z.output<S>> {
  if (!Array.isArray(list)) {
    skipped.push(label);
    return [];
  }
  const out: Array<z.output<S>> = [];
  list.forEach((entry: unknown, i) => {
    const r = schema.safeParse(entry);
    if (r.success) out.push(r.data);
    else skipped.push(`${label}[${i}]`);
  });
  return out;
}

interface Parsed {
  patch: Partial<UserConfig>;
  panels: ConfigPanelLayout[] | undefined;
  columns: number | undefined;
  /** Number of export targets that were imported. */
  targets: number;
  /** Targets whose id differs from their old name, so their credentials have to be carried over. */
  renamed: Array<{ kind: 'webhook' | 'mqtt'; from: string; to: string }>;
  skipped: string[];
}

function parseDocument(doc: RawObject): Parsed {
  const skipped: string[] = [];
  const patch: Partial<UserConfig> = {};

  for (const key of NUMBER_BLOCKS) {
    if (doc[key] === undefined) continue;
    const r = z.number().safeParse(doc[key]);
    if (r.success) patch[key] = r.data;
    else skipped.push(key);
  }
  for (const key of ['alerts', 'display', 'currency', 'githubBilling'] as const) {
    if (doc[key] === undefined) continue;
    const r = BLOCKS[key].safeParse(doc[key]);
    if (r.success) (patch as Record<string, unknown>)[key] = r.data;
    else skipped.push(key);
  }
  if (doc['branchBudgets'] !== undefined) {
    if (isObject(doc['branchBudgets'])) {
      const budgets: Record<string, number> = {};
      for (const [branch, cap] of Object.entries(doc['branchBudgets'])) {
        if (typeof cap === 'number') budgets[branch] = cap;
        else skipped.push(`branchBudgets["${branch}"]`);
      }
      patch.branchBudgets = budgets;
    } else {
      skipped.push('branchBudgets');
    }
  }

  // Export targets: ids are generated, preferring the old name so the existing
  // per-target secrets and retry queue keep working unchanged.
  const renamed: Parsed['renamed'] = [];
  let targets = 0;
  const exp = doc['export'];
  if (isObject(exp)) {
    const taken = new Set<string>();
    const exported: { webhookTargets?: ExportTarget[]; mqttTargets?: ExportTarget[] } = {};
    for (const [kind, key] of [['webhook', 'webhookTargets'], ['mqtt', 'mqttTargets']] as const) {
      if (exp[key] === undefined) continue;
      exported[key] = validEntries(`export.${key}`, exp[key], TargetShape, skipped).map((t) => {
        const id = TARGET_ID_RE.test(t.name) && !taken.has(t.name) ? t.name : uniqueTargetId(t.name, taken);
        taken.add(id);
        targets++;
        if (id !== t.name) renamed.push({ kind, from: t.name, to: id });
        return { id, name: t.name, url: t.url };
      });
    }
    patch.export = exported;
  } else if (exp !== undefined) {
    skipped.push('export');
  }

  const dash = doc['dashboard'];
  const rawColumns = isObject(dash) ? dash['columns'] : undefined;
  const panels =
    isObject(dash) && dash['panels'] !== undefined
      ? (validEntries('dashboard.panels', dash['panels'], PanelShape, skipped) as ConfigPanelLayout[])
      : undefined;
  return { patch, panels, columns: typeof rawColumns === 'number' ? rawColumns : undefined, targets, renamed, skipped };
}

// ── The import ───────────────────────────────────────────────────────────────

/** Where to move the file: `config.json.migrated`, or a numbered sibling when a backup is already there. */
function backupPath(dir: string): string {
  let target = path.join(dir, BACKUP);
  for (let n = 2; existsSync(target); n++) target = path.join(dir, `${BACKUP}-${n}`);
  return target;
}

const SECRET_BASES: Record<'webhook' | 'mqtt', readonly SecretKey[]> = {
  webhook: [SECRET_KEYS.webhookApiKey, SECRET_KEYS.webhookBearerToken, SECRET_KEYS.webhookSigningSecret],
  mqtt: [SECRET_KEYS.mqttPassword],
};

/** Move a target's credentials from `<base>:<old name>` to `<base>:<new id>`, and its retry queue file. */
async function carryOverTarget(deps: ImportDeps, kind: 'webhook' | 'mqtt', from: string, to: string): Promise<void> {
  for (const base of SECRET_BASES[kind]) {
    const value = await deps.secrets.get(targetSecretKey(base, from));
    if (value === undefined) continue;
    if ((await deps.secrets.get(targetSecretKey(base, to))) === undefined) await deps.secrets.store(targetSecretKey(base, to), value);
    await deps.secrets.delete(targetSecretKey(base, from));
  }
  const queue = (name: string): string => path.join(deps.storageDir, queueFileFor(name));
  if (existsSync(queue(from)) && !existsSync(queue(to))) renameSync(queue(from), queue(to));
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The one message: what moved, and what a human still has to do. */
function summary(r: ImportResult, targets: number, backup: string): string {
  const moved = [
    r.written.length > 0 ? count(r.written.length, 'setting') : '',
    targets > 0 ? count(targets, 'export target') : '',
    r.layoutSeeded ? 'the dashboard layout' : '',
  ].filter(Boolean);
  const attention: string[] = [];
  if (r.skipped.length > 0) attention.push(`could not import ${r.skipped.join(', ')} (invalid)`);
  return (
    `Mallard now keeps its configuration in VS Code settings. Imported ${moved.join(', ') || 'nothing'} from config.json` +
    ` (kept as ${backup}).` +
    (attention.length > 0 ? ` Needs your attention: ${attention.join('; ')}.` : '')
  );
}

export async function importLegacyConfig(deps: ImportDeps): Promise<ImportResult> {
  const { storageDir, ui = vscodeImportUi, logger = defaultLogger } = deps;
  const file = path.join(storageDir, FILE);
  const empty: ImportResult = { status: 'none', written: [], skipped: [], layoutSeeded: false, legacyRules: [], legacyGroups: [] };
  if (!existsSync(file)) return empty;

  const fail = async (why: string, err?: unknown): Promise<ImportResult> => {
    logger.warn('config', `${file}: ${why}; leaving it in place`, err);
    if (!getFlag(deps.state, FLAG_CONFIG_IMPORT_WARNED)) {
      await setFlag(deps.state, FLAG_CONFIG_IMPORT_WARNED);
      ui.warn(`Mallard could not import ${file} into VS Code settings (${why}). It was left untouched; see the Mallard output for details.`);
    }
    return { ...empty, status: 'failed' };
  };

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return fail('it could not be read as JSON', err);
  }
  if (!isObject(doc)) return fail('it is not a JSON object');

  const parsed = parseDocument(doc);
  const result: ImportResult = {
    ...empty,
    skipped: parsed.skipped,
    legacyRules: (Array.isArray(doc['rules']) ? doc['rules'] : []).filter(isObject) as unknown as LegacyRule[],
    legacyGroups: (Array.isArray(doc['groups']) ? doc['groups'] : []).filter(isObject) as unknown as LegacyGroup[],
  };

  try {
    await deps.config.update(parsed.patch);
    for (const { kind, from, to } of parsed.renamed) await carryOverTarget(deps, kind, from, to);
    if (parsed.panels && deps.state.get(LAYOUT_V1_KEY) === undefined) {
      await deps.state.update(LAYOUT_V1_KEY, configPanelsToLayout(parsed.panels));
      result.layoutSeeded = true;
    }
    result.backup = backupPath(storageDir);
    renameSync(file, result.backup);
  } catch (err) {
    return fail('writing the settings failed', err);
  }

  result.status = 'imported';
  result.written = Object.entries(parsed.patch).flatMap(([k, v]) =>
    isObject(v) && k !== 'branchBudgets' ? Object.keys(v).map((s) => `${k}.${s}`) : [k],
  );
  if (result.written.length > 0 || result.layoutSeeded || result.skipped.length > 0) {
    ui.info(summary(result, parsed.targets, path.basename(result.backup)));
  }
  logger.info('config', `imported ${file} into settings (${result.written.join(', ') || 'nothing'}); original kept as ${result.backup}`);
  return result;
}

/** Delete `config.json` and every `config.json.migrated*` backup in `dir` (the full wipe). Best-effort. */
export function deleteLegacyConfigFiles(dir: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name !== FILE && !name.startsWith(BACKUP)) continue;
    try {
      unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      /* already gone or locked: best-effort */
    }
  }
  return removed;
}
