import { strict as assert } from 'assert';
import type { AggregateGroup, PricingSnapshot, RawEvent } from '../../src/extension-backend/domain/contracts';
import { aggregateBy } from '../../src/extension-backend/domain/aggregate';
import { buildHourlyTimelineData, buildWeekdayTotals } from '../../src/extension-backend/domain/chartData';
import { priceUsage } from '../../src/extension-backend/domain/pricing';
import { buildSnapshotSource } from '../../src/extension-backend/domain/snapshotSource';
import type { SnapshotGroups, SnapshotSourceData } from '../../src/extension-backend/domain/snapshotSource';
import type { UsageEvent } from '../../src/extension-backend/domain/types';
import { startOf } from '../../src/extension-backend/util/time';
import { groupEvents } from '../golden/groupEvents';
import { GOLDEN_TZS, withTzSync } from '../golden/support/time';

const PPC = 0.04;

const PRICING: PricingSnapshot = {
  manifest: {
    version: 1,
    pricePerCredit: PPC,
    updatedAt: '2026-01-01T00:00:00Z',
    models: { 'gpt-4o': 1, 'gpt-4.1': 0, 'claude-sonnet-4-5': 6, unknown: 1 },
  },
  tokenPrices: {
    'gpt-4o': { input: 1e-6, output: 2e-6 },
    'claude-sonnet-4.5': { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
  },
  pricePerCredit: PPC,
  version: 'test',
};

const T = (iso: string): number => Date.parse(iso);

function group(partial: Partial<AggregateGroup> = {}): AggregateGroup {
  return {
    bucketStartMs: T('2026-03-15T10:00:00Z'),
    modelId: 'gpt-4o',
    surface: 'chat',
    source: 'local',
    repo: null,
    branch: null,
    language: null,
    attribution: null,
    tokensKnown: false,
    requests: 1,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    ...partial,
  };
}

const NOW = T('2026-03-15T12:00:00Z');

function build(groups: AggregateGroup[], opts: { now?: number; tz?: string; dimGroups?: AggregateGroup[]; pricing?: PricingSnapshot } = {}): SnapshotSourceData {
  const input: SnapshotGroups = opts.dimGroups ? { groups, dimGroups: opts.dimGroups } : { groups };
  return withTzSync(opts.tz ?? 'UTC', () => buildSnapshotSource(input, opts.now ?? NOW, opts.pricing ?? PRICING));
}

function near(actual: number, expected: number, msg = ''): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(actual), Math.abs(expected)) + 1e-15, `${msg} ${actual} vs ${expected}`);
}

