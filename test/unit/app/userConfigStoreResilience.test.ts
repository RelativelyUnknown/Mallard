import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserConfigStore } from '../../../src/extension-backend/app/UserConfigStore';
import type { UserConfig } from '../../../src/extension-backend/domain/types';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-ucs-resilience-'));
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

function recordingLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug() {},
      info() {},
      error() {},
      warn: (_tag: string, msg: string) => void warnings.push(msg),
    },
  };
}

async function listBackups(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.startsWith('config.json.bad-'));
}

describe('UserConfigStore — a bad config.json never costs the user their data', () => {
  it('leaves a malformed file byte-for-byte untouched at startup (no seed/overwrite)', async () => {
    const dir = await tmpDir();
    const bad = '{ "monthlyBudget": 20, // user comment\n "rules": [ ';
    await fs.writeFile(path.join(dir, 'config.json'), bad, 'utf8');
    const store = new UserConfigStore(dir, recordingLogger().logger);
    assert.equal(store.get().monthlyBudget, 0, 'defaults in force');
    assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), bad);
    assert.deepEqual(await listBackups(dir), [], 'nothing to back up until the user changes something');
    store.dispose();
  });

  it('backs the bad file up once, then overwrites it, on the first set()', async () => {
    const dir = await tmpDir();
    const bad = '{ "monthlyBudget": 20, ';
    await fs.writeFile(path.join(dir, 'config.json'), bad, 'utf8');
    const store = new UserConfigStore(dir, recordingLogger().logger);

    await store.set({ monthlyBudget: 5 });
    const backups = await listBackups(dir);
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(dir, backups[0]!), 'utf8'), bad, 'backup holds the original text');
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as UserConfig;
    assert.equal(onDisk.monthlyBudget, 5);

    await store.set({ monthlyBudget: 6 });
    assert.equal((await listBackups(dir)).length, 1, 'backed up once, not on every write');
    store.dispose();
  });

  it('drops only the invalid block (with a warning) and keeps the other blocks', async () => {
    const dir = await tmpDir();
    const original = JSON.stringify({
      monthlyBudget: 10,
      includedCredits: 123,
      rules: 'not-an-array',
      currency: 'EUR',
    });
    await fs.writeFile(path.join(dir, 'config.json'), original, 'utf8');
    const { logger, warnings } = recordingLogger();
    const store = new UserConfigStore(dir, logger);
    const cfg = store.get();
    assert.equal(cfg.monthlyBudget, 10);
    assert.equal(cfg.includedCredits, 123);
    assert.equal(cfg.currency, 'EUR');
    assert.deepEqual(cfg.rules, [], 'invalid rules block dropped to its default');
    assert.ok(warnings.some((w) => w.includes('rules')), `warns naming the block: ${warnings.join('|')}`);
    assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), original, 'file untouched');

    await store.set({ monthlyBudget: 11 });
    const backups = await listBackups(dir);
    assert.equal(backups.length, 1, 'partly invalid file is backed up before being rewritten');
    assert.equal(await fs.readFile(path.join(dir, backups[0]!), 'utf8'), original);
    store.dispose();
  });

  it('keeps the last good config when the file is externally broken, and recovers when fixed', async () => {
    const dir = await tmpDir();
    const store = new UserConfigStore(dir, recordingLogger().logger);
    await store.set({ monthlyBudget: 77 });
    const fired: UserConfig[] = [];
    store.onDidChange((c) => fired.push(c));

    const bad = '{ "monthlyBudget": 1, ';
    await fs.writeFile(path.join(dir, 'config.json'), bad, 'utf8');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(store.get().monthlyBudget, 77, 'last good config survives a broken edit');
    assert.equal(fired.length, 0);
    assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), bad, 'file not clobbered');

    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ monthlyBudget: 3 }), 'utf8');
    assert.ok(await waitFor(() => store.get().monthlyBudget === 3), 'fixed file is picked up');
    store.dispose();
  });

  it('drops only the invalid rule, keeping its valid siblings and every other block', async () => {
    const dir = await tmpDir();
    const original = JSON.stringify({
      monthlyBudget: 42,
      rules: [
        { id: 'good-1', severity: 'warning', message: 'a', when: true },
        { id: 'bad', severity: 'not-a-severity', message: 'b', when: true },
        { id: 'good-2', severity: 'critical', message: 'c', when: true },
      ],
    });
    await fs.writeFile(path.join(dir, 'config.json'), original, 'utf8');
    const { logger, warnings } = recordingLogger();
    const store = new UserConfigStore(dir, logger);

    assert.equal(store.get().monthlyBudget, 42);
    assert.deepEqual(store.get().rules?.map((r) => r.id), ['good-1', 'good-2']);
    assert.ok(warnings.some((w) => w.includes('rules[1] ("bad")')), warnings.join('|'));
    assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), original, 'file untouched');

    await store.set({ monthlyBudget: 43 });
    const backups = await listBackups(dir);
    assert.equal(backups.length, 1, 'the dropped rule survives in the backup');
    assert.equal(await fs.readFile(path.join(dir, backups[0]!), 'utf8'), original);
    store.dispose();
  });

  it('keeps the last good value of a block that an external edit invalidates', async () => {
    const dir = await tmpDir();
    const store = new UserConfigStore(dir, recordingLogger().logger);
    await store.set({ rules: [{ id: 'r1', severity: 'warning', message: 'm', when: true }] });
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ monthlyBudget: 8, rules: 'broken' }),
      'utf8',
    );
    assert.ok(await waitFor(() => store.get().monthlyBudget === 8));
    assert.equal(store.get().rules?.[0]?.id, 'r1', 'rules keep their last good value');
    store.dispose();
  });

  it('a non-object JSON document is treated as unusable, not as an empty config', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'config.json'), '[1,2,3]', 'utf8');
    const store = new UserConfigStore(dir, recordingLogger().logger);
    assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), '[1,2,3]');
    await store.set({ monthlyBudget: 1 });
    assert.equal((await listBackups(dir)).length, 1);
    store.dispose();
  });

  it('reset() is an explicit wipe: it does not leave a backup behind', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'config.json'), '{oops', 'utf8');
    const store = new UserConfigStore(dir, recordingLogger().logger);
    await store.reset();
    assert.deepEqual(await listBackups(dir), []);
    store.dispose();
  });
});

