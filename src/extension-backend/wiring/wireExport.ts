/**
 * Wires metric export: builds the exporter, rebuilds it in place when anything
 * it captured changes (settings, credentials, config.json fan-out targets), and
 * streams every batch of freshly ingested events to it.
 */
import { EXPORT_CONFIG_KEYS, MallardConfig, readConfig as readSettings } from '../config';
import { isExportSecretKey } from '../app/credentials';
import type { UserConfigStore } from '../app/UserConfigStore';
import type { UsageEvent } from '../domain/types';
import { AuthProvider } from '../export/AuthProvider';
import { ExporterRebuilder } from '../export/ExporterRebuilder';
import type { Exporter } from '../export/MetricExporter';
import { buildStreamBatch, chunkEvents } from '../export/payload';
import { defaultLogger, Logger } from '../util/logger';
import { onSettingsChanged } from '../util/vscodeSettings';
import type { WiringScope } from './scope';

export interface ExportWiring {
  /** Owns the live exporter; `current` is always the one to send to. */
  exporter: ExporterRebuilder;
}

export interface ExportWiringDeps {
  /** Settings snapshot taken at activation, used for the first build. */
  cfg: MallardConfig;
  /** Settings as they are NOW, used by every rebuild. */
  readConfig?: () => MallardConfig;
  userConfig: Pick<UserConfigStore, 'get' | 'onDidChange'>;
  /** The store whose ingest callback receives the stream; only `writer.onInserted` is set. */
  store: { writer: { onInserted?: (events: UsageEvent[]) => void } };
}

export async function wireExport(scope: WiringScope, deps: ExportWiringDeps): Promise<ExportWiring> {
  const { context, started } = scope;
  const { cfg, userConfig, store, readConfig = readSettings } = deps;

  // Extra webhook/MQTT targets from config.json fan the export out to
  // multiple destinations.
  const build = (settings: MallardConfig): Promise<Exporter> =>
    new AuthProvider(settings, context, userConfig.get().export ?? {}).createExporter();

  const exporter = new ExporterRebuilder(await build(cfg), () => build(readConfig()));
  started.push(() => exporter.close());

  const scheduleRebuild = (): void => exporter.scheduleRebuild();
  context.subscriptions.push(
    // Transport/auth/URL/cert changes rebuild the exporter in place — they used
    // to silently require a window reload.
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

  // The streaming pipeline: every batch of freshly ingested (deduped) events
  // is priced/labeled already — chunk it and hand it to the exporter, which
  // owns durable retry. Fire-and-forget; ingest never blocks on the network.
  store.writer.onInserted = streamInsertedEvents(() => exporter.current);

  return { exporter };
}

/**
 * The ingest callback: chunks a batch of fresh events (oldest first) and sends
 * each chunk to the exporter, read per chunk so a rebuild mid-batch takes effect
 * immediately. Never throws or blocks the caller; a failure is logged.
 */
export function streamInsertedEvents(
  getExporter: () => Exporter,
  logger: Logger = defaultLogger,
): (events: UsageEvent[]) => void {
  return (events) => {
    void (async () => {
      for (const chunk of chunkEvents(events)) {
        await getExporter().export(buildStreamBatch(chunk));
      }
    })().catch((err: unknown) => logger.error('export', 'event stream export failed', err));
  };
}