describe('buildSnapshotSource — shape and totals', () => {
  it('an empty read is all zeros and empty lists', () => {
    const d = build([]);
    const zero = { credits: 0, cost: 0, tokens: 0, eventCount: 0 };
    assert.deepEqual(d.totals, { all: zero, mtd: zero, today: zero });
    assert.equal(d.estimatedEventCount, 0);
    assert.deepEqual([d.daily, d.models, d.repos, d.languages, d.hourly, d.categories, d.sankey], [[], [], [], [], [], [], []]);
    assert.deepEqual(d.dims, { models: [], surfaces: [], sources: [], repos: [] });
    assert.deepEqual(d.weekday, [0, 0, 0, 0, 0, 0, 0]);
  });

  it('today and month-to-date are local-calendar windows of the injected clock, edges included/excluded', () => {
    // now = Sunday 2026-03-15 12:00 UTC: month [Mar 1, Apr 1), day [Mar 15, Mar 16).
    const at = (iso: string): AggregateGroup => group({ bucketStartMs: T(iso) });
    const d = build([
      at('2026-02-28T23:45:00Z'), // before the month
      at('2026-03-01T00:00:00Z'), // first bucket of the month
      at('2026-03-15T00:00:00Z'), // first bucket of today
      at('2026-03-15T23:45:00Z'), // last bucket of today
      at('2026-03-16T00:00:00Z'), // tomorrow: still this month
      at('2026-04-01T00:00:00Z'), // next month
    ]);
    assert.equal(d.totals.all.eventCount, 6);
    assert.equal(d.totals.mtd.eventCount, 4);
    assert.equal(d.totals.today.eventCount, 2);
    assert.equal(d.totals.today.credits, 2);
  });

  it('"today" follows the zone: the same UTC instant is a different local day in Auckland', () => {
    // now is Sunday 12:00 UTC = Monday 01:00 in Auckland (UTC+13 in March); 00:00Z Monday is 13:00 there, i.e. today.
    const g = [group({ bucketStartMs: T('2026-03-16T00:00:00Z') })];
    assert.equal(build(g, { tz: 'UTC' }).totals.today.eventCount, 0);
    assert.equal(build(g, { tz: 'Pacific/Auckland' }).totals.today.eventCount, 1);
  });

  it('counts requests, not groups, and reports every counted row as estimated', () => {
    const d = build([group({ requests: 3 }), group({ requests: 2, modelId: 'gpt-4.1' })]);
    assert.equal(d.totals.all.eventCount, 5);
    assert.equal(d.estimatedEventCount, 5);
    assert.equal(d.daily[0]!.eventCount, 5);
    assert.equal(d.totals.all.credits, 3); // 3 x 1 + 2 x 0
  });

  it('tokens are prompt + completion only; cache and thinking tokens are priced but not counted', () => {
    const d = build([
      group({
        modelId: 'claude-sonnet-4-5-20250929', source: 'claude-code', tokensKnown: true,
        promptTokens: 100, completionTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 200, thinkingTokens: 30,
      }),
    ]);
    assert.equal(d.totals.all.tokens, 150);
    assert.equal(d.models[0]!.tokens, 150);
    near(d.totals.all.cost, 100 * 3e-6 + 50 * 15e-6 + 1000 * 3e-7 + 200 * 3.75e-6 + 30 * 15e-6);
  });

  it('is priced at read time: a new snapshot re-prices the same groups (D1)', () => {
    const groups = [group({ tokensKnown: true, promptTokens: 1000, completionTokens: 100, requests: 2 })];
    const before = build(groups);
    const after = build(groups, {
      pricing: { ...PRICING, manifest: { ...PRICING.manifest, models: { ...PRICING.manifest.models, 'gpt-4o': 3 } }, tokenPrices: undefined, version: 'v2' },
    });
    near(before.totals.all.credits, 2);
    near(before.totals.all.cost, 1000 * 1e-6 + 100 * 2e-6);
    near(after.totals.all.credits, 6);
    near(after.totals.all.cost, 6 * PPC);
  });
});

describe('buildSnapshotSource — dimensions and ranked lists', () => {
  it('a null repo is unattributed (merged with a literal "unattributed"), a null language is unknown', () => {
    const d = build([
      group({ repo: null, language: null }),
      group({ repo: 'unattributed', language: 'unknown' }),
      group({ repo: 'alpha', language: 'ts', branch: 'main' }),
    ]);
    assert.deepEqual(d.repos.map((r) => [r.repo, r.credits]), [['unattributed', 2], ['alpha', 1]]);
    assert.deepEqual(d.languages.map((l) => [l.language, l.credits]), [['unknown', 2], ['ts', 1]]);
    assert.deepEqual(d.dims.repos, ['alpha', 'unattributed']);
  });

  it('ranks by credits, highest first, and orders equal credits by name', () => {
    const d = build([
      group({ modelId: 'gpt-4o', repo: 'b' }),
      group({ modelId: 'zzz-model', repo: 'a' }),
      group({ modelId: 'aaa-model', repo: 'c', requests: 2 }),
    ]);
    assert.deepEqual(d.models.map((m) => m.modelId), ['aaa-model', 'gpt-4o', 'zzz-model']);
    assert.deepEqual(d.repos.map((r) => r.repo), ['c', 'a', 'b']);
  });

  it('heuristicShare is the cost share of heuristically attributed rows, 0 when the repo cost nothing', () => {
    const tokens = { tokensKnown: true, completionTokens: 1000 } as const;
    const d = build([
      group({ repo: 'mixed', attribution: 'heuristic', ...tokens }), // 1000 x 2e-6 = 0.002
      group({ repo: 'mixed', attribution: 'authoritative', completionTokens: 3000, tokensKnown: true }), // 0.006
      group({ repo: 'mixed', attribution: null, ...tokens }), // 0.002
      group({ repo: 'free', attribution: 'heuristic', modelId: 'gpt-4.1' }), // credits 0, cost 0
    ]);
    const mixed = d.repos.find((r) => r.repo === 'mixed')!;
    near(mixed.cost, 0.01);
    near(mixed.heuristicShare, 0.2);
    assert.equal(d.repos.find((r) => r.repo === 'free')!.heuristicShare, 0);
  });

  it('sankey keeps model/surface pairs with credits above 0, counts their requests, and sorts by model then surface', () => {
    const d = build([
      group({ modelId: 'gpt-4o', surface: 'chat', requests: 2 }),
      group({ modelId: 'gpt-4o', surface: 'chat', requests: 1, repo: 'x' }),
      group({ modelId: 'gpt-4o', surface: 'agent' }),
      group({ modelId: 'gpt-4.1', surface: 'chat', requests: 9 }), // free: no link
      group({ modelId: 'claude-sonnet-4-5-20250929', source: 'claude-code', surface: 'agent', promptTokens: 1, tokensKnown: true }),
    ]);
    assert.deepEqual(d.sankey, [
      { model: 'claude-sonnet-4-5-20250929', surface: 'agent', count: 1, credits: 6 },
      { model: 'gpt-4o', surface: 'agent', count: 1, credits: 1 },
      { model: 'gpt-4o', surface: 'chat', count: 3, credits: 3 },
    ]);
    assert.equal(d.models.length, 3, 'a free model still ranks');
  });

  it('dims come from dimGroups (the range-only read) when given, else from the groups', () => {
    const shown = [group({ modelId: 'gpt-4o', surface: 'chat', source: 'local', repo: 'a' })];
    const inRange = [
      ...shown,
      group({ modelId: 'gpt-4.1', surface: 'agent', source: 'claude-code', repo: null }),
    ];
    const filtered = build(shown, { dimGroups: inRange });
    assert.deepEqual(filtered.dims, { models: ['gpt-4.1', 'gpt-4o'], surfaces: ['agent', 'chat'], sources: ['claude-code', 'local'], repos: ['a', 'unattributed'] });
    assert.equal(filtered.models.length, 1, 'the ranked lists still follow the filter');

    assert.deepEqual(build(shown).dims, { models: ['gpt-4o'], surfaces: ['chat'], sources: ['local'], repos: ['a'] });
    assert.deepEqual(build(shown, { dimGroups: [] }).dims, { models: [], surfaces: [], sources: [], repos: [] });
  });
});

