import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { RestrictionEngine } from '../../../src/extension-backend/app/RestrictionEngine';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';
import type { SnapshotData, UserConfig } from '../../../src/extension-backend/domain/types';
import { buildReconcileInput, wireRestriction } from '../../../src/extension-backend/wiring/wireRestriction';

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function snapshot(authStatus: 'signed-in' | 'signed-out' = 'signed-out'): SnapshotData {
  return { authStatus, today: { credits: 1, cost: 0, tokens: 0 } } as unknown as SnapshotData;
}

describe('buildReconcileInput', () => {
  it('passes the snapshot and rules, defaulting rules to none and omitting unset optional blocks', () => {
    const s = snapshot();
    const bare: UserConfig = {
      monthlyBudget: 0,
      includedCredits: 300,
      dailyCreditAlert: 0,
      alerts: { velocityEnabled: false, velocityCreditsPerHour: 0 },
    };
    const input = buildReconcileInput(s, bare);
    assert.equal(input.snapshot, s);
    assert.deepEqual(input.rules, []);
    assert.equal(input.signedIn, false);
    assert.equal('vars' in input, false);
    assert.equal('groups' in input, false);
    assert.equal('branchBudgets' in input, false);
  });

  it('carries vars, groups and branch budgets, and derives signedIn from the auth status', () => {
    const cfg: UserConfig = {
      ...DEFAULT_USER_CONFIG,
      rules: [{ id: 'r', severity: 'warning', message: 'm', when: true }],
      vars: { limit: 5 },
      groups: [{ id: 'g', active: true }],
      branchBudgets: { main: 100 },
    };
    const input = buildReconcileInput(snapshot('signed-in'), cfg);
    assert.deepEqual(input.rules, cfg.rules);
    assert.deepEqual(input.vars, { limit: 5 });
    assert.deepEqual(input.groups, cfg.groups);
    assert.deepEqual(input.branchBudgets, { main: 100 });
    assert.equal(input.signedIn, true);
  });
});

describe('wireRestriction', () => {
  const origReconcile = RestrictionEngine.prototype.reconcile;
  afterEach(() => {
    RestrictionEngine.prototype.reconcile = origReconcile;
  });

  async function setup(initial: UserConfig) {
    const box = { cfg: initial };
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
    const first: UserConfig = { ...DEFAULT_USER_CONFIG, rules: [] };
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
      assert.deepEqual(calls[0], buildReconcileInput(s, first));
      assert.deepEqual(calls[1], buildReconcileInput(s, second), 'the config is read per snapshot, not captured at startup');
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
