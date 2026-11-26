/**
 * Dashboard layout access, persisted in the extension's `globalState` as a
 * {@link LayoutV2} under {@link LAYOUT_V2_KEY}.
 *
 * Migration: while the v2 key is absent and the v1 key ({@link LAYOUT_V1_KEY},
 * an array of `{id, span, hidden, size}`) is present, the v1 layout is migrated
 * ONCE (`migrateV1`) and written to the v2 key. The v1 key is never modified,
 * so a downgrade still finds its layout. The grid is a fixed 4 columns, so
 * nothing here reads `dashboard.columns` or config.json.
 */
import * as vscode from 'vscode';
import { defaultLayout, migrateV1, parseLayoutV2 } from '../domain/layout';
import type { LayoutV2 } from '../domain/contracts';
import { defaultLogger, Logger } from '../util/logger';

/** globalState key holding the legacy v1 layout (read for the one-time migration, never written). */
export const LAYOUT_V1_KEY = 'mallard.layout.v1';
/** globalState key holding the current layout. */
export const LAYOUT_V2_KEY = 'mallard.layout.v2';

export class LayoutStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<LayoutV2>();
  readonly onDidChange = this._onDidChange.event;

  private lastJson: string;
  /** The migrated layout, served from memory until its write to the v2 key has landed. */
  private migrated: LayoutV2 | undefined;

  constructor(
    private readonly state: vscode.Memento,
    private readonly logger: Logger = defaultLogger,
  ) {
    this.lastJson = JSON.stringify(this.get());
  }

  get(): LayoutV2 {
    return parseLayoutV2(this.state.get<unknown>(LAYOUT_V2_KEY)) ?? this.migrate();
  }

  async set(layout: LayoutV2): Promise<void> {
    this.migrated = undefined;
    await this.state.update(LAYOUT_V2_KEY, parseLayoutV2(layout) ?? defaultLayout());
    this.emitIfChanged();
  }

  /** Forget the layout entirely (both keys): the dashboard returns to the default. Used by "Prepare for Uninstall". */
  async reset(): Promise<void> {
    this.migrated = undefined;
    await this.state.update(LAYOUT_V2_KEY, undefined);
    await this.state.update(LAYOUT_V1_KEY, undefined);
    this.emitIfChanged();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** v1 -> v2, at most once per instance; with no v1 layout stored this is just the default. */
  private migrate(): LayoutV2 {
    if (this.migrated) return this.migrated;
    const v1 = this.state.get<unknown>(LAYOUT_V1_KEY);
    if (v1 === undefined) return defaultLayout();
    this.migrated = migrateV1(v1);
    Promise.resolve(this.state.update(LAYOUT_V2_KEY, this.migrated)).catch((err: unknown) =>
      this.logger.warn('layout', 'could not persist the migrated dashboard layout', err),
    );
    return this.migrated;
  }

  private emitIfChanged(): void {
    const next = this.get();
    const json = JSON.stringify(next);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this._onDidChange.fire(next);
  }
}