describe('buildSnapshotSource — categories', () => {
  it('keeps only categories with cost above 0, in the fixed category order, and splits them per day', () => {
    const d = build([
      group({
        modelId: 'claude-sonnet-4-5-20250929', source: 'claude-code', tokensKnown: true,
        promptTokens: 100, completionTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 50,
        bucketStartMs: T('2026-03-14T10:00:00Z'),
      }),
      group({ modelId: 'gpt-4o', tokensKnown: true, promptTokens: 10, completionTokens: 10, bucketStartMs: T('2026-03-15T10:00:00Z') }),
    ]);
    assert.deepEqual(d.categories.map((c) => c.category), ['input', 'output', 'cache_creation', 'cache_read']);
    near(d.categories[0]!.cost, 100 * 3e-6 + 10 * 1e-6);
    near(d.categories[3]!.cost, 1000 * 3e-7);
    assert.equal(d.daily.length, 2);
    near(d.daily[0]!.catCacheRead, 1000 * 3e-7);
    near(d.daily[0]!.catCacheCreation, 50 * 3.75e-6);
    assert.equal(d.daily[0]!.catThinking, 0);
    assert.equal(d.daily[0]!.catTool, 0);
    assert.equal(d.daily[1]!.catCacheRead, 0);
    near(d.daily[1]!.catOutput, 10 * 2e-6);
  });

  it('thinking tokens show up as their own category', () => {
    const d = build([group({ modelId: 'claude-sonnet-4-5-20250929', source: 'claude-code', thinkingTokens: 100 })]);
    assert.deepEqual(d.categories.map((c) => c.category), ['thinking']);
    near(d.daily[0]!.catThinking, 100 * 15e-6);
  });

  it('rows without a cost (free credits, model with no price) add no category', () => {
    const d = build([
      group({ modelId: 'gpt-4.1' }),
      group({ modelId: 'claude-fable-9', source: 'claude-code', promptTokens: 500, tokensKnown: true }),
    ]);
    assert.deepEqual(d.categories, []);
    assert.equal(d.totals.all.cost, 0);
  });
});

