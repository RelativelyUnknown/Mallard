import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { readConfig, readCopilotOtel, readSettingValues } from '../../src/extension-backend/config';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ws = vscode.workspace as Mutable<typeof vscode.workspace>;

function withSettings(values: Record<string, unknown>) {
  ws.getConfiguration = (() => ({
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    update: () => Promise.resolve(),
  })) as unknown as typeof ws.getConfiguration;
}

describe('readConfig', () => {
  const originalGetConfiguration = ws.getConfiguration;
  afterEach(() => { ws.getConfiguration = originalGetConfiguration; });

  it('returns documented defaults when nothing is configured', () => {
    withSettings({});
    const cfg = readConfig();
    assert.equal(cfg.copilotOtelPath, '');
    assert.equal(cfg.pricingManifestUrl, '');
    assert.deepEqual(cfg.enabledConnectors, ['copilot', 'claude-code']);
    assert.equal(cfg.palette, 'swiss');
    assert.equal(cfg.refreshIntervalMinutes, 10);
    assert.equal(cfg.dataRetentionDays, 90);
    assert.equal(cfg.export.transport, '');
    assert.equal(cfg.webhook.auth, 'apiKey');
    assert.deepEqual(cfg.mqtt, { url: '', username: '' });
    assert.deepEqual(cfg.shared.certificate, { file: '', keyFile: '', caFile: '' });
  });

  it('clamps refreshIntervalMinutes to [1, 60] and dataRetentionDays to [30, 365]', () => {
    withSettings({ refreshIntervalMinutes: 0, dataRetentionDays: 5 });
    let cfg = readConfig();
    assert.equal(cfg.refreshIntervalMinutes, 1);
    assert.equal(cfg.dataRetentionDays, 30);

    withSettings({ refreshIntervalMinutes: 999, dataRetentionDays: 9999 });
    cfg = readConfig();
    assert.equal(cfg.refreshIntervalMinutes, 60);
    assert.equal(cfg.dataRetentionDays, 365);
  });

  it('narrows export.transport to the known values', () => {
    withSettings({ 'export.transport': 'webhook' });
    assert.equal(readConfig().export.transport, 'webhook');
    withSettings({ 'export.transport': 'mqtt' });
    assert.equal(readConfig().export.transport, 'mqtt');
    withSettings({ 'export.transport': 'carrier-pigeon' });
    assert.equal(readConfig().export.transport, '');
  });

  it('narrows webhook.auth, defaulting unknown values', () => {
    for (const auth of ['apiKey', 'bearer', 'certificate'] as const) {
      withSettings({ 'webhook.auth': auth });
      assert.equal(readConfig().webhook.auth, auth);
    }
    withSettings({ 'webhook.auth': 'magic' });
    assert.equal(readConfig().webhook.auth, 'apiKey');
  });

  it('narrows palette to the known values', () => {
    withSettings({ palette: 'theme' });
    assert.equal(readConfig().palette, 'theme');
    withSettings({ palette: 'neon' });
    assert.equal(readConfig().palette, 'swiss');
  });

  it('reads the connector list: exactly the configured ids (including none), unknown ones dropped', () => {
    withSettings({ enabledConnectors: ['claude-code'] });
    assert.deepEqual(readConfig().enabledConnectors, ['claude-code']);
    withSettings({ enabledConnectors: [] });
    assert.deepEqual(readConfig().enabledConnectors, []);
    withSettings({ enabledConnectors: ['copilot', 'nonsense'] });
    assert.deepEqual(readConfig().enabledConnectors, ['copilot']);
  });

  it('trims server and mqtt URLs', () => {
    withSettings({ 'server.url': ' https://mallard.example.com ', 'mqtt.url': ' wss://b/mqtt ' });
    const cfg = readConfig();
    assert.equal(cfg.server.url, 'https://mallard.example.com');
    assert.equal(cfg.mqtt.url, 'wss://b/mqtt');
  });

  it('reads the dropped dead settings nowhere: mqtt.auth and copilotLogPath are ignored if still in a settings file', () => {
    withSettings({ 'mqtt.auth': 'certificate', copilotLogPath: '/old/logs' });
    const cfg = readConfig();
    assert.ok(!('auth' in cfg.mqtt));
    assert.ok(!('copilotLogPath' in cfg));
  });
});

describe('readSettingValues', () => {
  const originalGetConfiguration = ws.getConfiguration;
  afterEach(() => { ws.getConfiguration = originalGetConfiguration; });

  it('reads every setting through its sanitiser, by full key', () => {
    withSettings({ monthlyBudget: -4, 'display.topN': 12, currency: 'eur' });
    const v = readSettingValues();
    assert.equal(v['mallard.monthlyBudget'], 0);
    assert.equal(v['mallard.display.topN'], 12);
    assert.equal(v['mallard.currency'], 'EUR');
    assert.equal(v['mallard.includedCredits'], 300);
  });
});

describe('readCopilotOtel', () => {
  const originalGetConfiguration = ws.getConfiguration;
  afterEach(() => { ws.getConfiguration = originalGetConfiguration; });

  function withOtel(copilot: Record<string, unknown>, mallard: Record<string, unknown> = {}) {
    ws.getConfiguration = ((section: string) => ({
      get: (key: string, fallback?: unknown) => {
        const src = section === 'mallard' ? mallard : copilot;
        return key in src ? src[key] : fallback;
      },
      update: () => Promise.resolve(),
    })) as unknown as typeof ws.getConfiguration;
  }

  it('returns none when nothing is configured', () => {
    withOtel({});
    assert.deepEqual(readCopilotOtel(), { kind: 'none', path: '' });
  });

  it('returns ndjson for the file exporter outfile', () => {
    withOtel({ 'otel.exporterType': 'file', 'otel.outfile': '/x/copilot.jsonl' });
    assert.deepEqual(readCopilotOtel(), { kind: 'ndjson', path: '/x/copilot.jsonl' });
  });

  it('ignores the outfile when the exporter is not the file exporter', () => {
    withOtel({ 'otel.exporterType': 'otlp-http', 'otel.outfile': '/x/copilot.jsonl' });
    assert.deepEqual(readCopilotOtel(), { kind: 'none', path: '' });
  });

  it('lets the Mallard override win and infers sqlite from a .sqlite/.db path', () => {
    withOtel({ 'otel.exporterType': 'file', 'otel.outfile': '/x/a.jsonl' }, { copilotOtelPath: '/y/spans.sqlite' });
    assert.deepEqual(readCopilotOtel(), { kind: 'sqlite', path: '/y/spans.sqlite' });
    withOtel({}, { copilotOtelPath: '/y/data.db' });
    assert.equal(readCopilotOtel().kind, 'sqlite');
    withOtel({}, { copilotOtelPath: '/y/spans.log' });
    assert.equal(readCopilotOtel().kind, 'ndjson');
  });
});
