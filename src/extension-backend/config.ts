import * as vscode from 'vscode';
import { readSettings, SettingValues } from './config/settings';
import { PaletteMode } from './domain/types';
import { readSetting } from './util/vscodeSettings';

/**
 * The settings that are not part of `UserConfig` (see `app/ConfigService.ts`),
 * grouped the way their consumers use them. Read fresh on each call through the
 * same sanitisers as `ConfigService` (`config/settings.ts`), so every value is
 * already in range.
 */
export interface MallardConfig {
  /** Optional override for Copilot's OTel export file / SQLite DB path. */
  copilotOtelPath: string;
  pricingManifestUrl: string;
  /** Ids of the usage connectors the user has enabled. */
  enabledConnectors: string[];
  palette: PaletteMode;
  /** Minutes between automatic log re-reads and snapshot refreshes. */
  refreshIntervalMinutes: number;
  /** Days of raw per-request events to retain before rolling up. */
  dataRetentionDays: number;
  server: {
    url: string;
  };
  export: {
    transport: 'webhook' | 'mqtt' | '';
  };
  webhook: {
    auth: 'apiKey' | 'bearer' | 'certificate';
  };
  mqtt: {
    url: string;
    username: string;
  };
  shared: {
    certificate: {
      file: string;
      keyFile: string;
      caFile: string;
    };
  };
}

/** The `MallardConfig` view of the sanitised settings. */
export function toMallardConfig(v: SettingValues): MallardConfig {
  return {
    copilotOtelPath: v['mallard.copilotOtelPath'],
    pricingManifestUrl: v['mallard.pricingManifestUrl'],
    enabledConnectors: v['mallard.enabledConnectors'],
    palette: v['mallard.palette'],
    refreshIntervalMinutes: v['mallard.refreshIntervalMinutes'],
    dataRetentionDays: v['mallard.dataRetentionDays'],
    server: { url: v['mallard.server.url'] },
    export: { transport: v['mallard.export.transport'] },
    webhook: { auth: v['mallard.webhook.auth'] },
    mqtt: { url: v['mallard.mqtt.url'], username: v['mallard.mqtt.username'] },
    shared: {
      certificate: {
        file: v['mallard.shared.certificate.file'],
        keyFile: v['mallard.shared.certificate.keyFile'],
        caFile: v['mallard.shared.certificate.caFile'],
      },
    },
  };
}

/** Every setting as it is now, through its sanitiser. Problems are not logged here (`ConfigService` does that). */
export function readSettingValues(): SettingValues {
  return readSettings((key) => readSetting('mallard', key.slice('mallard.'.length)), () => undefined);
}

/** The current non-`UserConfig` settings, validated. */
export function readConfig(): MallardConfig {
  return toMallardConfig(readSettingValues());
}

export type CopilotOtelKind = 'ndjson' | 'sqlite' | 'none';

/** Where Copilot's local OTel export writes usage, resolved from settings. */
export interface CopilotOtelSource {
  kind: CopilotOtelKind;
  /** Absolute path to the JSONL file or SQLite DB; '' when kind is 'none'. */
  path: string;
}

/**
 * Resolve Copilot's local OTel export target. A Mallard override
 * (`mallard.copilotOtelPath`) wins; otherwise the file exporter's own
 * `github.copilot.chat.otel.outfile` is used when the exporter is enabled.
 * A `.sqlite`/`.db` path selects the SQLite source; anything else is NDJSON.
 */
export function readCopilotOtel(): CopilotOtelSource {
  const copilot = vscode.workspace.getConfiguration('github.copilot.chat');
  const exporterType = String(copilot.get('otel.exporterType', '') ?? '');
  const outfile = String(copilot.get('otel.outfile', '') ?? '');
  const override = readConfig().copilotOtelPath;
  const resolved = override || (exporterType === 'file' ? outfile : '');
  if (!resolved) return { kind: 'none', path: '' };
  const kind: CopilotOtelKind = /\.(sqlite|db)$/i.test(resolved) ? 'sqlite' : 'ndjson';
  return { kind, path: resolved };
}
