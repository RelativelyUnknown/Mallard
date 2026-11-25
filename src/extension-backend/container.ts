/**
 * The composition root: builds every Mallard service by calling the focused
 * `wire*` functions in `wiring/`, in dependency order, so activation reads as a
 * flat list of registrations. Keep it free of logic — anything with a branch
 * belongs in a (unit-tested) wiring module; this file is excluded from coverage.
 *
 * ORDER MATTERS. Construction order is the order of the calls below (and of the
 * statements inside each wire function); `scope.started` collects cleanups that
 * run in reverse if a later step throws; and the `subscriptions.push` at the end
 * fixes the disposal order on shutdown.
 */
import * as vscode from 'vscode';
import { readConfig } from './config';
import type { UsageService } from './app/UsageService';
import type { ConfigService } from './app/ConfigService';
import type { ImportResult } from './app/ConfigImporter';
import type { LayoutStore } from './app/LayoutStore';
import type { RestrictionEngine } from './app/RestrictionEngine';
import { ConnectorSetupGate } from './ingest/ConnectorSetupGate';
import type { IngestService } from './ingest/IngestService';
import { initRepoAttribution } from './ingest/repoResolver';
import type { PricingService } from './pricing/PricingService';
import type { EventStore } from './store/EventStore';
import { wireAlerts } from './wiring/wireAlerts';
import { wireConfig } from './wiring/wireConfig';
import { wireExport } from './wiring/wireExport';
import { wireRestriction } from './wiring/wireRestriction';
import { loadBundledManifest, wireStore } from './wiring/wireStore';
import { wireUsage } from './wiring/wireUsage';
import { withStartupRollback } from './wiring/startupRollback';
import type { WiringScope } from './wiring/scope';

export interface Container {
  usage: UsageService;
  store: EventStore;
  userConfig: ConfigService;
  /** What the one-time `config.json` import did at this activation. */
  imported: ImportResult;
  layout: LayoutStore;
  pricing: PricingService;
  restriction: RestrictionEngine;
  ingest: IngestService;
  setupGate: ConnectorSetupGate;
}

/**
 * Builds every service. All-or-nothing: if any step throws, everything started
 * before it is torn down and nothing is left on `context.subscriptions`.
 */
export async function buildContainer(context: vscode.ExtensionContext): Promise<Container> {
  return withStartupRollback(context.subscriptions, (started) =>
    assembleContainer({ context, storageDir: context.globalStorageUri.fsPath, started }),
  );
}

async function assembleContainer(scope: WiringScope): Promise<Container> {
  const { context, started } = scope;
  void initRepoAttribution();
  const bundledManifest = await loadBundledManifest(context);
  const cfg = readConfig();

  const { pricing, currency, store, ingest, activeConnectors } = await wireStore(scope, {
    cfg,
    bundledManifest,
    enabledConnectors: new Set(cfg.enabledConnectors),
  });
  const { userConfig, layout, githubSession, github, imported } = await wireConfig(scope, { pricing });
  const { exporter } = await wireExport(scope, { cfg, userConfig, store });
  const { alerts } = wireAlerts(scope, { userConfig });
  const { usage, refreshUsage } = wireUsage(scope, {
    store, pricing, ingest, userConfig, currency, github, alerts,
  });
  const { restriction } = wireRestriction(scope, { usage, userConfig });

  // Generic gate that nudges the user to enable any connector prerequisite
  // (e.g. Copilot's OTel exporter) and re-refreshes once applied. Scoped to
  // only the enabled connectors — no point nudging Copilot OTel setup for a
  // connector the user opted out of via mallard.enabledConnectors.
  const setupGate = new ConnectorSetupGate(context, activeConnectors, () =>
    refreshUsage('refresh after connector setup'),
  );
  started.push(() => setupGate.dispose());

  // Shutdown disposal order (VS Code disposes subscriptions in array order).
  context.subscriptions.push(
    { dispose: () => pricing.dispose() },
    { dispose: () => currency.dispose() },
    { dispose: () => githubSession.dispose() },
    { dispose: () => store.dispose() },
    userConfig,
    layout,
    usage,
    restriction,
    { dispose: () => exporter.close() },
    setupGate,
  );

  return { usage, store, userConfig, imported, layout, pricing, restriction, ingest, setupGate };
}
