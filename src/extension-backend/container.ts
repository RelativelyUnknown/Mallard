/**
 * Builds and wires every Mallard service in one place, so activation reads as a
 * flat list of registrations. All disposables are pushed onto the extension
 * context's subscriptions.
 */
import * as vscode from 'vscode';
import { EXPORT_CONFIG_KEYS, readConfig, readCopilotOtel } from './config';
import { onSettingsChanged } from './util/vscodeSettings';
import { UsageService } from './app/UsageService';
import { UserConfigStore } from './app/UserConfigStore';
import { LayoutStore } from './app/LayoutStore';
import { GitHubSession } from './billing/GitHubSession';
import { GitHubUsageService } from './billing/GitHubUsageService';
import { RestrictionEngine } from './app/RestrictionEngine';
import { PricingManifest } from './domain/pricing';
import { initRepoAttribution } from './ingest/repoResolver';
import { CopilotConnector } from './ingest/CopilotConnector';
import { CopilotOtelRequirement } from './ingest/CopilotOtelRequirement';
import { ClaudeCodeConnector } from './ingest/ClaudeCodeConnector';
import { ConnectorRegistry } from './ingest/ConnectorRegistry';
import { ConnectorSetupGate } from './ingest/ConnectorSetupGate';
import { WorkspaceFolderMatcher } from './ingest/WorkspaceFolderMatcher';
import { IngestService } from './ingest/IngestService';
import { PricingService } from './pricing/PricingService';
import { CurrencyService } from './pricing/CurrencyService';
import { EventStore } from './store/EventStore';
import { AuthProvider } from './export/AuthProvider';
import type { Exporter } from './export/MetricExporter';
import { buildStreamBatch, chunkEvents } from './export/payload';
import { isExportSecretKey } from './app/credentials';
import { opt } from './util/lang';
import { defaultLogger } from './util/logger';

export interface Container {
  usage: UsageService;
  store: EventStore;
  userConfig: UserConfigStore;
  layout: LayoutStore;
  pricing: PricingService;
  restriction: RestrictionEngine;
  ingest: IngestService;
  setupGate: ConnectorSetupGate;
}

/**
 * Builds every service. Anything started before a later step throws (the
 * pricing/FX refresh timers, the DuckDB handle, the config watcher…) is torn
 * down again, and nothing this call registered on `context.subscriptions` is
 * left behind — a failed activation must not leak live timers and file handles
 * into the rest of the window's lifetime.
 */
export async function buildContainer(context: vscode.ExtensionContext): Promise<Container> {
  const subscriptionsAtStart = context.subscriptions.length;
  const started: Array<() => void> = [];
  try {
    return await assembleContainer(context, started);
  } catch (err) {
    const leaked = context.subscriptions.splice(subscriptionsAtStart);
    for (const dispose of [...started.reverse(), ...leaked.reverse().map((d) => () => d.dispose())]) {
      try {
        dispose();
      } catch (disposeErr) {
        defaultLogger.warn('container', 'cleanup after failed startup threw', disposeErr);
      }
    }
    throw err;
  }
}

