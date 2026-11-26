/**
 * Synchronous access to the recordings and the frozen pricing inputs, for tests
 * that check a new implementation against `test/golden/expected/` without
 * running the DuckDB pipeline. (`pipeline.ts` is the async, store-driving side.)
 */
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import type { PricingSnapshot, RawEvent } from '../../src/extension-backend/domain/contracts';
import type { PricingManifest, TokenPrices } from '../../src/extension-backend/domain/pricing';
import { toRawEvent } from './groupEvents';
import type { NormalizedEvent } from './pipeline';
import { expectedPath } from './support/canon';

const PRICING_DIR = path.join(__dirname, 'fixtures', 'pricing');

export const FROZEN_MANIFEST = JSON.parse(readFileSync(path.join(PRICING_DIR, 'manifest.json'), 'utf8')) as PricingManifest;
export const FROZEN_TOKEN_PRICES = JSON.parse(readFileSync(path.join(PRICING_DIR, 'token-prices.json'), 'utf8')) as TokenPrices;

/** The pricing inputs every recording was made with, as a read-time snapshot. */
export const FROZEN: PricingSnapshot = {
  manifest: FROZEN_MANIFEST,
  tokenPrices: FROZEN_TOKEN_PRICES,
  pricePerCredit: FROZEN_MANIFEST.pricePerCredit,
  version: 'golden-frozen',
};

/** A recorded golden: the zone-specific file when the recorder wrote one, else the zone-independent one. */
export function loadExpectedSync(name: string, tz: string): unknown {
  const file = existsSync(expectedPath(name, tz)) ? expectedPath(name, tz) : expectedPath(name);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** The recording's mapped events (they carry cache and thinking tokens), and the same as stored rows. */
export function loadGoldenEvents(tz: string): { recorded: NormalizedEvent[]; raw: RawEvent[] } {
  const { events } = loadExpectedSync('events', tz) as { events: NormalizedEvent[] };
  return { recorded: events, raw: events.map(toRawEvent) };
}
