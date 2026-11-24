import { strict as assert } from 'assert';
import { buildRuleContext, type HistorySample } from '../../src/extension-backend/domain/expr/context';
import { resolveVar } from '../../src/extension-backend/domain/expr/jsonCondition';
import type { UsageAggregate, UsageSnapshot } from '../../src/extension-backend/domain/types';

function minimalSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    generatedAt: Date.now(),
    today: { credits: 10, cost: 0.4, tokens: 500 },
    budget: {
      monthly: 20,
      includedCredits: 300,
      usedCredits: 50,
      usedCost: 2,
      percentOfBudget: 0.1,
      percentOfIncluded: 0.16,
      projectedOverage: null,
      pace: 'on-track',
    },
    forecast: {
      granularity: 'month',
      projectedCredits: 100,
      projectedCost: 4,
      low: 80,
      high: 120,
      basis: 'linear',
      asOf: Date.now(),
    },
    topModels: [],
    allModels: [],
    allSurfaces: [],
    allRepos: [],
    byRepo: [],
    sankeyLinks: [],
    chartData: { barChart: { labels: [], datasets: [] }, categoryBreakdown: { categories: [], costs: [], tokens: [] } },
    authStatus: 'signed-out',
    status: { kind: 'ok' },
    ...overrides,
  } as unknown as UsageSnapshot;
}

describe('buildRuleContext — null snapshot', () => {
  it('returns zeroes for numeric fields', () => {
    const ctx = buildRuleContext({ snapshot: null });
    assert.deepEqual(ctx['today'], { credits: 0, cost: 0, tokens: 0 });
    assert.equal((ctx['budget'] as Record<string, unknown>)['usedCredits'], 0);
    assert.equal((ctx['velocity'] as Record<string, unknown>)['creditsPerHour'], 0);
  });

  it('signedIn defaults to false', () => {
    const ctx = buildRuleContext({ snapshot: null });
    assert.equal(ctx['signedIn'], false);
  });

  it('billing is null when no githubBilling', () => {
    const ctx = buildRuleContext({ snapshot: minimalSnapshot() });
    assert.equal(ctx['billing'], null);
  });
});

describe('buildRuleContext — snapshot fields', () => {
  it('today populates from snapshot', () => {
    const ctx = buildRuleContext({ snapshot: minimalSnapshot() });
    assert.deepEqual(ctx['today'], { credits: 10, cost: 0.4, tokens: 500 });
  });

  it('month fields come from budget.usedCredits/usedCost', () => {
    const ctx = buildRuleContext({ snapshot: minimalSnapshot() });
    const month = ctx['month'] as Record<string, unknown>;
    assert.equal(month['credits'], 50);
    assert.equal(month['cost'], 2);
  });

  it('budget object is populated', () => {
    const ctx = buildRuleContext({ snapshot: minimalSnapshot() });
    const b = ctx['budget'] as Record<string, unknown>;
    assert.equal(b['monthly'], 20);
    assert.equal(b['percentOfBudget'], 0.1);
    assert.equal(b['pace'], 'on-track');
  });

  it('forecast fields are set', () => {
    const ctx = buildRuleContext({ snapshot: minimalSnapshot() });
    const f = ctx['forecast'] as Record<string, unknown>;
    assert.equal(f['projectedCredits'], 100);
    assert.equal(f['basis'], 'linear');
  });

  it('model map populated from topModels', () => {
    const snap = minimalSnapshot({
      topModels: [{ key: 'gpt-4o', credits: 30, cost: 1.2, tokens: 0 }] as unknown as UsageSnapshot['topModels'],
      allModels: ['gpt-4o'],
    });
    const ctx = buildRuleContext({ snapshot: snap });
    const model = ctx['model'] as Record<string, unknown>;
    assert.ok('gpt-4o' in model);
    assert.equal((model['gpt-4o'] as Record<string, number>)['credits'], 30);
  });

  it('repo map populated from byRepo', () => {
    const snap = minimalSnapshot({
      byRepo: [{ key: 'org/repo', credits: 15, cost: 0.6, tokens: 0 }] as unknown as UsageSnapshot['byRepo'],
      allRepos: ['org/repo'],
    });
    const ctx = buildRuleContext({ snapshot: snap });
    const repo = ctx['repo'] as Record<string, unknown>;
    assert.ok('org/repo' in repo);
  });

  it('vars are passed through from input', () => {
    const ctx = buildRuleContext({ snapshot: null, vars: { threshold: 100 } });
    assert.equal((ctx['vars'] as Record<string, unknown>)['threshold'], 100);
  });

  it('branchBudgets passed through', () => {
    const ctx = buildRuleContext({ snapshot: null, branchBudgets: { main: 50 } });
    assert.equal((ctx['branchBudgets'] as Record<string, unknown>)['main'], 50);
  });
});

