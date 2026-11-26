import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { RestrictionEngine } from '../../../src/extension-backend/app/RestrictionEngine';
import type { FlatAlertRule } from '../../../src/extension-backend/domain/contracts';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';
import type { SnapshotData, UserConfig } from '../../../src/extension-backend/domain/types';
import { buildReconcileInput, wireRestriction } from '../../../src/extension-backend/wiring/wireRestriction';

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function snapshot(authStatus: 'signed-in' | 'signed-out' = 'signed-out'): SnapshotData {
  return { authStatus, today: { credits: 1, cost: 0, tokens: 0 } } as unknown as SnapshotData;
}

describe('buildReconcileInput', () => {
  const flat: FlatAlertRule = { id: 'r', metric: 'today.credits', op: '>', value: 5, cooldown: '1h', severity: 'warning', restrict: true };

  it('passes the snapshot, the flat rules (none by default) and the alert history', () => {
    const s = snapshot();
    const history = [{ ts: 1, todayCredits: 2 }];
    const bare: UserConfig = {
      monthlyBudget: 0,
      includedCredits: 300,
      dailyCreditAlert: 0,
      alerts: { velocityEnabled: false, velocityCreditsPerHour: 0 },
    };
    assert.deepEqual(buildReconcileInput(s, bare, history), { snapshot: s, rules: [], history });
    const withRules: UserConfig = { ...DEFAULT_USER_CONFIG, flatRules: [flat] };
    assert.deepEqual(buildReconcileInput(s, withRules, history).rules, [flat]);
  });

  it('accepts no snapshot yet (the simulate command before the first compute)', () => {
    assert.equal(buildReconcileInput(null, DEFAULT_USER_CONFIG, []).snapshot, null);
  });
});

describe('wireRestriction', () => {
  const origReconcile = RestrictionEngine.prototype.reconcile;
  afterEach(() => {
    RestrictionEngine.prototype.reconcile = origReconcile;
  });

  async function setup(initial: UserConfig) {
    const box = { cfg: initial, history: [{ ts: 1, todayCredits: 1 }] };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-wire-restriction-'));
    const listeners: Array<(s: SnapshotData) => void> = [];
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const started: Array<() => void> = [];
    const errors: string[] = [];
    const wired = wireRestriction(
      { context, storageDir: dir, started },
      {
        usage: {
          onDidComputeUnfiltered: (cb: (s: SnapshotData) => void) => {
            listeners.push(cb);
            return { dispose() {} };
          },
        },
        userConfig: { get: () => box.cfg },
        alerts: { getHistory: () => box.history },
        logger: {
          debug() {},
          info() {},
          warn() {},
          error: (_tag: string, msg: string) => void errors.push(msg),
        },
      },
    );
    return {
      ...wired,
      box,
      listeners,
      started,
      errors,
      context,
      cleanup: async () => {
        for (const cleanup of [...started].reverse()) cleanup();
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  }

  it('reconciles every unfiltered snapshot against the CURRENT user config', async () => {
    const calls: unknown[] = [];
    RestrictionEngine.prototype.reconcile = async function (input) {
      calls.push(input);
      return this.getState();
    };
    const first: UserConfig = { ...DEFAULT_USER_CONFIG, flatRules: [] };
    const t = await setup(first);
    try {
      assert.equal(t.listeners.length, 1);
      assert.equal(t.context.subscriptions.length, 1);
      assert.equal(t.started.length, 1, 'the engine registers a cleanup');

      const s = snapshot('signed-in');
      t.listeners[0]!(s);
      await tick();
      const second: UserConfig = { ...DEFAULT_USER_CONFIG, branchBudgets: { main: 10 } };
      t.box.cfg = second;
      t.listeners[0]!(s);
      await tick();

      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], buildReconcileInput(s, first, t.box.history));
      assert.deepEqual(calls[1], buildReconcileInput(s, second, t.box.history), 'the config is read per snapshot, not captured at startup');
    } finally {
      await t.cleanup();
    }
  });

  it('logs a failed reconcile instead of rejecting', async () => {
    RestrictionEngine.prototype.reconcile = async () => {
      throw new Error('disk full');
    };
    const t = await setup({ ...DEFAULT_USER_CONFIG });
    try {
      t.listeners[0]!(snapshot());
      await tick();
      assert.deepEqual(t.errors, ['restriction reconcile failed']);
    } finally {
      await t.cleanup();
    }
  });
});