describe('buildSnapshotSource — local time', () => {
  it('hourly lists only hours that have rows (a zero-credit row still counts) and weekday 0 is Sunday', () => {
    const d = build([
      group({ bucketStartMs: T('2026-03-15T03:00:00Z') }), // Sunday 03:00
      group({ bucketStartMs: T('2026-03-15T03:45:00Z'), requests: 2 }), // same hour
      group({ bucketStartMs: T('2026-03-15T09:15:00Z'), modelId: 'gpt-4.1' }), // free: present, 0 credits
      group({ bucketStartMs: T('2026-03-17T23:45:00Z') }), // Tuesday
    ]);
    assert.deepEqual(d.hourly, [{ hourLocal: 3, credits: 3 }, { hourLocal: 9, credits: 0 }, { hourLocal: 23, credits: 1 }]);
    assert.deepEqual(d.weekday, [3, 0, 1, 0, 0, 0, 0]);
  });

  it('daily rows are local midnights in ascending order, whatever the input order', () => {
    const d = build([
      group({ bucketStartMs: T('2026-03-15T01:00:00Z') }),
      group({ bucketStartMs: T('2026-03-13T01:00:00Z') }),
      group({ bucketStartMs: T('2026-03-14T01:00:00Z') }),
      group({ bucketStartMs: T('2026-03-13T22:00:00Z') }),
    ]);
    assert.deepEqual(d.daily.map((x) => x.dayStart), [T('2026-03-13T00:00:00Z'), T('2026-03-14T00:00:00Z'), T('2026-03-15T00:00:00Z')]);
    assert.equal(d.daily[0]!.eventCount, 2);
  });

  it('fall-back day (Los Angeles, 25 hours): the repeated hour is one hour bucket, and the day stays one row', () => {
    const d = build(
      [
        group({ bucketStartMs: T('2026-11-01T08:15:00Z') }), // 01:15 PDT
        group({ bucketStartMs: T('2026-11-01T09:15:00Z') }), // 01:15 PST, the same wall time again
        group({ bucketStartMs: T('2026-11-02T07:45:00Z') }), // 23:45 PST: still Nov 1
        group({ bucketStartMs: T('2026-11-02T08:00:00Z') }), // 00:00 PST Nov 2
      ],
      { tz: 'America/Los_Angeles', now: T('2026-11-02T20:00:00Z') },
    );
    assert.deepEqual(d.hourly, [{ hourLocal: 0, credits: 1 }, { hourLocal: 1, credits: 2 }, { hourLocal: 23, credits: 1 }]);
    assert.deepEqual(d.daily.map((x) => [x.dayStart, x.eventCount]), [[T('2026-11-01T07:00:00Z'), 3], [T('2026-11-02T08:00:00Z'), 1]]);
    assert.equal(d.totals.today.eventCount, 1);
    assert.equal(d.totals.mtd.eventCount, 4);
  });

  it('spring-forward day (Los Angeles, 23 hours): no hour 2, and the day starts at the right midnight', () => {
    const d = build(
      [
        group({ bucketStartMs: T('2026-03-08T09:45:00Z') }), // 01:45 PST
        group({ bucketStartMs: T('2026-03-08T10:00:00Z') }), // 03:00 PDT
      ],
      { tz: 'America/Los_Angeles', now: T('2026-03-08T20:00:00Z') },
    );
    assert.deepEqual(d.hourly.map((h) => h.hourLocal), [1, 3]);
    assert.deepEqual(d.daily.map((x) => x.dayStart), [T('2026-03-08T08:00:00Z')]);
  });

  it('half-hour and 45-minute zones: a 15-minute bucket never straddles a local hour or day', () => {
    const kolkata = build(
      [group({ bucketStartMs: T('2026-03-14T18:15:00Z') }), group({ bucketStartMs: T('2026-03-14T18:30:00Z') })],
      { tz: 'Asia/Kolkata', now: T('2026-03-15T12:00:00Z') },
    ); // 23:45 on the 14th, then 00:00 on the 15th
    assert.deepEqual(kolkata.hourly.map((h) => h.hourLocal), [0, 23]);
    assert.deepEqual(kolkata.daily.map((x) => x.dayStart), [T('2026-03-13T18:30:00Z'), T('2026-03-14T18:30:00Z')]);
    assert.equal(kolkata.totals.today.eventCount, 1);

    const chatham = build(
      [group({ bucketStartMs: T('2026-03-14T10:00:00Z') }), group({ bucketStartMs: T('2026-03-14T11:00:00Z') })],
      { tz: 'Pacific/Chatham', now: T('2026-03-15T00:00:00Z') },
    ); // UTC+13:45 in March
    assert.deepEqual(chatham.hourly.map((h) => h.hourLocal), [0, 23]);
  });
});