describe('UserConfigStore — writes and watching', () => {
  it('writes atomically: no temp file is left behind', async () => {
    const dir = await tmpDir();
    const store = new UserConfigStore(dir);
    await store.set({ monthlyBudget: 9 });
    const files = await fs.readdir(dir);
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
    assert.ok(files.includes('config.json'));
    store.dispose();
  });

  it('detects an external edit that lands right after our own write (no 500ms blind window)', async () => {
    const dir = await tmpDir();
    const store = new UserConfigStore(dir);
    await store.set({ monthlyBudget: 1 });
    const fired: UserConfig[] = [];
    store.onDidChange((c) => fired.push(c));

    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ monthlyBudget: 99 }), 'utf8');
    assert.ok(
      await waitFor(() => fired.some((c) => c.monthlyBudget === 99)),
      'edit within the old suppress window is seen',
    );
    store.dispose();
  });

  it('does not re-fire onDidChange for its own write', async () => {
    const dir = await tmpDir();
    const store = new UserConfigStore(dir);
    const fired: UserConfig[] = [];
    store.onDidChange((c) => fired.push(c));
    await store.set({ monthlyBudget: 4 });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(fired.length, 1, 'only the set() notification, no watcher echo');
    store.dispose();
  });

  it('keeps watching after an editor-style atomic save (write temp + rename over config.json)', async () => {
    const dir = await tmpDir();
    const store = new UserConfigStore(dir);
    const fired: UserConfig[] = [];
    store.onDidChange((c) => fired.push(c));

    for (const budget of [10, 20]) {
      const tmp = path.join(dir, `editor-${budget}.swp`);
      await fs.writeFile(tmp, JSON.stringify({ monthlyBudget: budget }), 'utf8');
      await fs.rename(tmp, path.join(dir, 'config.json'));
      assert.ok(
        await waitFor(() => fired.some((c) => c.monthlyBudget === budget)),
        `save #${budget} detected (a file-level watcher goes blind after the first rename)`,
      );
    }
    store.dispose();
  });
});