describe('buildRuleContext — now fields', () => {
  it('now fields reflect the provided timestamp', () => {
    const ts = new Date(2026, 0, 5, 14, 30).getTime(); // Mon Jan 5 2026 14:30
    const ctx = buildRuleContext({ snapshot: null, now: ts });
    const now = ctx['now'] as Record<string, unknown>;
    assert.equal(now['ts'], ts);
    assert.equal(now['hour'], 14);
    assert.equal(now['minute'], 30);
    assert.ok(typeof now['iso'] === 'string');
    assert.ok(!isNaN(Date.parse(now['iso'] as string)));
  });
});

describe('buildRuleContext — velocity', () => {
  it('velocity > 0 from two history samples with positive delta', () => {
    const baseTs = Date.now() - 60_000;
    const history = [
      { ts: baseTs, todayCredits: 10 },
      { ts: baseTs + 60_000, todayCredits: 11 },
    ];
    const ctx = buildRuleContext({ snapshot: null, history });
    const vel = ctx['velocity'] as Record<string, unknown>;
    assert.ok((vel['creditsPerHour'] as number) > 0);
    assert.ok((vel['windowMinutes'] as number) > 0);
  });

  it('velocity is 0 with fewer than 2 history samples', () => {
    const ctx = buildRuleContext({ snapshot: null, history: [{ ts: Date.now(), todayCredits: 10 }] });
    const vel = ctx['velocity'] as Record<string, unknown>;
    assert.equal(vel['creditsPerHour'], 0);
  });

  it('velocity is 0 when delta is zero or negative', () => {
    const baseTs = Date.now() - 60_000;
    const history = [
      { ts: baseTs, todayCredits: 20 },
      { ts: baseTs + 60_000, todayCredits: 15 }, // decreased
    ];
    const ctx = buildRuleContext({ snapshot: null, history });
    const vel = ctx['velocity'] as Record<string, unknown>;
    assert.equal(vel['creditsPerHour'], 0);
  });
});

describe('buildRuleContext — billing quota edge cases', () => {
  it('quotaPercentRemaining is null when entitlement is 0', () => {
    const snap = minimalSnapshot({} as Partial<UsageSnapshot>);
    (snap as unknown as Record<string, unknown>)['githubBilling'] = {
      totalNetAmount: 0,
      items: [],
      quota: { used: 50, entitlement: 0, unlimited: false },
    };
    const ctx = buildRuleContext({ snapshot: snap });
    const billing = ctx['billing'] as Record<string, unknown>;
    assert.equal(billing['quotaPercentRemaining'], null);
  });
});

describe('buildRuleContext — billing', () => {
  it('billing is populated when githubBilling is present', () => {
    const snap = minimalSnapshot({} as Partial<UsageSnapshot>);
    (snap as unknown as Record<string, unknown>)['githubBilling'] = {
      totalNetAmount: 5,
      items: [{ grossAmount: 6 }],
      quota: { used: 100, entitlement: 500, unlimited: false },
    };
    const ctx = buildRuleContext({ snapshot: snap });
    const billing = ctx['billing'] as Record<string, unknown>;
    assert.ok(billing !== null);
    assert.equal(billing['netAmount'], 5);
    assert.ok(Math.abs((billing['quotaPercentRemaining'] as number) - 0.8) < 0.001);
    assert.equal(billing['unlimited'], false);
  });

  it('quotaPercentRemaining is null when quota is null', () => {
    const snap = minimalSnapshot({} as Partial<UsageSnapshot>);
    (snap as unknown as Record<string, unknown>)['githubBilling'] = {
      totalNetAmount: 0,
      items: [],
      quota: null,
    };
    const ctx = buildRuleContext({ snapshot: snap });
    const billing = ctx['billing'] as Record<string, unknown>;
    assert.equal(billing['quotaPercentRemaining'], null);
  });
});