describe('buildSnapshotSource — pre-aggregation is exact', () => {
  /** Deterministic pseudo-random events over a year, every source, with and without tokens. */
  function randomEvents(n: number, seed: number): RawEvent[] {
    let s = seed;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const models = ['gpt-4o', 'gpt-4.1', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'mystery-model-x'];
    const out: RawEvent[] = [];
    for (let i = 0; i < n; i++) {
      const modelId = pick(models);
      const claude = modelId.startsWith('claude');
      // A credit-priced row with tokens splits its cost by token ratio, which is not linear (INTENDED_DIFFERENCES D4):
      // the unknown model gets no tokens here so that every number is exactly linear in the grouping.
      const withTokens = claude || (modelId !== 'mystery-model-x' && rnd() < 0.7);
      out.push({
        id: `e${i}`,
        // Clustered into few buckets so groups really merge, over a year so DST changes are crossed.
        ts: T('2025-11-01T00:00:00Z') + Math.floor(rnd() * 40) * 9 * 86_400_000 + Math.floor(rnd() * 900_000),
        modelId, surface: pick(['chat', 'agent'] as const), source: claude ? 'claude-code' : 'local',
        repo: pick(['alpha', 'beta', null]), branch: null, language: pick(['ts', null]),
        attribution: pick(['heuristic', 'authoritative'] as const),
        requests: 1,
        promptTokens: withTokens ? 1 + Math.floor(rnd() * 4000) : null,
        completionTokens: withTokens ? 1 + Math.floor(rnd() * 800) : null,
        cacheReadTokens: claude ? Math.floor(rnd() * 5000) : 0,
        cacheCreationTokens: claude ? Math.floor(rnd() * 300) : 0,
        thinkingTokens: claude && rnd() < 0.3 ? Math.floor(rnd() * 100) : 0,
      });
    }
    return out;
  }

  function assertSame(a: SnapshotSourceData, b: SnapshotSourceData, path = '$'): void {
    if (typeof a === 'number' && typeof b === 'number') near(a, b, path);
    else if (Array.isArray(a) && Array.isArray(b)) {
      assert.equal(a.length, b.length, path);
      a.forEach((x, i) => assertSame(x, b[i], `${path}[${i}]`));
    } else if (a !== null && typeof a === 'object' && b !== null && typeof b === 'object') {
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b as object).sort(), path);
      for (const k of Object.keys(a)) assertSame((a as never)[k], (b as never)[k], `${path}.${k}`);
    } else assert.equal(a, b, path);
  }

  const events = randomEvents(600, 7);
  const singleton = (e: RawEvent): AggregateGroup => groupEvents([e])[0]!;

  for (const tz of GOLDEN_TZS) {
    it(`${tz}: grouping events by 15-minute bucket and dimensions changes nothing but float noise`, () => {
      const now = T('2026-02-10T12:00:00Z');
      const grouped = groupEvents(events);
      assert.ok(grouped.length < events.length, 'the events really merge');
      assertSame(build(grouped, { tz, now }), build(events.map(singleton), { tz, now }));
    });

    it(`${tz}: hourly, weekday and daily agree with the per-event chart builders`, () => {
      const now = T('2026-02-10T12:00:00Z');
      const grouped = groupEvents(events);
      const d = build(grouped, { tz, now });
      const priced: UsageEvent[] = events.map((e) => {
        const p = priceUsage(e, PRICING);
        return { id: e.id, ts: e.ts, modelId: e.modelId, surface: e.surface, source: e.source, credits: p.credits, cost: p.cost, estimated: true,
          ...(e.promptTokens !== null ? { promptTokens: e.promptTokens } : {}), ...(e.completionTokens !== null ? { completionTokens: e.completionTokens } : {}) };
      });
      withTzSync(tz, () => {
        const hours = buildHourlyTimelineData(priced).hours;
        for (const h of d.hourly) near(h.credits, hours[h.hourLocal]!, `hour ${h.hourLocal}`);
        near(d.hourly.reduce((a, h) => a + h.credits, 0), hours.reduce((a, c) => a + c, 0));
        const weekday = buildWeekdayTotals(priced);
        weekday.forEach((c, i) => near(d.weekday[i]!, c, `weekday ${i}`));
        const days = aggregateBy(priced, 'day');
        assert.deepEqual(d.daily.map((x) => x.dayStart), days.map((x) => x.start));
        d.daily.forEach((x, i) => {
          near(x.credits, days[i]!.credits);
          near(x.cost, days[i]!.cost);
          assert.equal(x.tokens, days[i]!.tokens);
          assert.equal(x.eventCount, days[i]!.eventCount);
          assert.equal(x.dayStart, startOf(days[i]!.start, 'day'));
        });
      });
    });
  }
});
