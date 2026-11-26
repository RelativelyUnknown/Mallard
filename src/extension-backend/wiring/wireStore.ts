/**
 * Wires the data layer: pricing and FX feeds, the event store (+ its hourly
 * compaction) and the log connectors feeding it through the ingest service.
 * Construction order matters and is preserved from the original container:
 * pricing/FX load before the store opens, the store receives the current
 * prices, then the connectors are built over it.
 */
import * as vscode from 'vscode';
import { MallardConfig, readCopilotOtel } from '../config';
import type { PricingManifest } from '../domain/pricing';
import { ClaudeCodeConnector } from '../ingest/ClaudeCodeConnector';
import { ConnectorRegistry } from '../ingest/ConnectorRegistry';
import { CopilotConnector } from '../ingest/CopilotConnector';
import { CopilotOtelRequirement } from '../ingest/CopilotOtelRequirement';
import { IngestService } from '../ingest/IngestService';
import type { LogConnector } from '../ingest/LogConnector';
import { WorkspaceFolderMatcher } from '../ingest/WorkspaceFolderMatcher';
import { CurrencyService } from '../pricing/CurrencyService';
import { PricingService } from '../pricing/PricingService';
import { EventStore } from '../store/EventStore';
import type { WiringScope } from './scope';

/** How often the store rolls old raw events up into daily aggregates. */
export const COMPACT_INTERVAL_MS = 60 * 60 * 1000;

export interface StoreWiring {
  pricing: PricingService;
  currency: CurrencyService;
  store: EventStore;
  ingest: IngestService;
  /** Every connector Mallard knows, enabled or not. */
  allConnectors: LogConnector[];
  /** The subset enabled by `mallard.enabledConnectors` (what is registered with ingest). */
  activeConnectors: LogConnector[];
}

export interface StoreWiringDeps {
  /** Settings snapshot taken at activation (feed URL, retention). */
  cfg: Pick<MallardConfig, 'pricingManifestUrl' | 'dataRetentionDays'>;
  bundledManifest: PricingManifest;
  /** Ids of the connectors the user has enabled. */
  enabledConnectors: ReadonlySet<string>;
}

export async function wireStore(scope: WiringScope, deps: StoreWiringDeps): Promise<StoreWiring> {
  const { context, storageDir, started } = scope;
  const { cfg, bundledManifest, enabledConnectors } = deps;

  const pricing = new PricingService(storageDir, bundledManifest, cfg.pricingManifestUrl || '');
  const currency = new CurrencyService(storageDir);
  started.push(() => pricing.dispose(), () => currency.dispose());
  // Independent (pricing feed vs FX feed) — load their local caches in parallel
  // rather than awaiting one after the other. Neither blocks on the network now.
  await Promise.all([pricing.load(), currency.load()]);
  pricing.startDailyRefresh();
  currency.startDailyRefresh();

  const store = await EventStore.open(storageDir, cfg.dataRetentionDays);
  started.push(() => store.dispose());
  await store.writer.setPrices(pricing.allPrices());

  context.subscriptions.push(scheduleCompaction(store));

  const copilot = new CopilotConnector(
    pricing,
    store.meta,
    store.fileReader,
    () => readCopilotOtel(),
    [new CopilotOtelRequirement()],
  );
  const claudeCode = new ClaudeCodeConnector(
    pricing,
    store.meta,
    store.fileReader,
    new WorkspaceFolderMatcher(() => vscode.workspace.workspaceFolders),
  );

  // Every connector exposes a canonical `.id`; enable/label off that so adding a
  // new usage source is one entry in this list, not four hardcoded id checks.
  const allConnectors: LogConnector[] = [copilot, claudeCode];
  const activeConnectors = allConnectors.filter((c) => enabledConnectors.has(c.id));
  const registry = new ConnectorRegistry();
  for (const c of activeConnectors) registry.register(c);
  const ingest = new IngestService(registry.build());

  return { pricing, currency, store, ingest, allConnectors, activeConnectors };
}

/** Roll old raw events up on a timer; the returned disposable stops it. */
export function scheduleCompaction(
  store: Pick<EventStore, 'compact'>,
  intervalMs: number = COMPACT_INTERVAL_MS,
): vscode.Disposable {
  const handle = setInterval(() => { void store.compact(); }, intervalMs);
  return { dispose: () => clearInterval(handle) };
}

/** The pricing manifest shipped inside the extension, or an empty one when it cannot be read. */
export async function loadBundledManifest(context: Pick<vscode.ExtensionContext, 'extensionUri'>): Promise<PricingManifest> {
  const fallback: PricingManifest = { version: 1, pricePerCredit: 0.04, updatedAt: '', models: {} };
  const manifestPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'pricing-manifest.json');
  try {
    const raw = await vscode.workspace.fs.readFile(manifestPath);
    return JSON.parse(Buffer.from(raw).toString('utf8')) as PricingManifest;
  } catch {
    return fallback;
  }
}