describe('buildRuleContext — surface, model fallback, repo fallback branches', () => {
  it('covers topSurface TRUE branch, model fallback, surface map, and repo fallback', () => {
    const snap = minimalSnapshot({
      allSurfaces: ['chat', 'inline'] as unknown as UsageSnapshot['allSurfaces'],
      topModels: [{ key: 'gpt-4o', credits: 30, cost: 1.2, tokens: 0 }] as unknown as UsageSnapshot['topModels'],
      allModels: ['gpt-4o', 'claude-sonnet-4'] as unknown as UsageSnapshot['allModels'],
      byRepo: [{ key: 'org/a', credits: 10, cost: 0.4, tokens: 0 }] as unknown as UsageSnapshot['byRepo'],
      allRepos: ['org/a', 'org/b'] as unknown as UsageSnapshot['allRepos'],
    });
    const ctx = buildRuleContext({ snapshot: snap });
    // topSurface TRUE branch (allSurfaces[0] exists)
    assert.ok(ctx['topSurface'] !== null);
    // model fallback branch (claude-sonnet-4 not in topModels → gets credits: 0)
    const model = ctx['model'] as Record<string, Record<string, number>>;
    assert.ok('claude-sonnet-4' in model);
    assert.equal(model['claude-sonnet-4']!['credits'], 0);
    // surface map (allSurfaces is non-empty)
    const surface = ctx['surface'] as Record<string, unknown>;
    assert.ok('chat' in surface);
    assert.ok('inline' in surface);
    // repo fallback branch (org/b not in byRepo → gets credits: 0)
    const repo = ctx['repo'] as Record<string, Record<string, number>>;
    assert.ok('org/b' in repo);
    assert.equal(repo['org/b']!['credits'], 0);
  });
});

describe('buildRuleContext — window7d and month.tokens', () => {
  // Wednesday 2026-03-18, midday local time.
  const now = new Date(2026, 2, 18, 12, 0).getTime();
  const dayStart = (daysAgo: number) => new Date(2026, 2, 18 - daysAgo).getTime();
  const agg = (daysAgo: number, credits: number, cost: number, tokens: number) =>
    ({ start: dayStart(daysAgo), credits, cost, tokens }) as unknown as UsageAggregate;

  function withAggregates(dayAggregates: UsageAggregate[]): UsageSnapshot {
    return minimalSnapshot({ chartInputs: { dayAggregates } } as unknown as Partial<UsageSnapshot>);
  }

  it('sums the last 7 calendar days (today + 6) from the snapshot day aggregates', () => {
    const snap = withAggregates([
      agg(8, 1000, 1000, 1000), // outside the window
      agg(6, 1, 0.1, 10), // oldest day inside
      agg(3, 2, 0.2, 20),
      agg(0, 4, 0.4, 40), // today
    ]);
    const w = buildRuleContext({ snapshot: snap, now })['window7d'] as Record<string, number>;
    assert.equal(w['credits'], 7);
    assert.ok(Math.abs(w['cost']! - 0.7) < 1e-9);
    assert.equal(w['tokens'], 70);
  });

  it('REGRESSION: window7d is no longer a copy of today', () => {
    const snap = withAggregates([agg(1, 30, 1, 300), agg(0, 10, 0.4, 500)]);
    const ctx = buildRuleContext({ snapshot: snap, now });
    assert.deepEqual(ctx['today'], { credits: 10, cost: 0.4, tokens: 500 });
    assert.equal((ctx['window7d'] as Record<string, number>)['credits'], 40);
  });

  it('falls back to the composed dailyBars/tokensDaily chart data (wire snapshot)', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ date: '', credits: i < 23 ? 100 : 1, cost: i < 23 ? 9 : 0.5, colorIndex: 0 }));
    const tokens = Array.from({ length: 30 }, (_, i) => (i < 23 ? 9999 : 2));
    const snap = minimalSnapshot({
      chartData: { dailyBars: { points }, tokensDaily: { tokens } },
    } as unknown as Partial<UsageSnapshot>);
    const w = buildRuleContext({ snapshot: snap, now })['window7d'] as Record<string, number>;
    assert.equal(w['credits'], 7);
    assert.equal(w['cost'], 3.5);
    assert.equal(w['tokens'], 14);
  });

  it('is absent (not a fake zero) when the snapshot has no day-level data; zeros only for no snapshot', () => {
    assert.equal(buildRuleContext({ snapshot: minimalSnapshot(), now })['window7d'], null);
    assert.deepEqual(buildRuleContext({ snapshot: null, now })['window7d'], { credits: 0, cost: 0, tokens: 0 });
    // A var path into it simply does not resolve.
    assert.equal(resolveVar('window7d.credits', buildRuleContext({ snapshot: minimalSnapshot(), now })), undefined);
  });

  it('month.tokens sums this calendar month only; absent without day-level data', () => {
    const snap = withAggregates([
      { start: new Date(2026, 1, 28).getTime(), credits: 1, cost: 1, tokens: 5000 } as unknown as UsageAggregate, // Feb
      { start: new Date(2026, 2, 1).getTime(), credits: 1, cost: 1, tokens: 100 } as unknown as UsageAggregate,
      agg(0, 1, 1, 23),
    ]);
    const month = buildRuleContext({ snapshot: snap, now })['month'] as Record<string, number>;
    assert.equal(month['tokens'], 123);
    assert.equal(month['credits'], 50, 'credits still come from the budget');
    const bare = buildRuleContext({ snapshot: minimalSnapshot(), now })['month'] as Record<string, unknown>;
    assert.equal('tokens' in bare, false);
  });
});

