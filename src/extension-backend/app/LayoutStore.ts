/**
 * Dashboard layout access, persisted in the extension's `globalState` under its
 * own key ({@link LAYOUT_STATE_KEY}) — no longer in config.json's
 * `dashboard.panels`. Normalises against the current panel set so adding or
 * removing a panel in a new version never breaks a saved layout.
 *
 * Migration: while the key is empty the store seeds it ONCE from the legacy
 * `dashboard.panels` block of config.json (via `configPanelsToLayout`) and
 * never reads or writes that block again. `dashboard.columns` still lives in
 * config.json and is applied (read-only) when the layout is read.
 */
import * as vscode from 'vscode';
import { DashboardLayout } from '../domain/types';
import { configPanelsToLayout, normalizeLayout } from '../domain/layout';
import { defaultLogger, Logger } from '../util/logger';
import type { IConfigService } from './ConfigService';

/** globalState key holding the v1 layout (an array of {id, span, hidden, size}). */
export const LAYOUT_STATE_KEY = 'mallard.layout.v1';

export class LayoutStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<DashboardLayout>();
  readonly onDidChange = this._onDidChange.event;

  private lastJson: string;
  private readonly sub: vscode.Disposable;
  /** True once this instance has had its one chance to import the legacy config.json block. */
  private seedAttempted = false;
  /** In-memory copy of that import, served while the key is empty (e.g. the write has not landed). */
  private seed: DashboardLayout | undefined;

  constructor(
    private readonly userConfig: Pick<IConfigService, 'get' | 'onDidChange'>,
    private readonly state: vscode.Memento,
    private readonly logger: Logger = defaultLogger,
  ) {
    this.lastJson = JSON.stringify(this.get());
    // `dashboard.columns` still lives in the (hand-editable, watched) config.json
    // — re-emit only when the layout actually changed so unrelated config edits
    // don't reflow the grid.
    this.sub = userConfig.onDidChange(() => this.emitIfChanged());
  }

  get(): DashboardLayout {
    const stored = this.state.get<DashboardLayout>(LAYOUT_STATE_KEY) ?? this.importLegacy();
    return normalizeLayout(stored, this.userConfig.get().dashboard?.columns);
  }

  async set(layout: DashboardLayout): Promise<void> {
    this.seed = undefined;
    await this.state.update(LAYOUT_STATE_KEY, normalizeLayout(layout));
    this.emitIfChanged();
  }

  /** Back to the default layout: clears the stored key without re-importing the legacy config.json block. */
  async reset(): Promise<void> {
    this.seedAttempted = true;
    this.seed = undefined;
    await this.state.update(LAYOUT_STATE_KEY, undefined);
    this.emitIfChanged();
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }

  /** The one-time import: seeds the key from config.json's `dashboard.panels`, at most once per instance. */
  private importLegacy(): DashboardLayout | undefined {
    if (this.seedAttempted) return this.seed;
    this.seedAttempted = true;
    this.seed = configPanelsToLayout(this.userConfig.get().dashboard?.panels);
    Promise.resolve(this.state.update(LAYOUT_STATE_KEY, this.seed)).catch((err: unknown) =>
      this.logger.warn('layout', 'could not persist the imported dashboard layout', err),
    );
    return this.seed;
  }

  private emitIfChanged(): void {
    const next = this.get();
    const json = JSON.stringify(next);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this._onDidChange.fire(next);
  }
}
