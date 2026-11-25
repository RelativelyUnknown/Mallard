/**
 * Mallard's configuration, backed by VS Code settings (the `mallard.*` table in
 * `config/settings.ts`). This replaces the hand-edited `config.json` store: one
 * home for every setting, edited from the Settings UI, `settings.json`, Settings
 * Sync or the dashboard, with ONE change event for all of them.
 *
 * VS Code does not validate setting values at runtime, so every read goes
 * through the table's sanitisers: a bad value falls back to the default and a
 * bad entry in an array setting is dropped (each problem is logged once, siblings
 * are kept).
 *
 * `get()` returns the same `UserConfig` shape the rest of the extension has
 * always consumed, so `UsageService`, `chartData` and the alerts are unchanged.
 */
import * as vscode from 'vscode';
import { readSettings, SETTINGS, SettingKey, SettingValues } from '../config/settings';
import { DEFAULT_USER_CONFIG, UserConfig } from '../domain/types';
import { opt } from '../util/lang';
import { defaultLogger, Logger } from '../util/logger';
import { onSettingsChanged, readSetting, writeSetting } from '../util/vscodeSettings';

export interface IConfigService {
  /** The current, validated configuration. */
  get(): UserConfig;
  /** Fires after any change to a `mallard.*` setting, wherever it was made (settings UI, settings.json, sync). */
  onDidChange: vscode.Event<void>;
  /** Persist a partial update through the settings API (user settings). */
  update(patch: Partial<UserConfig>): Promise<void>;
}

/** The three things ConfigService needs from VS Code, injectable for tests. */
export interface ConfigIO {
  /** The raw configured value of a full key (`mallard.x`); not validated. */
  read(key: SettingKey): unknown;
  /** Write a full key to the user (Global) settings; `undefined` removes it. */
  write(key: SettingKey, value: unknown): PromiseLike<void>;
  /** Call `cb` whenever any `mallard.*` setting changes. */
  watch(cb: () => void): vscode.Disposable;
}

const PREFIX = 'mallard.';

export const vscodeConfigIO: ConfigIO = {
  read: (key) => readSetting('mallard', key.slice(PREFIX.length)),
  write: (key, value) => writeSetting('mallard', key.slice(PREFIX.length), value),
  watch: (cb) => onSettingsChanged(['mallard'], cb),
};

/** The `UserConfig` view of the sanitised settings. */
export function toUserConfig(v: SettingValues): UserConfig {
  return {
    ...DEFAULT_USER_CONFIG, // the retired rules language stays at its (empty) defaults
    monthlyBudget: v['mallard.monthlyBudget'],
    includedCredits: v['mallard.includedCredits'],
    dailyCreditAlert: v['mallard.dailyCreditAlert'],
    alerts: {
      velocityEnabled: v['mallard.alerts.velocityEnabled'],
      velocityCreditsPerHour: v['mallard.alerts.velocityCreditsPerHour'],
    },
    flatRules: v['mallard.alerts.rules'],
    branchBudgets: v['mallard.branchBudgets'],
    currency: v['mallard.currency'],
    display: {
      dailyBarsWindow: v['mallard.display.dailyBarsWindow'],
      heatmapWeeks: v['mallard.display.heatmapWeeks'],
      topN: v['mallard.display.topN'],
    },
    githubBilling: {
      mode: v['mallard.githubBilling.mode'],
      ...opt('org', v['mallard.githubBilling.org'] || undefined),
    },
    export: {
      webhookTargets: v['mallard.export.webhookTargets'],
      mqttTargets: v['mallard.export.mqttTargets'],
    },
  };
}

/**
 * Every setting a `UserConfig` patch can write, paired with the patch's value
 * for it (undefined when the patch does not mention it). The single list behind
 * both `update` (writes the defined ones) and `reset` (clears them all).
 */
export function userConfigPairs(patch: Partial<UserConfig>): Array<[SettingKey, unknown]> {
  return [
    ['mallard.monthlyBudget', patch.monthlyBudget],
    ['mallard.includedCredits', patch.includedCredits],
    ['mallard.dailyCreditAlert', patch.dailyCreditAlert],
    ['mallard.alerts.velocityEnabled', patch.alerts?.velocityEnabled],
    ['mallard.alerts.velocityCreditsPerHour', patch.alerts?.velocityCreditsPerHour],
    ['mallard.alerts.rules', patch.flatRules],
    ['mallard.branchBudgets', patch.branchBudgets],
    ['mallard.currency', patch.currency],
    ['mallard.display.dailyBarsWindow', patch.display?.dailyBarsWindow],
    ['mallard.display.heatmapWeeks', patch.display?.heatmapWeeks],
    ['mallard.display.topN', patch.display?.topN],
    ['mallard.githubBilling.mode', patch.githubBilling?.mode],
    ['mallard.githubBilling.org', patch.githubBilling?.org],
    ['mallard.export.webhookTargets', patch.export?.webhookTargets],
    ['mallard.export.mqttTargets', patch.export?.mqttTargets],
  ];
}

export class ConfigService implements IConfigService, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly sub: vscode.Disposable;
  /** Problems already logged, so an unchanged bad value is not repeated on every read. */
  private reported = new Set<string>();

  constructor(
    private readonly io: ConfigIO = vscodeConfigIO,
    private readonly logger: Logger = defaultLogger,
  ) {
    this.sub = io.watch(() => this.emitter.fire());
  }

  get(): UserConfig {
    const problems = new Set<string>();
    const settings = readSettings((key) => this.io.read(key), (p) => problems.add(p));
    for (const p of problems) if (!this.reported.has(p)) this.logger.warn('config', p);
    this.reported = problems;
    return toUserConfig(settings);
  }

  /**
   * Write the fields of `patch` that map to settings, each validated first.
   * Fields without a setting (the retired rules, `dashboard`) are ignored.
   * Writes are sequential: VS Code serialises edits to one settings file anyway.
   */
  async update(patch: Partial<UserConfig>): Promise<void> {
    const targetIds = new Set<string>();
    for (const [key, value] of userConfigPairs(patch)) {
      if (value === undefined) continue;
      const clean = SETTINGS[key].sanitize(value, { targetIds, report: (p) => this.logger.warn('config', `${key}: ${p}`) });
      await this.io.write(key, clean);
    }
  }

  /** Remove every setting `update` can write, returning the user-level configuration to its defaults. */
  async reset(): Promise<void> {
    for (const [key] of userConfigPairs({})) await this.io.write(key, undefined);
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

/**
 * Call `cb` when the value `read()` returns changes (compared by content) after
 * a configuration event. Lets a consumer react to just its slice of the
 * configuration off the one `onDidChange` event, instead of keeping key lists.
 */
export function watchValue<T>(event: vscode.Event<void>, read: () => T, cb: (value: T) => void): vscode.Disposable {
  let last = JSON.stringify(read());
  return event(() => {
    const value = read();
    const json = JSON.stringify(value);
    if (json === last) return;
    last = json;
    cb(value);
  });
}
