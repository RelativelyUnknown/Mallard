import { strict as assert } from 'assert';
import { errAsync, okAsync } from 'neverthrow';
import { UsageService } from '../../../src/extension-backend/app/UsageService';
import { BillingError } from '../../../src/extension-backend/billing/GitHubUsageService';
import type { IBillingProvider } from '../../../src/extension-backend/billing/IBillingProvider';
import type { CurrencyService } from '../../../src/extension-backend/pricing/CurrencyService';
import type { IngestService } from '../../../src/extension-backend/ingest/IngestService';
import type { PricingService } from '../../../src/extension-backend/pricing/PricingService';
import type { IConfigService } from '../../../src/extension-backend/app/ConfigService';
import type { IEventSnapshotReader, SnapshotSourceData } from '../../../src/extension-backend/store/EventReader';
import { resolveRangePreset } from '../../../src/extension-backend/domain/rangePreset';
import type { Filter, UserConfig } from '../../../src/extension-backend/domain/types';

const EMPTY: SnapshotSourceData = {
  totals: {
    all: { credits: 0, cost: 0, tokens: 0, eventCount: 0 },
    mtd: { credits: 0, cost: 0, tokens: 0, eventCount: 0 },
    today: { credits: 0, cost: 0, tokens: 0, eventCount: 0 },
  },
  estimatedEventCount: 0,
  daily: [],
  models: [],
  languages: [],
  repos: [],
  hourly: [],
  categories: [],
  sankey: [],
  dims: { models: [], surfaces: [], sources: [], repos: [] },
  weekday: [0, 0, 0, 0, 0, 0, 0],
};

const BUSY: SnapshotSourceData = {
  ...EMPTY,
  totals: {
    all: { credits: 500, cost: 20, tokens: 1000, eventCount: 10 },
    mtd: { credits: 500, cost: 20, tokens: 1000, eventCount: 10 },
    today: { credits: 500, cost: 20, tokens: 1000, eventCount: 10 },
  },
};

type Listener<T> = (v: T) => void;
function emitter<T>() {
  const ls: Listener<T>[] = [];
  return {
    event: (l: Listener<T>) => {
      ls.push(l);
      return { dispose() {} };
    },
    fire: (v: T) => ls.forEach((l) => l(v)),
  };
}

function baseConfig(over: Partial<UserConfig> = {}): UserConfig {
  return {
    monthlyBudget: 0,
    includedCredits: 300,
    dailyCreditAlert: 0,
    alerts: { velocityEnabled: false, velocityCreditsPerHour: 0 },
    ...over,
  };
}

function recordingLogger() {
  const errors: string[] = [];
  return {
    errors,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (_tag: string, msg: string) => void errors.push(msg),
    },
  };
}

