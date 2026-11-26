import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCodeConnector } from '../../../src/extension-backend/ingest/ClaudeCodeConnector';
import { NoopFsWatcher } from '../../../src/extension-backend/ingest/IFsWatcher';
import type { ParseContext } from '../../../src/extension-backend/ingest/otelParse';
import { parseTimestamp } from '../../../src/extension-backend/ingest/connectorUtils';
import type { PricingService } from '../../../src/extension-backend/pricing/PricingService';
import { EventStore } from '../../../src/extension-backend/store/EventStore';

/**
 * End-to-end ingest through a real DuckDB `read_ndjson` over temp files — the
 * path the unit tests with a mocked connection cannot see (type inference,
 * session TimeZone, SQL watermark filter, streamed-message dedupe).
 */

const NO_WORKSPACE = { resolve: () => undefined };
const PRICING = { pricePerCredit: 0.04, currentManifest: undefined, tokenPrices: undefined } as unknown as PricingService;

/** Connector pointed at a temp dir instead of ~/.claude/projects. */
class TempDirConnector extends ClaudeCodeConnector {
  constructor(store: EventStore, private readonly dir: string) {
    super(PRICING, store.meta, store.fileReader, NO_WORKSPACE, new NoopFsWatcher());
  }
  protected override async discover(): Promise<{ globs: string[]; allowedRoots: string[]; searchedDirs: string[] }> {
    return { globs: [path.join(this.dir, '**', '*.jsonl')], allowedRoots: [this.dir], searchedDirs: [this.dir] };
  }
}

interface StoredEvent {
  id: string;
  ts: number;
  surface: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number;
  branch: string | null;
  attribution: string | null;
}

async function storedEvents(store: EventStore): Promise<StoredEvent[]> {
  const res = await store.conn.runAndReadAll(
    'SELECT id, ts, surface, promptTokens, completionTokens, cost, branch, attribution FROM events ORDER BY ts, id',
  );
  return res.getRowObjectsJson().map((r) => ({
    id: String(r['id']),
    ts: Number(r['ts']),
    surface: String(r['surface']),
    promptTokens: r['promptTokens'] == null ? null : Number(r['promptTokens']),
    completionTokens: r['completionTokens'] == null ? null : Number(r['completionTokens']),
    cost: Number(r['cost']),
    branch: r['branch'] == null ? null : String(r['branch']),
    attribution: r['attribution'] == null ? null : String(r['attribution']),
  }));
}

function line(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

function assistant(over: Record<string, unknown> & { message?: Record<string, unknown> }): Record<string, unknown> {
  const { message, ...rest } = over;
  return {
    type: 'assistant',
    timestamp: '2026-01-01T12:00:00.123Z',
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000001',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      ...message,
    },
    ...rest,
  };
}

async function withTz<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['TZ'];
  process.env['TZ'] = tz;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['TZ'];
    else process.env['TZ'] = prev;
  }
}

