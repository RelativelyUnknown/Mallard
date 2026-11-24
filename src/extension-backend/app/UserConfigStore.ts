/* c8 ignore next */
/**
 * Budget and alert configuration, stored as a hand-editable JSON file in the
 * extension's storage directory. The file is the source of truth: the dashboard
 * writes it through {@link set}, and external edits are picked up by a watcher
 * and broadcast via {@link onDidChange}.
 *
 * The file is the user's hand-edited data, so a bad edit must never cost them
 * it: every top-level block is validated on its own (an invalid block is
 * dropped with a warning, the others are kept), a malformed or partly invalid
 * file leaves the last good in-memory config in force, and the file itself is
 * not rewritten until the user changes something — at which point the bad
 * original is first copied to `config.json.bad-<timestamp>`.
 */
import { existsSync, watch, FSWatcher } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { UserConfig, SEED_USER_CONFIG } from '../domain/types';
import { GroupSchema, RuleSchema } from '../domain/alertRules';
import { JsonFileStore } from '../util/JsonFileStore';
import { defaultLogger, Logger } from '../util/logger';
import { mergeConfig } from './mergeConfig';

export { mergeConfig } from './mergeConfig';

const FILE = 'config.json';

export const ConfigSchema = z
  .object({
    monthlyBudget: z.number(),
    includedCredits: z.number(),
    dailyCreditAlert: z.number(),
    alerts: z
      .object({
        velocityEnabled: z.boolean(),
        velocityCreditsPerHour: z.number(),
      })
      .partial(),
    version: z.union([z.literal(1), z.literal(2)]).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    // Rules/groups reuse the canonical schemas from alertRules.ts. A previous
    // inline copy required `when` and omitted conditions/match/thresholds/
    // snoozeUntil, so a config.json using the documented `conditions`
    // shorthand failed this parse and readFromDisk silently reset the WHOLE
    // config to defaults.
    groups: z.array(GroupSchema).optional(),
    rules: z.array(RuleSchema).optional(),
    budget: z
      .object({
        monthlyUsd: z.number(),
        includedCredits: z.number(),
      })
      .optional(),
    branchBudgets: z.record(z.string(), z.number()).optional(),
    // The blocks below were documented in schemas/mallard-config.schema.json
    // but missing here — zod strips unknown keys, so config.json's
    // githubBilling/dashboard/display never survived a read.
    githubBilling: z
      .object({
        mode: z.enum(['vscode-session', 'pat']).optional(),
        org: z.string().optional(),
      })
      .optional(),
    dashboard: z
      .object({
        columns: z.number().optional(),
        panels: z
          .array(
            z.object({
              id: z.string(),
              gridColumn: z.string().optional(),
              gridRow: z.string().optional(),
              hidden: z.boolean().optional(),
              size: z.enum(['compact', 'normal', 'tall']).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    display: z
      .object({
        dailyBarsWindow: z.number().optional(),
        heatmapWeeks: z.number().optional(),
        topN: z.number().optional(),
      })
      .optional(),
    currency: z.string().optional(),
    export: z
      .object({
        webhookTargets: z
          .array(z.object({ name: z.string().min(1), url: z.string().min(1) }))
          .optional(),
        mqttTargets: z
          .array(z.object({ name: z.string().min(1), url: z.string().min(1) }))
          .optional(),
      })
      .optional(),
  })
  .partial();

/** Result of validating a parsed config.json block by block. */
export interface LenientConfigParse {
  /** The blocks that validated. */
  config: Partial<UserConfig>;
  /** Top-level keys whose value failed validation (and are left out of `config`). */
  dropped: string[];
  /** Individual list entries (rules/groups) that failed validation; their valid siblings are kept. */
  droppedItems: string[];
}

/** Blocks that are lists of independently valid entries: one bad entry must not discard the rest. */
const PER_ITEM_BLOCKS: Record<string, z.ZodType> = { rules: RuleSchema, groups: GroupSchema };

function describeItem(key: string, index: number, item: unknown): string {
  const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? `${key}[${index}] ("${id}")` : `${key}[${index}]`;
}

/**
 * Validate each top-level key against its own schema so one bad block cannot
 * discard the rest of the file. Returns undefined when the document is not an
 * object at all. Unknown keys are ignored (as zod strips them).
 */
export function parseConfigLeniently(raw: unknown): LenientConfigParse | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const doc = raw as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  const dropped: string[] = [];
  const droppedItems: string[] = [];
  for (const [key, schema] of Object.entries(ConfigSchema.shape) as Array<[string, z.ZodType]>) {
    if (!(key in doc)) continue;
    const itemSchema = PER_ITEM_BLOCKS[key];
    const value = doc[key];
    if (itemSchema && Array.isArray(value)) {
      const kept: unknown[] = [];
      value.forEach((item, i) => {
        const r = itemSchema.safeParse(item);
        if (r.success) kept.push(r.data);
        else droppedItems.push(describeItem(key, i, item));
      });
      config[key] = kept;
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) dropped.push(key);
    else if (parsed.data !== undefined) config[key] = parsed.data;
  }
  return { config: config as Partial<UserConfig>, dropped, droppedItems };
}

export class UserConfigStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<UserConfig>();
  readonly onDidChange = this._onDidChange.event;

  private readonly store: JsonFileStore<UserConfig>;
  private current: UserConfig = mergeConfig({});
  private watcher: FSWatcher | undefined;
  /**
   * The last file content we processed or wrote. A watcher event carrying this
   * exact content is our own echo (or a no-op touch). It replaces a 500ms
   * suppression window that also swallowed any genuine external edit landing
   * shortly after one of our writes.
   */
  private knownText: string | undefined;
  /**
   * Raw text of a config.json we could not use in full (malformed, or with
   * invalid blocks). While set, the file on disk holds data the in-memory
   * config does not, so it is backed up before the first write replaces it.
   */
  private unusableText: string | undefined;

  constructor(
    storageDir: string,
    private readonly logger: Logger = defaultLogger,
  ) {
    this.store = new JsonFileStore<UserConfig>(storageDir, FILE, logger);
    this.current = this.loadInitial();
    this.startWatching();
  }

  /** The on-disk config file, for the "edit config" affordance. */
  get uri(): vscode.Uri {
    return vscode.Uri.file(this.store.file);
  }

  get(): UserConfig {
    return this.current;
  }

  async set(patch: Partial<UserConfig>): Promise<void> {
    this.current = mergeConfig({
      ...this.current,
      ...patch,
      alerts: { ...this.current.alerts, ...(patch.alerts ?? {}) },
    });
    this.writeToDisk();
    this._onDidChange.fire(this.current);
  }

  /** Restore defaults (used by the full reset, which deliberately wipes the file). */
  async reset(): Promise<void> {
    this.current = mergeConfig({});
    this.unusableText = undefined; // an explicit wipe: nothing to preserve
    this.writeToDisk();
    this._onDidChange.fire(this.current);
  }

  dispose(): void {
    this.watcher?.close();
    this._onDidChange.dispose();
  }

  private loadInitial(): UserConfig {
    const text = this.store.readText();
    if (text === undefined) {
      if (existsSync(this.store.file)) {
        // Present but unreadable (permissions…): never seed over it.
        this.logger.warn('config', `cannot read ${this.store.file}; using defaults without rewriting it`);
        return this.current;
      }
      this.current = mergeConfig(SEED_USER_CONFIG);
      this.writeToDisk();
      return this.current;
    }
    this.knownText = text;
    return this.interpret(text);
  }

  /**
   * Turn file text into a config. Anything unusable keeps the last good
   * in-memory value for that part and flags the file so the next write backs
   * it up first; nothing here ever writes.
   */
  private interpret(text: string): UserConfig {
    if (text.trim() === '') return this.current; // empty/truncated mid-save: nothing to read yet
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      this.logger.warn(
        'config',
        `${this.store.file} is not valid JSON; keeping the last good configuration and leaving the file untouched`,
        err,
      );
      this.unusableText = text;
      return this.current;
    }
    const parsed = parseConfigLeniently(raw);
    if (!parsed) {
      this.logger.warn(
        'config',
        `${this.store.file} is not a JSON object; keeping the last good configuration and leaving the file untouched`,
      );
      this.unusableText = text;
      return this.current;
    }
    if (parsed.dropped.length === 0 && parsed.droppedItems.length === 0) {
      this.unusableText = undefined;
      return mergeConfig(parsed.config);
    }
    if (parsed.droppedItems.length > 0) {
      this.logger.warn(
        'config',
        `ignoring invalid entr${parsed.droppedItems.length === 1 ? 'y' : 'ies'} in ${this.store.file}: ` +
          `${parsed.droppedItems.join(', ')}; the other entries still apply`,
      );
    }
    if (parsed.dropped.length > 0) {
      this.logger.warn(
        'config',
        `ignoring invalid block(s) in ${this.store.file}: ${parsed.dropped.join(', ')}; ` +
          'keeping the last good value for each and leaving the file untouched',
      );
    }
    this.unusableText = text;
    const lastGood = this.current as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...parsed.config };
    for (const key of parsed.dropped) {
      if (lastGood[key] !== undefined) merged[key] = lastGood[key];
    }
    return mergeConfig(merged as Partial<UserConfig>);
  }

  private writeToDisk(): void {
    if (this.unusableText !== undefined) {
      // The file on disk is one we could not fully use: keep a copy before it
      // is replaced, and never replace it if the copy cannot be made.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = this.store.backup(`bad-${stamp}`);
      if (!backup) return;
      this.logger.warn('config', `backed up the unusable ${this.store.file} to ${backup}`);
      this.unusableText = undefined;
    }
    const written = this.store.write(this.current);
    if (written !== undefined) this.knownText = written;
  }

  /** Pick up manual edits to the file and broadcast them. */
  private startWatching(): void {
    // Watch the directory, not the file: editors (and our own atomic writes)
    // replace config.json by rename, which would orphan a file-level watcher.
    const fileName = path.basename(this.store.file);
    try {
      this.watcher = watch(path.dirname(this.store.file), (_event, changed) => {
        if (changed && changed.toString() !== fileName) return;
        this.onFileEvent();
      });
      this.watcher.on('error', (err) => this.logger.warn('config', 'config watcher failed', err));
    } /* c8 ignore next 3 */ catch {
      /* watching is best-effort */
    }
  }

  private onFileEvent(): void {
    const text = this.store.readText();
    // Missing (mid-rename or deleted) keeps the in-memory config; identical
    // content is our own write or a no-op touch.
    if (text === undefined || text === this.knownText) return;
    this.knownText = text;
    const next = this.interpret(text);
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      this._onDidChange.fire(this.current);
    }
  }
  /* c8 ignore next */
}
