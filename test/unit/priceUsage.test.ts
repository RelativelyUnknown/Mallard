import { strict as assert } from 'assert';
import type { AggregateGroup, PricingSnapshot, RawEvent } from '../../src/extension-backend/domain/contracts';
import {
  CLAUDE_FALLBACK_TOKEN_PRICES,
  createPricer,
  hasKnownTokens,
  priceUsage,
} from '../../src/extension-backend/domain/pricing';
import type { PricedUsage } from '../../src/extension-backend/domain/pricing';

const PPC = 0.04;

const SNAPSHOT: PricingSnapshot = {
  manifest: {
    version: 1,
    pricePerCredit: PPC,
    updatedAt: '2026-01-01T00:00:00Z',
    models: { 'gpt-4o': 0.33, 'gpt-4.1': 0, 'gpt-5-mini': 0.33, 'claude-sonnet-4-5': 6, 'claude-opus-4-5': 15, unknown: 2 },
  },
  tokenPrices: {
    'gpt-4o': { input: 2.5e-6, output: 1e-5 },
    'gpt-4.1': { input: 2e-6, output: 8e-6 },
    'gpt-5-mini': { input: 2.5e-7, output: 2e-6, thinking: 4e-6 },
    'claude-sonnet-4.5': { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
  },
  pricePerCredit: PPC,
  version: 'test',
};

const NO_FEED: PricingSnapshot = { ...SNAPSHOT, tokenPrices: undefined };

function usage(partial: Partial<PricedUsage> = {}): PricedUsage {
  return {
    source: 'local',
    modelId: 'gpt-4o',
    requests: 1,
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    ...partial,
  };
}

const claude = (partial: Partial<PricedUsage> = {}): PricedUsage =>
  usage({ source: 'claude-code', modelId: 'claude-sonnet-4-5-20250929', ...partial });

function near(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${msg ?? ''} ${actual} vs ${expected}`);
}

describe('hasKnownTokens — the rule behind token price vs credit price', () => {
  const rule = (tokensKnown: boolean | undefined, promptTokens: number | null, completionTokens: number | null): boolean =>
    hasKnownTokens({ ...(tokensKnown === undefined ? {} : { tokensKnown }), promptTokens, completionTokens });

  it('a row is known when either count is not null, and a count of 0 is known', () => {
    assert.equal(rule(undefined, null, null), false);
    assert.equal(rule(undefined, 0, null), true);
    assert.equal(rule(undefined, null, 0), true);
    assert.equal(rule(undefined, 10, 20), true);
  });

  it('an explicit tokensKnown (the aggregation key) wins over the counts', () => {
    assert.equal(rule(false, 10, 20), false);
    assert.equal(rule(true, null, null), true);
  });
});

describe('priceUsage — Copilot', () => {
  it('prices by token when the feed knows the model: credits are the multiplier, cost is per-token', () => {
    const r = priceUsage(usage({ promptTokens: 1000, completionTokens: 200 }), SNAPSHOT);
    assert.equal(r.credits, 0.33);
    near(r.cost, 1000 * 2.5e-6 + 200 * 1e-5);
    assert.deepEqual(r.costByCategory, { input: 1000 * 2.5e-6, output: 200 * 1e-5 });
  });

  it('null tokens price through credits: multiplier x price per credit, no category split', () => {
    const r = priceUsage(usage({ promptTokens: null, completionTokens: null }), SNAPSHOT);
    near(r.cost, 0.33 * PPC);
    assert.equal('costByCategory' in r, false);
  });

  it('known zero tokens also price through credits (the token branch needs a positive token cost)', () => {
    const r = priceUsage(usage({ promptTokens: 0, completionTokens: 0 }), SNAPSHOT);
    near(r.cost, 0.33 * PPC);
    assert.equal('costByCategory' in r, false);
  });

  it('a zero-credit model with zero tokens costs nothing', () => {
    const r = priceUsage(usage({ modelId: 'gpt-4.1', promptTokens: 0, completionTokens: 0 }), SNAPSHOT);
    assert.deepEqual(r, { credits: 0, cost: 0 });
  });

  it('one known side is enough: completion only, or prompt only', () => {
    const out = priceUsage(usage({ promptTokens: null, completionTokens: 6 }), SNAPSHOT);
    near(out.cost, 6 * 1e-5);
    assert.deepEqual(out.costByCategory, { output: 6 * 1e-5 });

    const inp = priceUsage(usage({ promptTokens: 40, completionTokens: null }), SNAPSHOT);
    near(inp.cost, 40 * 2.5e-6);
    assert.deepEqual(inp.costByCategory, { input: 40 * 2.5e-6 });
  });

  it('an unknown model with tokens uses the credit price and splits it input/output by token ratio', () => {
    const r = priceUsage(usage({ modelId: 'mystery-model-x', promptTokens: 30, completionTokens: 10 }), SNAPSHOT);
    assert.equal(r.credits, 2); // the manifest's "unknown" multiplier
    near(r.cost, 2 * PPC);
    near(r.costByCategory!.input!, 2 * PPC * 0.75);
    near(r.costByCategory!.output!, 2 * PPC * 0.25);
  });

  it('an unknown model with prompt tokens only puts the whole credit cost on input', () => {
    const r = priceUsage(usage({ modelId: 'mystery-model-x', promptTokens: 10, completionTokens: 0 }), SNAPSHOT);
    near(r.cost, 2 * PPC);
    assert.deepEqual(Object.keys(r.costByCategory!), ['input']);
  });

  it('an unknown model with no tokens has a credit cost and no split', () => {
    const r = priceUsage(usage({ modelId: 'mystery-model-x', promptTokens: null, completionTokens: null }), SNAPSHOT);
    near(r.cost, 2 * PPC);
    assert.equal('costByCategory' in r, false);
  });

  it('a model without a feed price falls back to credits when the feed has not loaded', () => {
    const r = priceUsage(usage({ promptTokens: 1000, completionTokens: 200 }), NO_FEED);
    near(r.cost, 0.33 * PPC);
    near(r.costByCategory!.input! + r.costByCategory!.output!, 0.33 * PPC);
    near(r.costByCategory!.input!, (0.33 * PPC * 1000) / 1200);
  });

  it('a zero-credit model that the feed does not know has no cost and so no split', () => {
    const r = priceUsage(usage({ modelId: 'gpt-4.1', promptTokens: 500, completionTokens: 500 }), NO_FEED);
    assert.deepEqual(r, { credits: 0, cost: 0 });
  });

  it('prices only prompt and completion tokens: cache and thinking tokens are ignored', () => {
    const base = priceUsage(usage({ promptTokens: 1000, completionTokens: 200 }), SNAPSHOT);
    const rich = priceUsage(
      usage({ promptTokens: 1000, completionTokens: 200, cacheReadTokens: 9999, cacheCreationTokens: 9999, thinkingTokens: 9999 }),
      SNAPSHOT,
    );
    assert.deepEqual(rich, base);
  });

  it('treats the other non-claude sources (lm, github) like Copilot', () => {
    for (const source of ['lm', 'github'] as const) {
      const r = priceUsage(usage({ source, promptTokens: 1000, completionTokens: 200 }), SNAPSHOT);
      near(r.cost, 1000 * 2.5e-6 + 200 * 1e-5);
    }
  });

  it('resolves model spellings: dated, prefixed and uppercase ids reach the same prices', () => {
    const plain = priceUsage(usage({ promptTokens: 100, completionTokens: 50 }), SNAPSHOT);
    const spelled = priceUsage(usage({ modelId: 'GPT-4O', promptTokens: 100, completionTokens: 50 }), SNAPSHOT);
    assert.deepEqual(spelled, plain);
  });

  it('a group of requests: credits scale with requests and the token cost with the summed tokens', () => {
    const group = usage({ requests: 5, promptTokens: 5000, completionTokens: 1000, tokensKnown: true });
    const r = priceUsage(group, SNAPSHOT);
    near(r.credits, 5 * 0.33);
    near(r.cost, 5000 * 2.5e-6 + 1000 * 1e-5);
  });

  it('a group without tokens prices requests x multiplier x price per credit', () => {
    const r = priceUsage(usage({ requests: 7, promptTokens: 0, completionTokens: 0, tokensKnown: false }), SNAPSHOT);
    near(r.credits, 7 * 0.33);
    near(r.cost, 7 * 0.33 * PPC);
  });

  it('tokensKnown=false forces the credit price even if the token sums are positive (inconsistent input)', () => {
    const r = priceUsage(usage({ requests: 1, promptTokens: 100, completionTokens: 50, tokensKnown: false }), SNAPSHOT);
    near(r.cost, 0.33 * PPC);
    assert.equal('costByCategory' in r, false);
  });

  it('tokensKnown=true with null counts is known but has no tokens, so it prices through credits', () => {
    const r = priceUsage(usage({ promptTokens: null, completionTokens: null, tokensKnown: true }), SNAPSHOT);
    near(r.cost, 0.33 * PPC);
  });
});

describe('priceUsage — Claude Code', () => {
  const SONNET_FEED = 3e-6;

  it('prices all five token categories from the feed; credits are the multiplier, not the cost basis', () => {
    const r = priceUsage(
      claude({ promptTokens: 2000, completionTokens: 500, cacheCreationTokens: 1000, cacheReadTokens: 4000, thinkingTokens: 100 }),
      SNAPSHOT,
    );
    assert.equal(r.credits, 6);
    assert.deepEqual(r.costByCategory, {
      input: 2000 * SONNET_FEED,
      output: 500 * 15e-6,
      cache_creation: 1000 * 3.75e-6,
      cache_read: 4000 * 3e-7,
      thinking: 100 * 15e-6, // no dedicated reasoning rate: the output rate
    });
    near(r.cost, 2000 * SONNET_FEED + 500 * 15e-6 + 1000 * 3.75e-6 + 4000 * 3e-7 + 100 * 15e-6);
  });

  it('uses the dedicated thinking rate when the feed has one', () => {
    const snapshot: PricingSnapshot = {
      ...SNAPSHOT,
      tokenPrices: { 'claude-sonnet-4.5': { input: 3e-6, output: 15e-6, thinking: 4e-6 } },
    };
    const r = priceUsage(claude({ promptTokens: 10, completionTokens: 0, thinkingTokens: 100 }), snapshot);
    assert.deepEqual(r.costByCategory, { input: 10 * 3e-6, thinking: 100 * 4e-6 });
  });

  it('falls back to the bundled list prices when the feed has not loaded', () => {
    const r = priceUsage(claude({ promptTokens: 1000, completionTokens: 100 }), NO_FEED);
    const list = CLAUDE_FALLBACK_TOKEN_PRICES['claude-sonnet']!;
    near(r.cost, 1000 * list.input + 100 * list.output);
  });

  it('falls back to the bundled list prices when the feed lacks the model', () => {
    const r = priceUsage(claude({ modelId: 'claude-opus-4-5-20251101', promptTokens: 1000, completionTokens: 100 }), SNAPSHOT);
    const list = CLAUDE_FALLBACK_TOKEN_PRICES['claude-opus-4.5']!;
    near(r.cost, 1000 * list.input + 100 * list.output);
    assert.equal(r.credits, 15);
  });

  it('a model in neither list costs 0 with no split, but still has its credit weight', () => {
    const r = priceUsage(claude({ modelId: 'claude-fable-9', promptTokens: 1000, completionTokens: 100 }), SNAPSHOT);
    assert.deepEqual(r, { credits: 2, cost: 0 });
  });

  it('the credit multiplier never prices a Claude row, however large the price per credit', () => {
    const pricey: PricingSnapshot = { ...SNAPSHOT, pricePerCredit: 1000 };
    const a = priceUsage(claude({ modelId: 'claude-fable-9', promptTokens: 1000 }), pricey);
    assert.equal(a.cost, 0);
    const b = priceUsage(claude({ promptTokens: 1000 }), pricey);
    assert.equal(b.cost, 1000 * SONNET_FEED);
  });

  it('null prompt or completion tokens count as 0, and no tokens at all cost 0', () => {
    const cacheOnly = priceUsage(claude({ promptTokens: null, completionTokens: null, cacheReadTokens: 1000 }), SNAPSHOT);
    near(cacheOnly.cost, 1000 * 3e-7);
    assert.deepEqual(cacheOnly.costByCategory, { cache_read: 1000 * 3e-7 });

    const none = priceUsage(claude({ promptTokens: null, completionTokens: null }), SNAPSHOT);
    assert.deepEqual(none, { credits: 6, cost: 0 });
    const zero = priceUsage(claude({ promptTokens: 0, completionTokens: 0 }), SNAPSHOT);
    assert.deepEqual(zero, { credits: 6, cost: 0 });
  });

  it('is unaffected by tokensKnown', () => {
    const base = claude({ promptTokens: 1000, completionTokens: 100 });
    const a = priceUsage({ ...base, tokensKnown: false }, SNAPSHOT);
    const b = priceUsage({ ...base, tokensKnown: true }, SNAPSHOT);
    assert.deepEqual(a, b);
    assert.ok(a.cost > 0);
  });

  it('a group of requests multiplies credits and prices the summed tokens', () => {
    const r = priceUsage(claude({ requests: 4, promptTokens: 8000, completionTokens: 400, tokensKnown: true }), SNAPSHOT);
    assert.equal(r.credits, 24);
    near(r.cost, 8000 * SONNET_FEED + 400 * 15e-6);
  });
});

describe('priceUsage — a group prices like the sum of its rows (pricing is linear)', () => {
  type Row = Pick<RawEvent, 'promptTokens' | 'completionTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'thinkingTokens'>;

  const sum = (rows: Row[], k: keyof Row): number => rows.reduce((a, r) => a + (r[k] ?? 0), 0);

  function asGroup(source: PricedUsage['source'], modelId: string, rows: Row[], tokensKnown: boolean): AggregateGroup {
    return {
      bucketStartMs: 0, modelId, surface: 'chat', source, repo: null, branch: null, language: null, attribution: null,
      tokensKnown, requests: rows.length,
      promptTokens: sum(rows, 'promptTokens'), completionTokens: sum(rows, 'completionTokens'),
      cacheReadTokens: sum(rows, 'cacheReadTokens'), cacheCreationTokens: sum(rows, 'cacheCreationTokens'), thinkingTokens: sum(rows, 'thinkingTokens'),
    };
  }

  const row = (p: number | null, c: number | null, extra: Partial<Row> = {}): Row => ({
    promptTokens: p, completionTokens: c, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, ...extra,
  });

  function assertLinear(source: PricedUsage['source'], modelId: string, rows: Row[], snapshot: PricingSnapshot): void {
    const group = priceUsage(asGroup(source, modelId, rows, rows.some((r) => r.promptTokens !== null || r.completionTokens !== null)), snapshot);
    let credits = 0;
    let cost = 0;
    for (const r of rows) {
      const one = priceUsage({ source, modelId, requests: 1, ...r }, snapshot);
      credits += one.credits;
      cost += one.cost;
    }
    near(group.credits, credits, 'credits');
    near(group.cost, cost, 'cost');
  }

  it('Copilot rows with tokens and a feed price', () => {
    assertLinear('local', 'gpt-4o', [row(100, 20), row(50, 5), row(1, 1)], SNAPSHOT);
  });

  it('Copilot rows with tokens but no feed price (credit price, linear in requests)', () => {
    assertLinear('local', 'mystery-model-x', [row(100, 20), row(50, 5)], SNAPSHOT);
    assertLinear('local', 'gpt-4o', [row(100, 20), row(50, 5)], NO_FEED);
  });

  it('Copilot rows without tokens', () => {
    assertLinear('local', 'gpt-4o', [row(null, null), row(null, null), row(null, null)], SNAPSHOT);
  });

  it('Claude rows with every category', () => {
    assertLinear(
      'claude-code', 'claude-sonnet-4-5-20250929',
      [row(100, 20, { cacheReadTokens: 5000 }), row(7, 300, { cacheCreationTokens: 40, thinkingTokens: 9 }), row(0, 0, { cacheReadTokens: 1 })],
      SNAPSHOT,
    );
    assertLinear('claude-code', 'claude-opus-4-5-20251101', [row(100, 20), row(50, 5)], NO_FEED);
  });

  it('a rolled-up row (requests = the rows it stands for, tokens summed) prices like the rows did', () => {
    const rows = [row(100, 20), row(50, 5), row(70, 70)];
    const rolled: PricedUsage = usage({ requests: 3, promptTokens: 220, completionTokens: 95, tokensKnown: true });
    const rolledCost = priceUsage(rolled, SNAPSHOT);
    let cost = 0;
    for (const r of rows) cost += priceUsage(usage({ ...r }), SNAPSHOT).cost;
    near(rolledCost.cost, cost);
    near(rolledCost.credits, 3 * 0.33);
  });

  it('the one inexact mix: a known-zero-token row grouped with token-bearing rows loses its credit price', () => {
    // Why a group's tokensKnown (not-NULL) cannot tell a 0/0 row from a token row:
    // alone it prices by credits, but inside a group the summed tokens price it.
    const alone = priceUsage(usage({ promptTokens: 0, completionTokens: 0 }), SNAPSHOT).cost;
    near(alone, 0.33 * PPC);
    const grouped = priceUsage(usage({ requests: 2, promptTokens: 100, completionTokens: 20, tokensKnown: true }), SNAPSHOT).cost;
    const separate = priceUsage(usage({ promptTokens: 100, completionTokens: 20 }), SNAPSHOT).cost + alone;
    assert.ok(grouped < separate, 'the 0/0 row adds nothing once it shares a group with a token-bearing row');
  });
});

describe('createPricer — priceUsage bound to a snapshot', () => {
  const rows: PricedUsage[] = [
    usage({ promptTokens: 1000, completionTokens: 200 }),
    usage({ promptTokens: null, completionTokens: null, requests: 3 }),
    usage({ modelId: 'mystery-model-x', promptTokens: 30, completionTokens: 10 }),
    claude({ promptTokens: 2000, completionTokens: 500, cacheReadTokens: 4000 }),
    claude({ modelId: 'claude-opus-4-5-20251101', promptTokens: 10 }),
    claude({ modelId: 'claude-fable-9', promptTokens: 10 }),
  ];

  it('prices every row exactly like priceUsage, with and without a feed', () => {
    for (const snapshot of [SNAPSHOT, NO_FEED]) {
      const price = createPricer(snapshot);
      for (const row of rows) assert.deepEqual(price(row), priceUsage(row, snapshot));
    }
  });

  it('looks each model up in the price tables once, however many rows it prices', () => {
    let scans = 0;
    const counted = new Proxy(SNAPSHOT.tokenPrices!, {
      ownKeys(target) {
        scans++;
        return Reflect.ownKeys(target);
      },
    });
    const price = createPricer({ ...SNAPSHOT, tokenPrices: counted });
    price(rows[0]!);
    const afterFirst = scans;
    assert.ok(afterFirst > 0, 'the first row scans the feed');
    for (let i = 0; i < 50; i++) price(rows[0]!);
    price(rows[1]!); // same model, other tokens
    assert.equal(scans, afterFirst);
    price(rows[2]!); // a new model scans again
    assert.ok(scans > afterFirst);
  });
});
