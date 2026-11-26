import { strict as assert } from 'assert';
import { errAsync } from 'neverthrow';
import { AlertService } from '../../../src/extension-backend/app/AlertService';
import { UsageService } from '../../../src/extension-backend/app/UsageService';
import type { IConfigService } from '../../../src/extension-backend/app/ConfigService';
import { BillingError } from '../../../src/extension-backend/billing/GitHubUsageService';
import type { IBillingProvider } from '../../../src/extension-backend/billing/IBillingProvider';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';
import type { IngestService } from '../../../src/extension-backend/ingest/IngestService';
import type { CurrencyService } from '../../../src/extension-backend/pricing/CurrencyService';
import type { PricingService } from '../../../src/extension-backend/pricing/PricingService';
import type { EventStore } from '../../../src/extension-backend/store/EventStore';
import { wireUsage } from '../../../src/extension-backend/wiring/wireUsage';
import type { WiringScope } from '../../../src/extension-backend/wiring/scope';

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function scope(): WiringScope & { started: Array<() => void> } {
  return {
    context: { subscriptions: [] } as unknown as WiringScope['context'],
    storageDir: '/unused',
    started: [],
  };
}

const userConfig = {
  get: () => ({ ...DEFAULT_USER_CONFIG, monthlyBudget: 100 }),
  onDidChange: () => ({ dispose() {} }),
} as unknown as IConfigService;

describe('wireUsage', () => {
  function deps(over: { github?: IBillingProvider; errors?: string[] } = {}) {
    const refreshed: string[] = [];
    const currency = { currentRates: () => ({}) } as unknown as CurrencyService & { onRatesUpdated?: () => void };
    const ingest = {
      getStatus: () => ({ kind: 'ok' as const }),
      start: async () => {
        refreshed.push('ingest.start');
      },
      dispose() {},
    } as unknown as IngestService;
    const store = {
      reader: {
        readSnapshotCache: async () => {
          throw new Error('store unavailable');
        },
        readFilteredSnapshot: async () => {
          throw new Error('store unavailable');
        },
        creditsByBranch: async () => 0,
      },
    } as unknown as EventStore;
    const github = over.github ?? ({
      fetch: () => errAsync(new BillingError('not-signed-in', 'Not signed in')),
      onDidChange: () => ({ dispose() {} }),
      dispose() {},
    } as unknown as IBillingProvider);
    const errors = over.errors ?? [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error: (_tag: string, msg: string) => void errors.push(msg),
    };
    const s = scope();
    const alerts = new AlertService({ host: { showWarningMessage: async () => undefined }, config: () => userConfig.get() });
    const wired = wireUsage(s, {
      store,
      pricing: { pricePerCredit: 0.04, currentManifest: undefined } as unknown as PricingService,
      ingest,
      userConfig,
      currency,
      github,
      alerts,
      logger,
    });
    return { ...wired, currency, refreshed, errors, started: s.started, alerts };
  }

  it('builds the UsageService with the injected alerts and registers its cleanup', () => {
    const { usage, started } = deps();
    assert.ok(usage instanceof UsageService);
    assert.equal(started.length, 1);
    started[0]!();
  });

  it('refreshUsage runs a refresh and logs a failure as "<what> failed"', async () => {
    const errors: string[] = [];
    const { refreshUsage, started } = deps({ errors });
    refreshUsage('refresh after connector setup');
    await tick(30);
    assert.ok(errors.includes('refresh after connector setup failed'), errors.join(' | '));
    started[0]!();
  });

  it('recomputes when the background FX refresh lands new rates', async () => {
    const errors: string[] = [];
    const { currency, started } = deps({ errors });
    assert.equal(typeof currency.onRatesUpdated, 'function');
    currency.onRatesUpdated!();
    await tick(30);
    assert.ok(errors.includes('refresh after FX rates update failed'), errors.join(' | '));
    started[0]!();
  });
});
