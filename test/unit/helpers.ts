import * as vscode from 'vscode';
import type { IConfigService } from '../../src/extension-backend/app/ConfigService';
import { DEFAULT_USER_CONFIG, SourceKind, Surface, UsageEvent, UserConfig } from '../../src/extension-backend/domain/types';
import { VscodeHost } from '../../src/extension-backend/util/vscodeHost';

export interface StubVscodeHost extends VscodeHost {
  warnings: string[];
  commands: Array<{ command: string; args: unknown[] }>;
}

export function makeStubVscodeHost(): StubVscodeHost {
  const warnings: string[] = [];
  const commands: Array<{ command: string; args: unknown[] }> = [];
  return {
    warnings,
    commands,
    showWarningMessage: (msg) => { warnings.push(msg); return Promise.resolve(undefined); },
    executeCommand: (cmd, ...args) => { commands.push({ command: cmd, args }); return Promise.resolve(undefined); },
  };
}

/** An in-memory `vscode.Memento` (globalState/workspaceState) that records every update. */
export interface FakeMemento extends vscode.Memento {
  /** The stored values; `update(key, undefined)` deletes the key, as VS Code does. */
  data: Map<string, unknown>;
  /** Every update call in order, including deletions (value undefined). */
  updates: Array<{ key: string; value: unknown }>;
}

export function makeMemento(initial: Record<string, unknown> = {}): FakeMemento {
  const data = new Map<string, unknown>(Object.entries(initial));
  const updates: Array<{ key: string; value: unknown }> = [];
  return {
    data,
    updates,
    keys: () => [...data.keys()],
    get: <T>(key: string, fallback?: T): T | undefined => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => {
      updates.push({ key, value });
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  };
}

let counter = 0;

/** Build a UsageEvent with sensible defaults for tests. */
export function makeEvent(partial: Partial<UsageEvent> & { ts: number }): UsageEvent {
  counter += 1;
  const credits = partial.credits ?? 1;
  const base: UsageEvent = {
    id: partial.id ?? `e${counter}`,
    ts: partial.ts,
    modelId: partial.modelId ?? 'gpt-4o',
    surface: (partial.surface ?? 'chat') as Surface,
    source: (partial.source ?? 'local') as SourceKind,
    credits,
    cost: partial.cost ?? credits * 0.04,
    estimated: partial.estimated ?? false,
  };
  return {
    ...base,
    ...(partial.promptTokens !== undefined ? { promptTokens: partial.promptTokens } : {}),
    ...(partial.completionTokens !== undefined ? { completionTokens: partial.completionTokens } : {}),
    ...(partial.cacheCreationTokens !== undefined ? { cacheCreationTokens: partial.cacheCreationTokens } : {}),
    ...(partial.cacheReadTokens !== undefined ? { cacheReadTokens: partial.cacheReadTokens } : {}),
    ...(partial.thinkingTokens !== undefined ? { thinkingTokens: partial.thinkingTokens } : {}),
    ...(partial.repo !== undefined ? { repo: partial.repo } : {}),
    ...(partial.branch !== undefined ? { branch: partial.branch } : {}),
    ...(partial.attribution !== undefined ? { attribution: partial.attribution } : {}),
    ...(partial.language !== undefined ? { language: partial.language } : {}),
    ...(partial.costByCategory !== undefined ? { costByCategory: partial.costByCategory } : {}),
  };
}

/**
 * An in-memory, settable stand-in for the settings-backed `ConfigService`: `get()`
 * returns the current config, `update()`/`set()` merge a patch in and fire the one
 * `onDidChange` event, `fire()` fires it without changing anything.
 */
export interface FakeConfig extends IConfigService, vscode.Disposable {
  /** Same as `update` (the name `UserConfigStore` used). */
  set(patch: Partial<UserConfig>): Promise<void>;
  reset(): Promise<void>;
  fire(): void;
  /** Every patch passed to `update`, in order. */
  readonly updates: Array<Partial<UserConfig>>;
}

export function makeFakeConfig(initial: Partial<UserConfig> = {}): FakeConfig {
  let config: UserConfig = { ...DEFAULT_USER_CONFIG, ...initial };
  const emitter = new vscode.EventEmitter<void>();
  const updates: Array<Partial<UserConfig>> = [];
  const update = async (patch: Partial<UserConfig>): Promise<void> => {
    updates.push(patch);
    config = { ...config, ...patch, alerts: { ...config.alerts, ...(patch.alerts ?? {}) } };
    emitter.fire();
  };
  return {
    get: () => config,
    onDidChange: emitter.event,
    update,
    set: update,
    reset: async () => {
      config = { ...DEFAULT_USER_CONFIG };
      emitter.fire();
    },
    fire: () => emitter.fire(),
    updates,
    dispose: () => emitter.dispose(),
  };
}