async function withStore<T>(fn: (store: EventStore, dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-ndjson-'));
  const logs = path.join(root, 'logs');
  await fs.mkdir(logs);
  const store = await EventStore.open(path.join(root, 'db'));
  try {
    return await fn(store, logs);
  } finally {
    store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const EPOCH = Date.parse('2026-01-01T12:00:00.123Z');

describe('ingest through real DuckDB read_ndjson', () => {
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland']) {
    describe(`TZ=${tz}`, () => {
      it('stores the UTC instant of an ISO "Z" timestamp, not a UTC-offset-shifted one', async () => {
        await withTz(tz, () => withStore(async (store, dir) => {
          await fs.writeFile(path.join(dir, 's.jsonl'), line(assistant({})) + '\n');
          await new TempDirConnector(store, dir).start();
          const [ev] = await storedEvents(store);
          assert.equal(ev!.ts, EPOCH);
        }));
      });

      it('applies the watermark filter on the same instants (no off-by-offset skips or re-reads of older rows)', async () => {
        await withTz(tz, () => withStore(async (store, dir) => {
          const file = path.join(dir, 's.jsonl');
          const at = (iso: string, id: string) =>
            line(assistant({ timestamp: iso, requestId: id, message: { id } })) + '\n';
          await fs.writeFile(
            file,
            at('2026-01-01T11:00:00.000Z', 'before') + at('2026-01-01T12:00:00.123Z', 'edge') + at('2026-01-01T13:00:00.000Z', 'after'),
          );
          const seen: string[] = [];
          const ctx: ParseContext = { pricePerCredit: 0.04, now: Date.now() };
          await store.fileReader.ingestGlob(
            [file.replace(/\\/g, '/')],
            (row) => { seen.push(String((row['message'] as { id: string }).id)); return null; },
            ctx,
            EPOCH,
          );
          // At or after the watermark instant, whatever the host zone: the row
          // exactly at the watermark is re-read (a later row can share its
          // millisecond; inserts dedupe by id) and the earlier row is not.
          assert.deepEqual(seen, ['edge', 'after']);
        }));
      });

      it('parseTimestamp reads a naive DuckDB-style timestamp as UTC', async () => {
        await withTz(tz, async () => {
          assert.equal(parseTimestamp({ timestamp: '2026-01-01 12:00:00.123' }), EPOCH);
          assert.equal(parseTimestamp({ timestamp: '2026-01-01T12:00:00.123' }), EPOCH);
          assert.equal(parseTimestamp({ timestamp: '2026-01-01T14:00:00.123+02:00' }), EPOCH);
          assert.equal(parseTimestamp({ timestamp: '2026-01-01 04:00:00.123-08' }), EPOCH);
        });
      });
    });
  }

  it('collapses a streamed message and a resumed-session replay into one row with max usage', async () => {
    await withStore(async (store, dir) => {
      const first = assistant({ timestamp: '2026-01-01T12:00:00.000Z', uuid: 'u1' });
      const second = assistant({
        timestamp: '2026-01-01T12:00:01.000Z',
        uuid: 'u2',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
          usage: { input_tokens: 10, output_tokens: 42 },
        },
      });
      const third = assistant({ timestamp: '2026-01-01T12:00:02.000Z', uuid: 'u3', message: { usage: { input_tokens: 10, output_tokens: 20 } } });
      await fs.writeFile(path.join(dir, 'a.jsonl'), [first, second, third].map(line).join('\n') + '\n');
      // Resumed session: same history replayed under a new sessionId in a new file.
      const replay = [first, second, third].map((l) => ({ ...l, sessionId: 'bbbbbbbb-0000-0000-0000-000000000002' }));
      await fs.writeFile(path.join(dir, 'b.jsonl'), replay.map(line).join('\n') + '\n');

      const connector = new TempDirConnector(store, dir);
      await connector.start();
      const events = await storedEvents(store);
      assert.equal(events.length, 1, 'one API message is one row');
      const ev = events[0]!;
      assert.equal(ev.id, 'claude-code:msg_1:req_1', 'id is message.id:requestId — no session in it');
      assert.equal(ev.promptTokens, 10);
      assert.equal(ev.completionTokens, 42, 'max of the cumulative usage');
      assert.equal(ev.surface, 'agent', 'a tool_use block in any line makes the message agent work');
      // Cost is priced from the merged (max) tokens, not the first line's.
      const priced = 10 * 3e-6 + 42 * 15e-6;
      assert.ok(Math.abs(ev.cost - priced) < 1e-12, `cost ${ev.cost} should be ${priced}`);

      // A later ingest of the same lines is ignored, not double counted.
      await connector.start();
      assert.equal((await storedEvents(store)).length, 1);
    });
  });

  it('skips <synthetic> and zero-token lines, uses gitBranch authoritatively, and derives surface per row', async () => {
    await withStore(async (store, dir) => {
      const lines = [
        assistant({ requestId: 'r_synth', message: { id: 'm_synth', model: '<synthetic>' } }),
        assistant({ requestId: 'r_zero', message: { id: 'm_zero', usage: { input_tokens: 0, output_tokens: 0 } } }),
        assistant({ requestId: 'r_chat', message: { id: 'm_chat' }, gitBranch: 'feature/x', timestamp: '2026-01-01T12:00:01.000Z' }),
        assistant({ requestId: 'r_side', message: { id: 'm_side' }, isSidechain: true, timestamp: '2026-01-01T12:00:02.000Z' }),
        // A user line whose content is a plain string next to array-content lines
        // (forces DuckDB to type `message.content` heterogeneously).
        { type: 'user', timestamp: '2026-01-01T12:00:03.000Z', message: { role: 'user', content: 'hello' } },
      ];
      await fs.writeFile(path.join(dir, 's.jsonl'), lines.map(line).join('\n') + '\n');
      await new TempDirConnector(store, dir).start();
      const byId = new Map((await storedEvents(store)).map((e) => [e.id, e]));
      assert.deepEqual([...byId.keys()].sort(), ['claude-code:m_chat:r_chat', 'claude-code:m_side:r_side']);
      const chat = byId.get('claude-code:m_chat:r_chat')!;
      assert.equal(chat.surface, 'chat');
      assert.equal(chat.branch, 'feature/x');
      assert.equal(chat.attribution, 'authoritative');
      assert.equal(byId.get('claude-code:m_side:r_side')!.surface, 'agent');
    });
  });

  it('prices from the bundled Claude list prices, never the Copilot credit multiplier, without a price feed', async () => {
    await withStore(async (store, dir) => {
      await fs.writeFile(
        path.join(dir, 's.jsonl'),
        line(assistant({ message: { usage: { input_tokens: 1_000_000, output_tokens: 0 } } })) + '\n',
      );
      await new TempDirConnector(store, dir).start();
      const [ev] = await storedEvents(store);
      // claude-sonnet-4.5 = 6 Copilot credits × $0.04 = $0.24 under the old fallback;
      // Anthropic's list price for 1M input tokens is $3.
      assert.ok(Math.abs(ev!.cost - 3) < 1e-9, `cost ${ev!.cost}`);
    });
  });
});
