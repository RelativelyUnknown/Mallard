import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { wipeAllData, type WipeDeps } from '../../../src/extension-backend/app/uninstall';
import { ALL_SECRET_KEYS, SECRET_KEYS } from '../../../src/extension-backend/app/credentials';
import { queueFileFor } from '../../../src/extension-backend/export/ExportQueue';
import { DEFAULT_USER_CONFIG, type UserConfig } from '../../../src/extension-backend/domain/types';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-uninstall-'));
}

function makeDeps(dir: string, initial: UserConfig) {
  let config = initial;
  const order: string[] = [];
  const deletedSecrets: string[] = [];
  const deps: WipeDeps = {
    storageDir: dir,
    secrets: { delete: async (k) => void deletedSecrets.push(k) },
    globalState: { keys: () => ['a', 'b'], update: async (k) => void order.push(`state:${k}`) },
    store: { clear: async () => void order.push('store') },
    userConfig: {
      get: () => config,
      reset: async () => {
        order.push('config-reset');
        config = { ...DEFAULT_USER_CONFIG }; // the export block (and its targets) is gone after a reset
      },
    },
    layout: { reset: async () => void order.push('layout') },
    pricing: { clearCache: async () => void order.push('pricing') },
    restriction: { clearAll: async () => void order.push('restriction') },
  };
  return { deps, order, deletedSecrets };
}

describe('wipeAllData (Prepare for Uninstall)', () => {
  const withTargets: UserConfig = {
    ...DEFAULT_USER_CONFIG,
    export: {
      webhookTargets: [{ id: 'team', name: 'Team server', url: 'https://t.example' }],
      mqttTargets: [{ id: 'broker2', name: 'Broker 2', url: 'wss://b.example/mqtt' }],
    },
  };

  it('deletes per-target secrets (keyed by target id), which are only knowable BEFORE the settings reset', async () => {
    const dir = await tmpDir();
    const { deps, deletedSecrets } = makeDeps(dir, withTargets);
    await wipeAllData(deps);
    for (const key of ALL_SECRET_KEYS) assert.ok(deletedSecrets.includes(key), key);
    for (const key of [
      `${SECRET_KEYS.webhookApiKey}:team`,
      `${SECRET_KEYS.webhookBearerToken}:team`,
      `${SECRET_KEYS.webhookSigningSecret}:team`,
      `${SECRET_KEYS.mqttPassword}:broker2`,
    ]) {
      assert.ok(deletedSecrets.includes(key), `per-target secret ${key} must not be orphaned in the keychain`);
    }
  });

  it('removes the export queue files of every target, and nothing else', async () => {
    const dir = await tmpDir();
    for (const f of ['export-queue.json', queueFileFor('team'), queueFileFor('a/b'), 'unrelated.json']) {
      await fs.writeFile(path.join(dir, f), '[]');
    }
    const { deps } = makeDeps(dir, withTargets);
    await wipeAllData(deps);
    assert.deepEqual(await fs.readdir(dir), ['unrelated.json']);
  });

  it('removes a pre-settings config.json and its .migrated backup (which keeps the old alert rules)', async () => {
    const dir = await tmpDir();
    for (const f of ['config.json', 'config.json.migrated', 'unrelated.json']) await fs.writeFile(path.join(dir, f), '{}');
    const { deps } = makeDeps(dir, withTargets);
    await wipeAllData(deps);
    assert.deepEqual(await fs.readdir(dir), ['unrelated.json']);
  });

  it('wipes the store, config, layout, pricing cache, restriction state and globalState', async () => {
    const dir = await tmpDir();
    const { deps, order } = makeDeps(dir, withTargets);
    await wipeAllData(deps);
    assert.deepEqual(order, [
      'store', 'config-reset', 'layout', 'pricing', 'restriction', 'state:a', 'state:b',
    ]);
  });
});
