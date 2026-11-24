import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FanoutMetricExporter,
  MetricExporter,
  NullMetricExporter,
  type Exporter,
  type MetricProtocol,
  type MetricSerializer,
} from '../../src/extension-backend/export/MetricExporter';
import { ExportQueue, deleteQueueFiles, queueFileFor } from '../../src/extension-backend/export/ExportQueue';
import { buildStreamBatch } from '../../src/extension-backend/export/payload';
import { makeEvent } from './helpers';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-export-rel-'));
}

const serializer: MetricSerializer = { topic: 't', serialize: (b) => ({ n: b.sent_at }) };
const batch = (n: number) => ({ ...buildStreamBatch([makeEvent({ ts: Date.now() - 1000 })]), sent_at: n });

describe('MetricExporter — dispose() mid-send does not silently drop the in-flight batch', () => {
  it('queues the batch when the send fails retryably because the exporter was disposed under it', async () => {
    const dir = await tmpDir();
    const queue = new ExportQueue(dir, 'q.json');
    const holder: { exporter?: MetricExporter } = {};
    const protocol: MetricProtocol = {
      async send() {
        holder.exporter!.dispose(); // e.g. the exporter is rebuilt while a publish is in flight
        return { ok: false, retryable: true };
      },
      dispose() {},
    };
    holder.exporter = new MetricExporter(protocol, serializer, queue);
    await holder.exporter.export(batch(1));
    assert.deepEqual(queue.peekAll().map((e) => e.payload), [{ n: 1 }]);
  });

  it('does not queue a batch whose send succeeded before the dispose', async () => {
    const dir = await tmpDir();
    const queue = new ExportQueue(dir, 'q.json');
    const holder: { exporter?: MetricExporter } = {};
    const protocol: MetricProtocol = {
      async send() {
        holder.exporter!.dispose();
        return { ok: true };
      },
      dispose() {},
    };
    holder.exporter = new MetricExporter(protocol, serializer, queue);
    await holder.exporter.export(batch(1));
    assert.deepEqual(queue.peekAll(), []);
  });

  it('queues the new batch (instead of dropping it) when disposed while flushing the backlog', async () => {
    const dir = await tmpDir();
    const queue = new ExportQueue(dir, 'q.json');
    queue.enqueue('t', { n: 0 });
    const holder: { exporter?: MetricExporter } = {};
    const sent: unknown[] = [];
    const protocol: MetricProtocol = {
      async send(_t, payload) {
        sent.push(payload);
        holder.exporter!.dispose();
        return { ok: true };
      },
      dispose() {},
    };
    holder.exporter = new MetricExporter(protocol, serializer, queue);
    await holder.exporter.export(batch(7));
    assert.deepEqual(sent, [{ n: 0 }], 'no send attempted on the torn-down protocol');
    assert.ok(queue.peekAll().some((e) => (e.payload as { n: number }).n === 7), 'new batch kept');
  });
});

describe('Exporter interface', () => {
  const b = batch(1);

  it('NullMetricExporter and FanoutMetricExporter implement it without being MetricExporters', async () => {
    const exporters: Exporter[] = [new NullMetricExporter(), new FanoutMetricExporter([new NullMetricExporter()])];
    for (const e of exporters) {
      assert.equal(e instanceof MetricExporter, false, 'no fake protocol/serializer base class');
      await e.export(b);
      e.dispose();
    }
  });

  it('a fanout holds any Exporter, including another fanout', async () => {
    const seen: number[] = [];
    const leaf: Exporter = { export: async (x) => void seen.push(x.sent_at), dispose() {} };
    const nested = new FanoutMetricExporter([new FanoutMetricExporter([leaf]), leaf]);
    await nested.export(b);
    assert.deepEqual(seen, [1, 1]);
  });
});

describe('ExportQueue — hardening', () => {
  it('drops malformed entries on read and keeps the valid ones', async () => {
    const dir = await tmpDir();
    const good = { id: 'a', topic: 't', payload: { n: 1 }, enqueuedAt: 5 };
    await fs.writeFile(
      path.join(dir, 'q.json'),
      JSON.stringify([
        good,
        null,
        42,
        'str',
        { id: 'b', topic: 't', payload: null, enqueuedAt: 5 },
        { id: 'c', topic: 't', payload: [1], enqueuedAt: 5 },
        { id: 'd', topic: 7, payload: {}, enqueuedAt: 5 },
        { topic: 't', payload: {}, enqueuedAt: 5 },
        { id: 'e', topic: 't', payload: {}, enqueuedAt: 'now' },
        { id: 'f', topic: 't', payload: {}, enqueuedAt: 6 },
      ]),
      'utf8',
    );
    const queue = new ExportQueue(dir, 'q.json');
    assert.deepEqual(queue.peekAll().map((e) => e.id), ['a', 'f']);
  });

  it('caps an oversized on-disk queue at the newest 500 entries', async () => {
    const dir = await tmpDir();
    const entries = Array.from({ length: 520 }, (_, i) => ({ id: `id${i}`, topic: 't', payload: { i }, enqueuedAt: i }));
    await fs.writeFile(path.join(dir, 'q.json'), JSON.stringify(entries), 'utf8');
    const all = new ExportQueue(dir, 'q.json').peekAll();
    assert.equal(all.length, 500);
    assert.equal(all[0]!.id, 'id20');
  });
});

describe('queueFileFor — collision-free queue file names', () => {
  it('keeps the historical names for the primary target and for clean names', () => {
    assert.equal(queueFileFor(undefined), 'export-queue.json');
    assert.equal(queueFileFor('team'), 'export-queue-team.json');
    assert.equal(queueFileFor('Team.v2-a_b'), 'export-queue-Team.v2-a_b.json');
  });

  it('gives names that need sanitising a hash so they cannot collide with another name', () => {
    const names = ['a/b', 'a_b', 'a b', 'a\\b', 'a:b', 'a/b '];
    const files = names.map(queueFileFor);
    assert.equal(new Set(files).size, names.length, files.join(', '));
    for (const f of files) assert.match(f, /^export-queue-[A-Za-z0-9._-]+\.json$/);
  });

  it('is deterministic', () => {
    assert.equal(queueFileFor('a/b'), queueFileFor('a/b'));
  });
});

describe('deleteQueueFiles', () => {
  it('removes every export-queue*.json (primary and per-target) and nothing else', async () => {
    const dir = await tmpDir();
    for (const f of ['export-queue.json', 'export-queue-team.json', queueFileFor('a/b'), 'config.json', 'events.duckdb', 'export-queue.txt']) {
      await fs.writeFile(path.join(dir, f), '[]', 'utf8');
    }
    const removed = deleteQueueFiles(dir);
    assert.equal(removed.length, 3);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['config.json', 'events.duckdb', 'export-queue.txt']);
  });

  it('tolerates a missing directory', () => {
    assert.deepEqual(deleteQueueFiles(path.join(os.tmpdir(), 'mallard-no-such-dir-xyz')), []);
  });
});