function harness(opts: {
  reader?: Partial<IEventSnapshotReader>;
  config?: UserConfig;
  github?: IBillingProvider;
} = {}) {
  const reader: IEventSnapshotReader = {
    readSnapshotCache: async () => BUSY,
    readFilteredSnapshot: async () => BUSY,
    creditsByBranch: async () => 0,
    ...opts.reader,
  };
  const cfgEmitter = emitter<UserConfig>();
  const config = opts.config ?? baseConfig();
  const userConfig = { get: () => config, onDidChange: cfgEmitter.event } as unknown as IConfigService;
  const pricing = { pricePerCredit: 0.04, currentManifest: undefined } as unknown as PricingService;
  const ingest = {
    getStatus: () => ({ kind: 'ok' as const }),
    start: async () => {},
    dispose: () => {},
  } as unknown as IngestService;
  const currency = { currentRates: () => ({}) } as unknown as CurrencyService;
  const warnings: string[] = [];
  const host = {
    showWarningMessage: async (m: string) => {
      warnings.push(m);
      return undefined;
    },
    executeCommand: async () => undefined,
  };
  const { logger, errors } = recordingLogger();
  const svc = new UsageService(reader, pricing, ingest, userConfig, currency, opts.github, host, logger);
  return { svc, warnings, errors, cfgEmitter };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('UsageService — filtered snapshots do not feed alerts or restriction', () => {
  it('a filtered compute emits to the UI but not onDidComputeUnfiltered, alerts or history', async () => {
    const { svc, warnings } = harness({ config: baseConfig({ dailyCreditAlert: 1 }) });
    const ui: number[] = [];
    const unfiltered: number[] = [];
    svc.onDidChangeSnapshot(() => ui.push(1));
    svc.onDidComputeUnfiltered(() => unfiltered.push(1));

    assert.equal(svc.currentUnfiltered, undefined, 'nothing computed yet');
    await svc.setFilter({ models: ['gpt-4o'] });
    assert.equal(ui.length, 1, 'UI still gets the filtered snapshot');
    assert.equal(svc.currentUnfiltered, undefined, 'a filtered snapshot is never the unfiltered one');
    assert.equal(unfiltered.length, 0, 'restriction stream untouched by a filtered snapshot');
    assert.deepEqual(warnings, [], 'no alert evaluated against a filtered slice');

    await svc.setFilter({});
    assert.equal(unfiltered.length, 1, 'clearing the filter feeds the restriction stream again');
    assert.ok(warnings.length >= 1, 'alerts run for the unfiltered compute');
    assert.deepEqual((svc as { currentUnfiltered?: { filter: unknown } }).currentUnfiltered?.filter, {}, 'what the alerts and restrictions evaluated');
    svc.dispose();
  });

  it('a billing change while filtered re-emits the unfiltered snapshot (not the filtered one)', async () => {
    let fireBilling: () => void = () => {};
    const github: IBillingProvider = {
      name: 'mock',
      fetch: () => okAsync({ quota: null, items: [], fetchedAt: 1, totalNetAmount: 0 }),
      onDidChange: (fn) => {
        fireBilling = fn;
        return { dispose() {} };
      },
      dispose() {},
    };
    const { svc } = harness({ github });
    await svc.setFilter({});
    const seen: Array<Filter> = [];
    svc.onDidComputeUnfiltered((s) => seen.push(s.filter));
    await svc.setFilter({ models: ['m'] });
    fireBilling();
    await tick();
    assert.deepEqual(seen, [{}], 'only the unfiltered snapshot is re-emitted with the new billing state');
    svc.dispose();
  });
});

describe('UsageService — relative date presets are re-resolved on every compute', () => {
  it('replaces a stale stored range with the current range of the preset', async () => {
    const seen: Filter[] = [];
    const { svc } = harness({
      reader: {
        readFilteredSnapshot: async (f) => {
          seen.push(f);
          return EMPTY;
        },
      },
    });
    const stale = { start: Date.UTC(2020, 0, 1), end: Date.UTC(2020, 0, 2) };
    await svc.setFilter({ rangePreset: '7d', range: stale });
    const expected = resolveRangePreset('7d', Date.now());
    assert.ok(expected);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.range, expected, 'the 7d window around now, not the 2020 range stored with the filter');
    assert.equal(seen[0]!.rangePreset, '7d');
    // The snapshot still reports the filter the user chose.
    assert.equal(svc.current?.filter.rangePreset, '7d');
    svc.dispose();
  });

  it('leaves a non-relative preset ("all") on the fast unfiltered path', async () => {
    let filteredReads = 0;
    let cacheReads = 0;
    const { svc } = harness({
      reader: {
        readFilteredSnapshot: async () => (filteredReads++, EMPTY),
        readSnapshotCache: async () => (cacheReads++, EMPTY),
      },
    });
    await svc.setFilter({ rangePreset: 'all' });
    assert.equal(filteredReads, 0);
    assert.equal(cacheReads, 1);
    svc.dispose();
  });

  it('keeps resolving: a later compute moves the window with the clock', async () => {
    const seen: Filter[] = [];
    const { svc } = harness({
      reader: {
        readFilteredSnapshot: async (f) => (seen.push(f), EMPTY),
      },
    });
    await svc.setFilter({ rangePreset: 'today' });
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 86_400_000;
      await svc.setFilter({ rangePreset: 'today' });
    } finally {
      Date.now = realNow;
    }
    assert.equal(seen.length, 2);
    assert.ok(seen[1]!.range!.start > seen[0]!.range!.start, 'second compute resolved against the later clock');
    svc.dispose();
  });
});

describe('UsageService — compute() is serialised', () => {
  it('coalesces overlapping computes into the running one plus a single latest-wins follow-up', async () => {
    const calls: Array<{ filter: Filter; gate: ReturnType<typeof deferred<SnapshotSourceData>> }> = [];
    const { svc } = harness({
      reader: {
        readFilteredSnapshot: (f) => {
          const gate = deferred<SnapshotSourceData>();
          calls.push({ filter: f, gate });
          return gate.promise;
        },
      },
    });
    const emitted: Filter[] = [];
    svc.onDidChangeSnapshot((s) => emitted.push(s.filter));

    const a = svc.setFilter({ models: ['a'] });
    await tick();
    const b = svc.setFilter({ models: ['b'] });
    const c = svc.setFilter({ models: ['c'] });
    await tick();
    assert.equal(calls.length, 1, 'b and c wait behind the running compute');

    calls[0]!.gate.resolve(EMPTY);
    await a;
    await tick();
    assert.equal(calls.length, 2, 'exactly one follow-up compute, not one per trigger');
    assert.deepEqual(calls[1]!.filter.models, ['c'], 'the follow-up reads the latest filter');

    calls[1]!.gate.resolve(EMPTY);
    await Promise.all([b, c]);
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted.at(-1)?.models, ['c'], 'latest wins; nothing lands out of order');
    svc.dispose();
  });

  it('keeps serving computes after one fails', async () => {
    let fail = true;
    const { svc } = harness({
      reader: {
        readSnapshotCache: async () => {
          if (fail) throw new Error('db locked');
          return BUSY;
        },
      },
    });
    await assert.rejects(svc.setFilter({}), /db locked/);
    fail = false;
    await svc.setFilter({});
    assert.ok(svc.current);
    svc.dispose();
  });
});