describe('buildRuleContext — surfaces, tokens and key safety', () => {
  it('topSurface and surface.<id>.credits come from the model → surface links', () => {
    const snap = minimalSnapshot({
      allSurfaces: ['chat', 'inline', 'agent'] as unknown as UsageSnapshot['allSurfaces'],
      sankeyLinks: [
        { source: 'gpt-4o', target: 'chat', value: 5 },
        { source: 'claude', target: 'chat', value: 7 },
        { source: 'gpt-4o', target: 'agent', value: 20 },
      ] as unknown as UsageSnapshot['sankeyLinks'],
    });
    const ctx = buildRuleContext({ snapshot: snap });
    const surface = ctx['surface'] as Record<string, Record<string, number>>;
    assert.equal(surface['chat']!['credits'], 12);
    assert.equal(surface['agent']!['credits'], 20);
    assert.equal(surface['inline']!['credits'], 0);
    assert.deepEqual(ctx['topSurface'], { id: 'agent', credits: 20 });
  });

  it('model/repo entries carry the real token counts', () => {
    const snap = minimalSnapshot({
      topModels: [{ key: 'gpt-4o', credits: 30, cost: 1.2, tokens: 4200 }] as unknown as UsageSnapshot['topModels'],
      byRepo: [{ key: 'org/a', credits: 10, cost: 0.4, tokens: 900 }] as unknown as UsageSnapshot['byRepo'],
    });
    const ctx = buildRuleContext({ snapshot: snap });
    assert.equal((ctx['model'] as Record<string, Record<string, number>>)['gpt-4o']!['tokens'], 4200);
    assert.equal((ctx['repo'] as Record<string, Record<string, number>>)['org/a']!['tokens'], 900);
  });

  it('REGRESSION: dotted model/repo keys are reachable through bracket paths', () => {
    const snap = minimalSnapshot({
      topModels: [{ key: 'gpt-4.1', credits: 12, cost: 1, tokens: 1 }] as unknown as UsageSnapshot['topModels'],
      byRepo: [{ key: 'foo.js', credits: 3, cost: 1, tokens: 1 }] as unknown as UsageSnapshot['byRepo'],
    });
    const ctx = buildRuleContext({ snapshot: snap });
    assert.equal(resolveVar('model["gpt-4.1"].credits', ctx), 12);
    assert.equal(resolveVar("repo['foo.js'].credits", ctx), 3);
  });

  it('REGRESSION: a "__proto__" key is plain data and cannot touch the prototype', () => {
    const snap = minimalSnapshot({
      topModels: [{ key: '__proto__', credits: 9, cost: 1, tokens: 1 }] as unknown as UsageSnapshot['topModels'],
    });
    const ctx = buildRuleContext({
      snapshot: snap,
      vars: JSON.parse('{"__proto__": 5, "constructor": 6}') as Record<string, unknown>,
    });
    const model = ctx['model'] as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(model), null);
    assert.equal(resolveVar('model["__proto__"].credits', ctx), 9);
    assert.equal(({} as Record<string, unknown>)['credits'], undefined, 'Object.prototype is untouched');
    assert.equal(resolveVar('vars["__proto__"]', ctx), 5);
    assert.equal(resolveVar('constructor', ctx), undefined);
    assert.equal(resolveVar('model.constructor', ctx), undefined);
    assert.equal(resolveVar('vars.hasOwnProperty', ctx), undefined);
  });

  it('exposes alert groups as ctx.group.<id> so restrictions see them too', () => {
    const ctx = buildRuleContext({
      snapshot: null,
      groups: [{ id: 'on', active: true }, { id: 'off', active: false }],
    });
    assert.equal(resolveVar('group.on', ctx), true);
    assert.equal(resolveVar('group.off', ctx), false);
  });
});

