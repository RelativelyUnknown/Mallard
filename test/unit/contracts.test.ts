import { strict as assert } from 'assert';
import type { IConfigService } from '../../src/extension-backend/app/ConfigService';
import type {
  AggregateGroup,
  FlatAlertMetric,
  FlatAlertRule,
  IEventStore,
  LayoutV2,
  PricingSnapshot,
  RawEvent,
} from '../../src/extension-backend/domain/contracts';
import { DEFAULT_USER_CONFIG } from '../../src/extension-backend/domain/types';

/**
 * Compile-time guard for the shared stream contracts: every contract type is
 * imported and one literal of it is built, so a change to a shape that other
 * streams rely on fails `tsc` here first. The assertions only confirm the
 * literals exist; the value is the type check.
 */
describe('stream contracts', () => {
  it('PricingSnapshot, RawEvent and AggregateGroup literals type-check', () => {
    const pricing: PricingSnapshot = {
      manifest: { version: 1, pricePerCredit: 0.04, updatedAt: '', models: { 'gpt-4.1': 1 } },
      tokenPrices: undefined,
      pricePerCredit: 0.04,
      version: 'abc123',
    };
    const raw: RawEvent = {
      id: 'e1',
      ts: 1_700_000_000_000,
      modelId: 'gpt-4.1',
      surface: 'chat',
      source: 'local',
      repo: null,
      branch: null,
      attribution: null,
      language: null,
      requests: 1,
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      thinkingTokens: 0,
    };
    const group: AggregateGroup = {
      bucketStartMs: 1_699_999_200_000,
      modelId: raw.modelId,
      surface: raw.surface,
      source: raw.source,
      repo: 'acme/app',
      branch: 'main',
      language: 'ts',
      attribution: 'authoritative',
      tokensKnown: true,
      requests: 3,
      promptTokens: 100,
      completionTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      thinkingTokens: 2,
    };
    assert.equal(pricing.version, 'abc123');
    assert.equal(group.modelId, raw.modelId);
  });

  it('IEventStore is implementable with the documented signatures', async () => {
    const store: IEventStore = {
      insert: async (events) => ({ inserted: events.length, fresh: events }),
      aggregate: async () => [],
      requestsByModelForBranch: async () => [{ modelId: 'gpt-4.1', requests: 2 }],
      exportRows: async function* () {
        yield [];
      },
      compact: async () => {},
      clear: async () => {},
      dataVersion: () => 0,
      dispose: () => {},
    };
    assert.deepEqual(await store.aggregate({}, { fromMs: 0, toMs: 1 }), []);
    assert.equal(store.dataVersion(), 0);
  });

  it('FlatAlertRule and FlatAlertMetric accept the fixed and keyed metrics', () => {
    const metrics: FlatAlertMetric[] = [
      'today.credits',
      'today.cost',
      'month.credits',
      'month.cost',
      'budget.percentOfBudget',
      'budget.percentOfIncluded',
      'forecast.projectedCredits',
      'forecast.projectedCost',
      'velocity.creditsPerHour',
      'window7d.credits',
      'currentBranchCredits',
      'model:gpt-4.1.credits',
      'model:claude-sonnet-4.cost',
      'repo:acme/app.credits',
      'repo:acme/app.cost',
    ];
    const rule: FlatAlertRule = {
      id: 'r1',
      metric: 'repo:acme/app.cost',
      op: '>=',
      value: 25,
      cooldown: '1h',
      severity: 'warning',
      notify: true,
      restrict: true,
      clearBelow: 20,
    };
    const minimal: FlatAlertRule = {
      id: 'r2',
      metric: metrics[0]!,
      op: '!=',
      value: 0,
      cooldown: '30m',
      severity: 'info',
    };
    assert.equal(metrics.length, 15);
    assert.equal(rule.clearBelow, 20);
    assert.equal(minimal.notify, undefined);
  });

  it('LayoutV2 and IConfigService literals type-check', async () => {
    const layout: LayoutV2 = {
      version: 2,
      panels: [{ id: 'daily', x: 0, y: 0, w: 2, h: 13, hidden: false }],
    };
    const config: IConfigService = {
      get: () => DEFAULT_USER_CONFIG,
      onDidChange: () => ({ dispose() {} }),
      update: async () => {},
    };
    await config.update({ monthlyBudget: 10 });
    assert.equal(layout.panels[0]!.w, 2);
    assert.equal(config.get().monthlyBudget, DEFAULT_USER_CONFIG.monthlyBudget);
  });
});