describe('UsageService — billing state', () => {
  function providerWith(results: Array<ReturnType<IBillingProvider['fetch']>>) {
    let fire: () => void = () => {};
    let i = 0;
    const provider: IBillingProvider = {
      name: 'mock',
      fetch: () => results[Math.min(i++, results.length - 1)]!,
      onDidChange: (fn) => {
        fire = fn;
        return { dispose() {} };
      },
      dispose() {},
    };
    return { provider, trigger: () => fire() };
  }
  const ok = () => okAsync({ quota: null, items: [], fetchedAt: 1, totalNetAmount: 0 });

  it('removes stale githubBilling/authError when the billing state clears', async () => {
    const { provider, trigger } = providerWith([
      ok(),
      errAsync(new Error('Network timeout')),
      errAsync(Object.assign(new Error('x'), { kind: 'not-signed-in' })),
    ]);
    const { svc } = harness({ github: provider });
    await svc.start();
    await tick(60);
    assert.equal(svc.current?.authStatus, 'signed-in');
    assert.ok(svc.current?.githubBilling, 'billing present while signed in');

    trigger();
    await tick();
    assert.equal(svc.current?.authStatus, 'error');
    assert.equal(svc.current?.githubBilling, undefined, 'stale billing data dropped on error');
    assert.match(svc.current?.authError ?? '', /Network timeout/);

    trigger();
    await tick();
    assert.equal(svc.current?.authStatus, 'signed-out');
    assert.equal(svc.current?.authError, undefined, 'stale authError dropped once signed out');
    svc.dispose();
  });

  it('treats a typed {kind:"not-signed-in"} error as signed-out regardless of its message', async () => {
    const { provider } = providerWith([errAsync(Object.assign(new Error('please authenticate'), { kind: 'not-signed-in' }))]);
    const { svc } = harness({ github: provider });
    await svc.start();
    await tick(60);
    assert.equal(svc.current?.authStatus, 'signed-out');
    assert.equal(svc.current?.authError, undefined);
    svc.dispose();
  });

  it('maps BillingError kinds: not-signed-in is signed-out, auth is an error', async () => {
    const signedOut = providerWith([errAsync(new BillingError('not-signed-in', 'please sign in'))]);
    const a = harness({ github: signedOut.provider });
    await a.svc.start();
    await tick(60);
    assert.equal(a.svc.current?.authStatus, 'signed-out');
    a.svc.dispose();

    const rejected = providerWith([errAsync(new BillingError('auth', 'token rejected', 401))]);
    const b = harness({ github: rejected.provider });
    await b.svc.start();
    await tick(60);
    assert.equal(b.svc.current?.authStatus, 'error');
    assert.match(b.svc.current?.authError ?? '', /token rejected/);
    b.svc.dispose();
  });

  it('still recognises the legacy "Not signed in" message', async () => {
    const { provider } = providerWith([errAsync(new Error('Not signed in'))]);
    const { svc } = harness({ github: provider });
    await svc.start();
    await tick(60);
    assert.equal(svc.current?.authStatus, 'signed-out');
    svc.dispose();
  });
});

describe('UsageService — background work failures are logged, not unhandled', () => {
  it('logs a failing billing refresh triggered by the provider event', async () => {
    let fire: () => void = () => {};
    const github: IBillingProvider = {
      name: 'mock',
      fetch: () => {
        throw new Error('boom');
      },
      onDidChange: (fn) => {
        fire = fn;
        return { dispose() {} };
      },
      dispose() {},
    };
    const { svc, errors } = harness({ github });
    fire();
    await tick();
    assert.ok(errors.some((e) => e.includes('GitHub billing refresh')), errors.join('|'));
    svc.dispose();
  });

  it('logs a failing recompute triggered by a config change', async () => {
    const { svc, errors, cfgEmitter } = harness({
      reader: {
        readSnapshotCache: async () => {
          throw new Error('db gone');
        },
      },
    });
    cfgEmitter.fire(baseConfig());
    await tick();
    assert.ok(errors.some((e) => e.includes('recompute after config change')), errors.join('|'));
    svc.dispose();
  });
});
