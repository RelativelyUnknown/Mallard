/**
 * What every `wire*` function receives from the composition root
 * (`container.ts`). Types only.
 */
import type * as vscode from 'vscode';

export interface WiringScope {
  readonly context: vscode.ExtensionContext;
  /** `context.globalStorageUri.fsPath`: where the store, caches and any pre-settings config.json live. */
  readonly storageDir: string;
  /**
   * Cleanup callbacks for everything started so far. A wire function pushes one
   * IMMEDIATELY after creating a resource that holds a timer, handle or
   * subscription, so that a failure later in the same function (or in a later
   * one) still releases it; `withStartupRollback` runs them in reverse. Anything
   * a function pushes onto `context.subscriptions` is rolled back the same way.
   */
  readonly started: Array<() => void>;
}