async function assembleContainer(
  context: vscode.ExtensionContext,
  started: Array<() => void>,
): Promise<Container> {
  void initRepoAttribution();
  const bundledManifest = await loadBundledManifest(context);

  const cfg = readConfig();
  const storageDir = context.globalStorageUri.fsPath;

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

  const COMPACT_INTERVAL_MS = 60 * 60 * 1000;
  const compactHandle = setInterval(() => { void store.compact(); }, COMPACT_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(compactHandle) });

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

  const enabledConnectors = new Set(
    vscode.workspace.getConfiguration('mallard').get<string[]>('enabledConnectors')
      ?? ['copilot', 'claude-code'],
  );
  // Every connector exposes a canonical `.id`; enable/label off that so adding a
  // new usage source is one entry in this list, not four hardcoded id checks.
  const allConnectors = [copilot, claudeCode];
  const registry = new ConnectorRegistry();
  for (const c of allConnectors) {
    if (enabledConnectors.has(c.id)) registry.register(c);
  }
  const ingest = new IngestService(registry.build());

  const githubSession = new GitHubSession(context.secrets);
  started.push(() => githubSession.dispose());
  const github = new GitHubUsageService(githubSession);
  const userConfig = new UserConfigStore(storageDir);
  started.push(() => userConfig.dispose());
  const layout = new LayoutStore(userConfig, context.globalState);
  started.push(() => layout.dispose());

  // Deliver the config.json githubBilling block (mode/pat/org) and keep it
  // live on config changes — previously configure() was never called, so the
  // whole user-level PAT path was dead.
  githubSession.configure(userConfig.get().githubBilling);
  context.subscriptions.push(
    userConfig.onDidChange((c) => githubSession.configure(c.githubBilling)),
  );

  // Extra webhook/MQTT targets from config.json fan the export out to
  // multiple destinations.
  let exporter: Exporter = await new AuthProvider(
    cfg,
    context,
    userConfig.get().export ?? {},
  ).createExporter();
  let closed = false;
  const closeExporter = (): void => {
    closed = true;
    exporter.dispose();
  };
  started.push(closeExporter);

  // Transport/auth/URL/cert changes rebuild the exporter in place — they used
  // to silently require a window reload. The onInserted pipeline below reads
  // `exporter` per call, so it picks up the replacement immediately.
  const rebuildExporter = async (): Promise<void> => {
    const next = await new AuthProvider(
      readConfig(),
      context,
      userConfig.get().export ?? {},
    ).createExporter();
    if (closed) {
      next.dispose(); // the extension shut down while this was building
      return;
    }
    const old = exporter;
    exporter = next;
    old.dispose();
  };
  // Rebuilds are chained so overlapping triggers (a settings edit plus the
  // three secret writes of "Manage Credentials") apply in order instead of
  // racing — the last one built is the one left installed.
  let rebuilding: Promise<void> = Promise.resolve();
  const scheduleRebuild = (): void => {
    rebuilding = rebuilding
      .then(rebuildExporter)
      .catch((err: unknown) => defaultLogger.error('export', 'exporter rebuild failed', err));
  };
  context.subscriptions.push(
    onSettingsChanged(EXPORT_CONFIG_KEYS, scheduleRebuild),
    // The exporter captures its credentials when it is built, so setting,
    // changing or clearing a webhook key / bearer token / signing secret / MQTT
    // password has to rebuild it — previously the old secret kept being sent
    // until the window was reloaded.
    context.secrets.onDidChange((e) => {
      if (isExportSecretKey(e.key)) scheduleRebuild();
    }),
  );
  // Fanout target changes live in config.json (export.webhookTargets /
  // export.mqttTargets) rather than settings — watch the export block too so
  // "Mallard: Configure Export Fanout Targets" applies without a reload.
  let lastExportBlock = JSON.stringify(userConfig.get().export ?? {});
  context.subscriptions.push(
    userConfig.onDidChange((c) => {
      const next = JSON.stringify(c.export ?? {});
      if (next === lastExportBlock) return;
      lastExportBlock = next;
      scheduleRebuild();
    }),
  );

  const usage = new UsageService(store.reader, pricing, ingest, userConfig, currency, github);
  started.push(() => usage.dispose());

  // The streaming pipeline: every batch of freshly ingested (deduped) events
  // is priced/labeled already — chunk it and hand it to the exporter, which
  // owns durable retry. Fire-and-forget; ingest never blocks on the network.
  store.writer.onInserted = (events) => {
    void (async () => {
      for (const chunk of chunkEvents(events)) {
        await exporter.export(buildStreamBatch(chunk));
      }
    })().catch((err: unknown) => defaultLogger.error('export', 'event stream export failed', err));
  };
  const refreshUsage = (what: string): void => {
    usage.refresh().catch((err: unknown) => defaultLogger.error('usage', `${what} failed`, err));
  };
  // When the background FX refresh lands real rates, recompute so the dashboard
  // updates from the USD-only default it started with.
  currency.onRatesUpdated = () => refreshUsage('refresh after FX rates update');
  const restriction = new RestrictionEngine(storageDir);
  started.push(() => restriction.dispose());

  // Generic gate that nudges the user to enable any connector prerequisite
  // (e.g. Copilot's OTel exporter) and re-refreshes once applied. Scoped to
  // only the enabled connectors — no point nudging Copilot OTel setup for a
  // connector the user opted out of via mallard.enabledConnectors.
  const activeConnectors = allConnectors.filter((c) => enabledConnectors.has(c.id));
  const setupGate = new ConnectorSetupGate(context, activeConnectors, () =>
    refreshUsage('refresh after connector setup'),
  );
  started.push(() => setupGate.dispose());

  context.subscriptions.push(
    // Unfiltered snapshots only: a dashboard filter shows a slice of the data,
    // and reconciling restriction rules against it would fire or lift a
    // restriction on the wrong numbers.
    usage.onDidComputeUnfiltered((snapshot) => {
      const userCfg = userConfig.get();
      void restriction.reconcile({
        snapshot,
        rules: userCfg.rules ?? [],
        ...opt('vars',           userCfg.vars),
        ...opt('groups',         userCfg.groups),
        signedIn: snapshot.authStatus === 'signed-in',
        ...opt('branchBudgets', userCfg.branchBudgets),
      }).catch((err: unknown) =>
        defaultLogger.error('restriction', 'restriction reconcile failed', err),
      );
    }),
  );

  context.subscriptions.push(
    { dispose: () => pricing.dispose() },
    { dispose: () => currency.dispose() },
    { dispose: () => githubSession.dispose() },
    { dispose: () => store.dispose() },
    userConfig,
    layout,
    usage,
    restriction,
    { dispose: closeExporter },
    setupGate,
  );

  return { usage, store, userConfig, layout, pricing, restriction, ingest, setupGate };
}

async function loadBundledManifest(context: vscode.ExtensionContext): Promise<PricingManifest> {
  const fallback: PricingManifest = { version: 1, pricePerCredit: 0.04, updatedAt: '', models: {} };
  const manifestPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'pricing-manifest.json');
  try {
    const raw = await vscode.workspace.fs.readFile(manifestPath);
    return JSON.parse(Buffer.from(raw).toString('utf8')) as PricingManifest;
  } catch {
    return fallback;
  }
}