describe('buildRuleContext — velocity over the history window', () => {
  const H = 3_600_000;
  const base = new Date(2026, 2, 18, 9, 0).getTime();
  const velocity = (history: HistorySample[], extra: Partial<UsageSnapshot> = {}) =>
    buildRuleContext({ snapshot: minimalSnapshot(extra), history })['velocity'] as Record<string, number>;

  it('fits a least-squares rate instead of using only the two endpoints', () => {
    // Endpoints alone say (30-0)/2h = 15/h; the fit through all four samples (an early burst
    // that then flattens) is 12.74/h.
    const v = velocity([
      { ts: base, todayCredits: 0 },
      { ts: base + 0.5 * H, todayCredits: 25 },
      { ts: base + 1 * H, todayCredits: 28 },
      { ts: base + 2 * H, todayCredits: 30 },
    ]);
    assert.ok(Math.abs(v['creditsPerHour']! - 12.74) < 0.01, String(v['creditsPerHour']));
    assert.equal(v['windowMinutes'], 120);
  });

  it('a steady stream recovers its exact rate', () => {
    const v = velocity([0, 1, 2, 3].map((i) => ({ ts: base + i * 0.25 * H, todayCredits: 10 + i * 5 })));
    assert.ok(Math.abs(v['creditsPerHour']! - 20) < 1e-9);
    assert.equal(v['windowMinutes'], 45);
  });

  it('REGRESSION: a counter reset (midnight / recompute) restarts the window instead of zeroing the rate', () => {
    // Yesterday's total (200) falls to 0 at midnight, then climbs 10 credits per 30 minutes.
    const v = velocity([
      { ts: base - 2 * H, todayCredits: 190 },
      { ts: base - 1 * H, todayCredits: 200 },
      { ts: base, todayCredits: 0 },
      { ts: base + 0.5 * H, todayCredits: 10 },
      { ts: base + 1 * H, todayCredits: 20 },
    ]);
    assert.ok(Math.abs(v['creditsPerHour']! - 20) < 1e-9);
    assert.equal(v['windowMinutes'], 60);
  });

  it('is zero right after a reset (a single post-reset sample is not a rate)', () => {
    const v = velocity([
      { ts: base - H, todayCredits: 200 },
      { ts: base, todayCredits: 0 },
    ]);
    assert.equal(v['creditsPerHour'], 0);
    assert.equal(v['windowMinutes'], 0);
  });

  it('REGRESSION: costPerHour is the credit rate priced at the snapshot price, not a hard 0', () => {
    const v = velocity(
      [
        { ts: base, todayCredits: 0 },
        { ts: base + H, todayCredits: 10 },
      ],
      { pricePerCredit: 0.04 },
    );
    assert.ok(Math.abs(v['creditsPerHour']! - 10) < 1e-9);
    assert.ok(Math.abs(v['costPerHour']! - 0.4) < 1e-9);
  });

  it('flat history is a rate of 0 over a real window', () => {
    const v = velocity([
      { ts: base, todayCredits: 5 },
      { ts: base + H, todayCredits: 5 },
    ]);
    assert.equal(v['creditsPerHour'], 0);
    assert.equal(v['windowMinutes'], 60);
  });

  it('identical timestamps give no rate', () => {
    const v = velocity([
      { ts: base, todayCredits: 1 },
      { ts: base, todayCredits: 2 },
    ]);
    assert.equal(v['creditsPerHour'], 0);
  });
});
