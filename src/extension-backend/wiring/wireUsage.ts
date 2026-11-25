/**
 * Wires the usage service (ingest → store → snapshot) and the refresh paths
 * that feed it from outside: the background FX-rate refresh.
 */
import type { AlertService } from '../app/AlertService';
import { UsageService } from '../app/UsageService';
import type { UserConfigStore } from '../app/UserConfigStore';
import type { IBillingProvider } from '../billing/IBillingProvider';
import type { IngestService } from '../ingest/IngestService';
import type { CurrencyService } from '../pricing/CurrencyService';
import type { PricingService } from '../pricing/PricingService';
import type { EventStore } from '../store/EventStore';
import { defaultLogger, Logger } from '../util/logger';
import { defaultVscodeHost } from '../util/vscodeHost';
import type { WiringScope } from './scope';

export interface UsageWiring {
  usage: UsageService;
  /** Fire-and-forget `usage.refresh()` that logs a failure as `"<what> failed"`. */
  refreshUsage: (what: string) => void;
}

export interface UsageWiringDeps {
  store: Pick<EventStore, 'reader'>;
  pricing: PricingService;
  ingest: IngestService;
  userConfig: UserConfigStore;
  currency: CurrencyService;
  github: IBillingProvider;
  alerts: AlertService;
  logger?: Logger;
}

export function wireUsage(scope: WiringScope, deps: UsageWiringDeps): UsageWiring {
  const { store, pricing, ingest, userConfig, currency, github, alerts, logger = defaultLogger } = deps;

  const usage = new UsageService(
    store.reader, pricing, ingest, userConfig, currency, github, defaultVscodeHost, logger, alerts,
  );
  scope.started.push(() => usage.dispose());

  const refreshUsage = (what: string): void => {
    usage.refresh().catch((err: unknown) => logger.error('usage', `${what} failed`, err));
  };
  // When the background FX refresh lands real rates, recompute so the dashboard
  // updates from the USD-only default it started with.
  currency.onRatesUpdated = () => refreshUsage('refresh after FX rates update');

  return { usage, refreshUsage };
}
