import { strict as assert } from 'assert';
import { ClaudeCodeConnector } from '../../../src/extension-backend/ingest/ClaudeCodeConnector';
import { WorkspaceFolderMatcher } from '../../../src/extension-backend/ingest/WorkspaceFolderMatcher';
import type { IWorkspaceFolderMatcher } from '../../../src/extension-backend/ingest/WorkspaceFolderMatcher';
import type { ParseContext } from '../../../src/extension-backend/ingest/otelParse';
import type { PricingService } from '../../../src/extension-backend/pricing/PricingService';
import type { IMetaStore as MetaStore } from '../../../src/extension-backend/store/MetaStore';
import type { DuckDBFileReader } from '../../../src/extension-backend/store/DuckDBFileReader';

const noopMatcher: IWorkspaceFolderMatcher = { resolve: () => undefined };

const now = new Date('2026-01-15T10:00:00.000Z').getTime();

function makeConnector(matcher?: IWorkspaceFolderMatcher): ClaudeCodeConnector {
  const pricing = { pricePerCredit: 0.04, currentManifest: undefined } as unknown as PricingService;
  const meta = { get: async () => null, set: async () => {} } as MetaStore;
  const fileReader = {} as DuckDBFileReader;
  return new ClaudeCodeConnector(pricing, meta, fileReader, matcher ?? noopMatcher);
}

function makeConnectorWithHasField(hasFieldResult: boolean): ClaudeCodeConnector {
  const pricing = { pricePerCredit: 0.04, currentManifest: undefined } as unknown as PricingService;
  const meta = { get: async () => null, set: async () => {} } as MetaStore;
  const fileReader = { hasField: async () => hasFieldResult } as unknown as DuckDBFileReader;
  return new ClaudeCodeConnector(pricing, meta, fileReader, noopMatcher);
}

type BuildContext = (g: string[], watermarkMs?: number | null) => Promise<ParseContext>;

function makeCtx(overrides?: Partial<ParseContext>): ParseContext {
  return { pricePerCredit: 0.04, now, ...overrides };
}

function makeLine(overrides: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50 } },
    timestamp: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('ClaudeCodeConnector — lifecycle', () => {
  it('watermarkKey returns "claude-code:watermark"', () => {
    const connector = makeConnector();
    assert.equal(
      (connector as unknown as { watermarkKey: string }).watermarkKey,
      'claude-code:watermark',
    );
  });

  it('discover() returns an object with globs/allowedRoots/searchedDirs arrays', async () => {
    const connector = makeConnector();
    const result = await (connector as unknown as {
      discover(): Promise<{ globs: string[]; allowedRoots: string[]; searchedDirs: string[] }>;
    }).discover();
    assert.ok(Array.isArray(result.globs));
    assert.ok(Array.isArray(result.allowedRoots));
    assert.ok(Array.isArray(result.searchedDirs));
  });

  it('buildContext() sets no global surface — it is derived per row (the old hasField pre-scan never matched)', async () => {
    for (const hasField of [true, false]) {
      const connector = makeConnectorWithHasField(hasField);
      const ctx = await (connector as unknown as { buildContext: BuildContext }).buildContext([]);
      assert.equal(ctx.surface, undefined);
    }
  });

  it('buildContext() honours the watermark: liveThresholdMs only exists once one is set', async () => {
    const connector = makeConnector();
    const build = (connector as unknown as { buildContext: BuildContext }).buildContext.bind(connector);
    assert.equal((await build([], null)).liveThresholdMs, undefined, 'backfill pass: nothing is live');
    const live = await build([], 1_700_000_000_000);
    assert.ok(live.liveThresholdMs !== undefined && live.liveThresholdMs <= Date.now(), 'steady state: window is open');
  });
});

describe('ClaudeCodeConnector — folder attribution', () => {
  function makeFolderConnector(folders: Array<{ name: string; fsPath: string }>) {
    const pricing = { pricePerCredit: 0.04, currentManifest: undefined } as unknown as PricingService;
    const meta = { get: async () => null, set: async () => {} } as MetaStore;
    const fileReader = {} as DuckDBFileReader;
    const vscodeFolders = folders.map((f) => ({
      name: f.name,
      uri: { fsPath: f.fsPath },
    })) as unknown as ReadonlyArray<import('vscode').WorkspaceFolder>;
    const matcher = new WorkspaceFolderMatcher(() => vscodeFolders);
    return new ClaudeCodeConnector(pricing, meta, fileReader, matcher);
  }

  const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  it('mapRow() uses folder name as repo when the session cwd is inside a folder', () => {
    const connector = makeFolderConnector([{ name: 'myproject', fsPath: '/home/user/myproject' }]);
    const result = connector.mapRow(
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
        timestamp: '2026-01-15T10:00:00.000Z',
        sessionId: UUID,
        cwd: '/home/user/myproject/src',
      },
      makeCtx(),
    );
    assert.ok(result);
    assert.equal(result.repo, 'myproject');
  });

  it('mapRow() picks the most specific folder for nested multi-root workspaces', () => {
    const connector = makeFolderConnector([
      { name: 'outer', fsPath: '/home/user/outer' },
      { name: 'inner', fsPath: '/home/user/outer/inner' },
    ]);
    const result = connector.mapRow(
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
        timestamp: '2026-01-15T10:00:00.000Z',
        sessionId: UUID,
        cwd: '/home/user/outer/inner/pkg',
      },
      makeCtx(),
    );
    assert.ok(result);
    assert.equal(result.repo, 'inner');
  });

  describe('attribution liveness', () => {
    const ISO = '2026-01-15T10:00:00.000Z';
    const TS = Date.parse(ISO);

    it('marks cwd-resolved repos authoritative even on backfill (no liveThresholdMs)', () => {
      const connector = makeFolderConnector([{ name: 'myproject', fsPath: '/home/user/myproject' }]);
      const result = connector.mapRow(
        {
          type: 'assistant',
          message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
          timestamp: ISO,
          sessionId: UUID,
          cwd: '/home/user/myproject/sub',
        },
        makeCtx({ repo: 'ctx-repo', branch: 'main' }),
      );
      assert.equal(result?.repo, 'myproject');
      assert.equal(result?.attribution, 'authoritative');
      // branch is always heuristic — never applied to backfill rows.
      assert.equal(result?.branch, undefined);
    });

    it('marks the ctx fallback heuristic, live rows only', () => {
      const connector = makeFolderConnector([{ name: 'myproject', fsPath: '/home/user/myproject' }]);
      const line = {
        type: 'assistant',
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
        timestamp: ISO,
        sessionId: UUID,
        cwd: '/elsewhere',
      };
      const live = connector.mapRow(line, makeCtx({ repo: 'ctx-repo', branch: 'main', liveThresholdMs: TS - 1000 }));
      assert.equal(live?.repo, 'ctx-repo');
      assert.equal(live?.attribution, 'heuristic');
      assert.equal(live?.branch, 'main');

      const backfill = connector.mapRow(line, makeCtx({ repo: 'ctx-repo', branch: 'main' }));
      assert.equal(backfill?.repo, undefined);
      assert.equal(backfill?.attribution, undefined);
      assert.equal(backfill?.branch, undefined);
    });
  });

  it('applies the active-editor language to live rows only (logs carry none)', () => {
    const connector = makeFolderConnector([{ name: 'myproject', fsPath: '/home/user/myproject' }]);
    const iso = '2026-01-15T10:00:00.000Z';
    const line = {
      type: 'assistant',
      message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
      timestamp: iso,
      sessionId: UUID,
      cwd: '/home/user/myproject',
    };
    const live = connector.mapRow(line, makeCtx({ language: 'rust', liveThresholdMs: Date.parse(iso) - 1 }));
    assert.equal(live?.language, 'rust');
    const backfill = connector.mapRow(line, makeCtx({ language: 'rust' }));
    assert.equal(backfill?.language, undefined);
  });

  it('mapRow() falls back to ctx.repo when the cwd is outside every folder', () => {
    const connector = makeFolderConnector([{ name: 'myproject', fsPath: '/home/user/myproject' }]);
    const result = connector.mapRow(
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
        timestamp: '2026-01-15T10:00:00.000Z',
        sessionId: UUID,
        cwd: '/home/user/other',
      },
      makeCtx({ repo: 'ctx-repo', liveThresholdMs: 0 }),
    );
    assert.ok(result);
    assert.equal(result.repo, 'ctx-repo');
  });

  it('mapRow() skips folder matching when cwd is absent', () => {
    const connector = makeFolderConnector([{ name: 'myproject', fsPath: '/tmp/x' }]);
    const result = connector.mapRow(
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
        timestamp: '2026-01-15T10:00:00.000Z',
        sessionId: UUID,
      },
      makeCtx({ repo: 'fallback', liveThresholdMs: 0 }),
    );
    assert.ok(result);
    assert.equal(result.repo, 'fallback');
  });

  it('mapRow() returns empty folders list (getFolders returns [])', () => {
    const pricing = { pricePerCredit: 0.04, currentManifest: undefined } as unknown as PricingService;
    const meta = { get: async () => null, set: async () => {} } as MetaStore;
    const fileReader = {} as DuckDBFileReader;
    const matcher = new WorkspaceFolderMatcher(() => []);
    const connector = new ClaudeCodeConnector(pricing, meta, fileReader, matcher);
    const result = connector.mapRow(
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
        timestamp: '2026-01-15T10:00:00.000Z',
        sessionId: UUID,
        cwd: '/home/user/myproject',
      },
      makeCtx({ repo: 'fallback', liveThresholdMs: 0 }),
    );
    assert.ok(result);
    assert.equal(result.repo, 'fallback');
  });
});

describe('ClaudeCodeConnector.mapRow()', () => {
  it('returns null for non-assistant rows', () => {
    const connector = makeConnector();
    assert.equal(connector.mapRow({ type: 'user', message: 'hello' }, makeCtx()), null);
  });

  it('returns null when usage is absent', () => {
    const connector = makeConnector();
    const result = connector.mapRow(
      { type: 'assistant', message: { model: 'claude-sonnet-4' }, timestamp: '2026-01-15T10:00:00.000Z' },
      makeCtx(),
    );
    assert.equal(result, null);
  });

  it('returns null when model is absent', () => {
    const connector = makeConnector();
    const result = connector.mapRow(
      { type: 'assistant', usage: { input_tokens: 10, output_tokens: 5 }, timestamp: '2026-01-15T10:00:00.000Z' },
      makeCtx(),
    );
    assert.equal(result, null);
  });

  it('extracts model and tokens', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx());
    assert.ok(result);
    assert.equal(result.modelId, 'claude-sonnet-4');
    assert.equal(result.source, 'claude-code');
    assert.equal(result.promptTokens, 100);
    assert.equal(result.completionTokens, 50);
  });

  it('gives two same-session/model/ms turns distinct ids via uuid', () => {
    const connector = makeConnector();
    const sessionId = 'abcd1234-0000-0000-0000-000000000000';
    const a = connector.mapRow(makeLine({ sessionId, uuid: 'uuid-a' }), makeCtx());
    const b = connector.mapRow(makeLine({ sessionId, uuid: 'uuid-b' }), makeCtx());
    assert.ok(a && b);
    assert.notEqual(a.id, b.id, 'distinct uuids must yield distinct ids');
  });

  it('reuses the same id for the same uuid (re-ingest dedups)', () => {
    const connector = makeConnector();
    const line = makeLine({ sessionId: 'abcd1234', uuid: 'stable-uuid' });
    const first = connector.mapRow(line, makeCtx());
    const second = connector.mapRow(line, makeCtx());
    assert.ok(first && second);
    assert.equal(first.id, second.id);
  });

  it('falls back to requestId when uuid is absent', () => {
    const connector = makeConnector();
    const a = connector.mapRow(makeLine({ requestId: 'req-1' }), makeCtx());
    const b = connector.mapRow(makeLine({ requestId: 'req-2' }), makeCtx());
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
  });

  it('uses top-level usage when usage is not inside message', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', model: 'claude-haiku-4', usage: { input_tokens: 80, output_tokens: 40 }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.ok(result);
    assert.equal(result.modelId, 'claude-haiku-4');
  });

  it('uses model from row level when not in message', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', model: 'claude-opus-4', message: { usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.ok(result);
    assert.equal(result.modelId, 'claude-opus-4');
  });

  it('skips rows with an unparseable timestamp (would mis-bucket into "now")', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({ timestamp: 'garbage' }), makeCtx());
    assert.equal(result, null);
  });

  it('skips rows whose timestamp is an object', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({ timestamp: { value: 1 } }), makeCtx());
    assert.equal(result, null);
  });

  it('handles numeric timestamp', () => {
    const connector = makeConnector();
    const ts = 1700000000000;
    const result = connector.mapRow(makeLine({ timestamp: ts }), makeCtx());
    assert.ok(result);
    assert.equal(result.ts, ts);
  });

  it('uses message-level timestamp when no top-level timestamp', () => {
    const connector = makeConnector();
    const row = {
      type: 'assistant',
      message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 }, timestamp: '2026-01-15T10:00:00.000Z' },
    };
    const result = connector.mapRow(row, makeCtx());
    assert.ok(result);
    assert.ok(result.ts > 0);
  });

  it('includes repo from ctx', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx({ repo: 'org/repo', liveThresholdMs: 0 }));
    assert.equal(result?.repo, 'org/repo');
  });

  it('includes branch from ctx', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx({ branch: 'main', liveThresholdMs: 0 }));
    assert.equal(result?.branch, 'main');
  });

  it('uses ctx.surface (agent) from context pre-scan', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx({ surface: 'agent' }));
    assert.equal(result?.surface, 'agent');
  });

  it('derives surface per row when ctx.surface is absent: plain reply is chat', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx());
    assert.equal(result?.surface, 'chat');
  });

  it('respects ctx.surface = "chat"', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx({ surface: 'chat' }));
    assert.equal(result?.surface, 'chat');
  });

  it('skips a line with no token counts (nothing to count)', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', model: 'claude-sonnet-4', usage: {}, timestamp: '2026-01-15T10:00:00.000Z' };
    assert.equal(connector.mapRow(row, makeCtx()), null);
  });

  it('omits costByCategory when the model has no known price (cost 0, not a credit-based guess)', () => {
    const connector = makeConnector();
    const result = connector.mapRow(
      { type: 'assistant', message: { model: 'mystery-model', usage: { input_tokens: 100, output_tokens: 50 } }, timestamp: '2026-01-15T10:00:00.000Z' },
      makeCtx(),
    );
    assert.equal(result?.cost, 0);
    assert.equal(result?.costByCategory, undefined);
  });

  it('converts string token values via num()', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: '100', output_tokens: '50' } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.equal(result?.promptTokens, 100);
    assert.equal(result?.completionTokens, 50);
  });

  it('rejects negative token counts — stored as undefined', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: -100, output_tokens: 50 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.equal(result?.promptTokens, undefined);
    assert.equal(result?.completionTokens, 50);
  });

  it('parses cache_creation_input_tokens', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.equal(result?.cacheCreationTokens, 200);
  });

  it('parses cache_read_input_tokens', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3000 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.equal(result?.cacheReadTokens, 3000);
  });

  it('parses thinking_tokens', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 80 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.equal(result?.thinkingTokens, 80);
  });

  it('leaves cache/thinking tokens absent when not in usage', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx());
    assert.equal(result?.cacheCreationTokens, undefined);
    assert.equal(result?.cacheReadTokens, undefined);
    assert.equal(result?.thinkingTokens, undefined);
  });

  it('includes cache_creation in costByCategory when present', () => {
    const manifest = { version: 1 as const, pricePerCredit: 0.04, updatedAt: '2026-01-01', models: { 'claude-sonnet-4': 1 } };
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx({ manifest }));
    assert.ok(result?.costByCategory?.['cache_creation'] !== undefined);
    assert.ok(result?.costByCategory?.['input'] !== undefined);
  });

  it('includes cache_read in costByCategory when present', () => {
    const manifest = { version: 1 as const, pricePerCredit: 0.04, updatedAt: '2026-01-01', models: { 'claude-sonnet-4': 1 } };
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3000 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx({ manifest }));
    assert.ok(result?.costByCategory?.['cache_read'] !== undefined);
  });

  it('includes thinking in costByCategory when present', () => {
    const manifest = { version: 1 as const, pricePerCredit: 0.04, updatedAt: '2026-01-01', models: { 'claude-sonnet-4': 1 } };
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 80 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx({ manifest }));
    assert.ok(result?.costByCategory?.['thinking'] !== undefined);
  });

  it('applies manifest multiplier from ctx', () => {
    const manifest = { version: 1 as const, pricePerCredit: 0.04, updatedAt: '2026-01-01', models: { 'claude-sonnet-4': 2 } };
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx({ manifest }));
    assert.ok(result);
    assert.equal(result.credits, 2);
  });

  it('includes sessionId in event id for uniqueness', () => {
    const connector = makeConnector();
    const sessionId = 'abc12345-0000-0000-0000-deadbeef1234';
    const result = connector.mapRow(makeLine({ sessionId }), makeCtx());
    assert.ok(result);
    assert.ok(result.id.includes('ef1234:'), 'event id should include last 8 chars of sessionId');
  });

  it('falls back to "cc" in id when sessionId is absent', () => {
    const connector = makeConnector();
    const result = connector.mapRow(makeLine({}), makeCtx());
    assert.ok(result);
    assert.ok(result.id.startsWith('claude-code:cc:'));
  });

  it('covers splitCost when only output tokens exist', () => {
    const connector = makeConnector();
    const row = { type: 'assistant', message: { model: 'claude-sonnet-4', usage: { output_tokens: 50 } }, timestamp: '2026-01-15T10:00:00.000Z' };
    const result = connector.mapRow(row, makeCtx());
    assert.ok(result?.costByCategory?.['output'] !== undefined);
  });
});

describe('ClaudeCodeConnector.mapRow() — streamed messages, surface, branch, cost', () => {
  const ISO = '2026-01-15T10:00:00.000Z';
  const withMsg = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    timestamp: ISO,
    message: { model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 50 }, ...message },
    ...extra,
  });

  it('keys the id on message.id + requestId, independent of session and uuid (resumed history is not double counted)', () => {
    const connector = makeConnector();
    const a = connector.mapRow(withMsg({ id: 'msg_1' }, { requestId: 'req_1', sessionId: 'aaaaaaaa-1', uuid: 'u1' }), makeCtx());
    const b = connector.mapRow(withMsg({ id: 'msg_1' }, { requestId: 'req_1', sessionId: 'bbbbbbbb-2', uuid: 'u2' }), makeCtx());
    assert.ok(a && b);
    assert.equal(a.id, 'claude-code:msg_1:req_1');
    assert.equal(b.id, a.id);
    const c = connector.mapRow(withMsg({ id: 'msg_2' }, { requestId: 'req_1' }), makeCtx());
    assert.notEqual(c?.id, a.id);
  });

  it('uses message.id alone when the line has no requestId', () => {
    const connector = makeConnector();
    assert.equal(connector.mapRow(withMsg({ id: 'msg_9' }), makeCtx())?.id, 'claude-code:msg_9');
  });

  it('skips <synthetic> model lines and lines with zero total tokens', () => {
    const connector = makeConnector();
    assert.equal(connector.mapRow(withMsg({ model: '<synthetic>' }), makeCtx()), null);
    assert.equal(
      connector.mapRow(withMsg({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }), makeCtx()),
      null,
    );
    assert.ok(connector.mapRow(withMsg({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 7 } }), makeCtx()));
  });

  describe('surface per row', () => {
    const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} };
    it('tool_use content is agent work', () => {
      const connector = makeConnector();
      const r = connector.mapRow(withMsg({ content: [{ type: 'text', text: 'ok' }, toolUse] }), makeCtx());
      assert.equal(r?.surface, 'agent');
    });
    it('sidechain (sub-agent) lines are agent work', () => {
      const connector = makeConnector();
      assert.equal(connector.mapRow(withMsg({}, { isSidechain: true }), makeCtx())?.surface, 'agent');
    });
    it('plain text replies are chat', () => {
      const connector = makeConnector();
      const r = connector.mapRow(withMsg({ content: [{ type: 'text', text: 'hello' }] }, { isSidechain: false }), makeCtx());
      assert.equal(r?.surface, 'chat');
    });
    it('reads block arrays that DuckDB surfaced as a JSON string', () => {
      const connector = makeConnector();
      const r = connector.mapRow(withMsg({ content: JSON.stringify([toolUse]) }), makeCtx());
      assert.equal(r?.surface, 'agent');
      assert.equal(connector.mapRow(withMsg({ content: 'plain text' }), makeCtx())?.surface, 'chat');
      assert.equal(connector.mapRow(withMsg({ content: '[not json' }), makeCtx())?.surface, 'chat');
    });
  });

  describe('gitBranch', () => {
    it('is the authoritative branch, valid for backfill rows too', () => {
      const connector = makeConnector();
      const r = connector.mapRow(withMsg({}, { gitBranch: 'feature/login' }), makeCtx({ branch: 'heuristic-branch' }));
      assert.equal(r?.branch, 'feature/login');
      assert.equal(r?.attribution, 'authoritative');
    });
    it('beats the live heuristic branch', () => {
      const connector = makeConnector();
      const r = connector.mapRow(withMsg({}, { gitBranch: 'a' }), makeCtx({ branch: 'b', liveThresholdMs: 0 }));
      assert.equal(r?.branch, 'a');
    });
    it('keeps a heuristic repo marked heuristic even with a line branch', () => {
      const connector = makeConnector();
      const r = connector.mapRow(withMsg({}, { gitBranch: 'a' }), makeCtx({ repo: 'ctx-repo', liveThresholdMs: 0 }));
      assert.equal(r?.repo, 'ctx-repo');
      assert.equal(r?.attribution, 'heuristic');
    });
  });

  describe('cost', () => {
    const tokens = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    it('uses the feed price when it knows the model', () => {
      const connector = makeConnector();
      const r = connector.mapRow(
        withMsg({ model: 'claude-opus-4-5-20251101', usage: tokens }),
        makeCtx({ tokenPrices: { 'claude-opus-4-5': { input: 5e-6, output: 25e-6 } } }),
      );
      assert.ok(Math.abs(r!.cost - 30) < 1e-9);
    });
    it('without a feed, estimates from Claude list prices — never credits × pricePerCredit', () => {
      const connector = makeConnector();
      const r = connector.mapRow(withMsg({ model: 'claude-opus-4-5-20251101', usage: tokens }), makeCtx());
      // 15 Copilot credits × $0.04 would be $0.60; Anthropic's list price is $5 + $25.
      assert.ok(Math.abs(r!.cost - 30) < 1e-9, `cost ${r!.cost}`);
      assert.equal(r!.estimated, true);
      assert.ok(r!.cost !== r!.credits * 0.04);
    });
    it('falls back to the list prices when the feed lacks the model', () => {
      const connector = makeConnector();
      const r = connector.mapRow(
        withMsg({ model: 'claude-sonnet-4-5', usage: tokens }),
        makeCtx({ tokenPrices: { 'gpt-4o': { input: 1e-6, output: 1e-6 } } }),
      );
      assert.ok(Math.abs(r!.cost - 18) < 1e-9, `cost ${r!.cost}`);
    });
  });

  describe('mergeDuplicate()', () => {
    const merge = (a: ReturnType<ClaudeCodeConnector['mapRow']>, b: ReturnType<ClaudeCodeConnector['mapRow']>) =>
      (makeConnector() as unknown as {
        mergeDuplicate(x: NonNullable<typeof a>, y: NonNullable<typeof b>, ctx: ParseContext): NonNullable<typeof a>;
      }).mergeDuplicate(a!, b!, makeCtx());

    it('keeps the max per usage field, the later ts, agent if any line is, and re-prices from the merge', () => {
      const connector = makeConnector();
      const first = connector.mapRow(withMsg({ id: 'm', usage: { input_tokens: 100, output_tokens: 5 } }, { requestId: 'r' }), makeCtx());
      const second = connector.mapRow(
        withMsg(
          { id: 'm', usage: { input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 300 }, content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
          { requestId: 'r', timestamp: '2026-01-15T10:00:05.000Z' },
        ),
        makeCtx(),
      );
      const merged = merge(first, second);
      assert.equal(merged.promptTokens, 100);
      assert.equal(merged.completionTokens, 80);
      assert.equal(merged.cacheReadTokens, 300);
      assert.equal(merged.ts, Date.parse('2026-01-15T10:00:05.000Z'));
      assert.equal(merged.surface, 'agent');
      const expected = 100 * 3e-6 + 80 * 15e-6 + 300 * 0.3e-6;
      assert.ok(Math.abs(merged.cost - expected) < 1e-12);
      assert.ok(merged.costByCategory?.['cache_read'] !== undefined);
    });

    it('is order-independent for usage (a smaller later line cannot shrink it)', () => {
      const connector = makeConnector();
      const big = connector.mapRow(withMsg({ id: 'm', usage: { input_tokens: 10, output_tokens: 90 } }, { requestId: 'r' }), makeCtx());
      const small = connector.mapRow(withMsg({ id: 'm', usage: { input_tokens: 10, output_tokens: 20 } }, { requestId: 'r' }), makeCtx());
      assert.equal(merge(big, small).completionTokens, 90);
      assert.equal(merge(small, big).completionTokens, 90);
    });

    it('drops a stale costByCategory when the merged message cannot be priced (unknown model: cost 0, no breakdown)', () => {
      const connector = makeConnector();
      const mystery = (outputTokens: number) =>
        connector.mapRow(
          { type: 'assistant', requestId: 'r', message: { id: 'm', model: 'mystery-model', usage: { input_tokens: 10, output_tokens: outputTokens } }, timestamp: '2026-01-15T10:00:00.000Z' },
          makeCtx(),
        );
      const first = mystery(5)!;
      const kept = { ...first, costByCategory: { input: 123 } };
      const merged = merge(kept, mystery(50));
      assert.equal(merged.completionTokens, 50);
      assert.equal(merged.cost, 0);
      assert.equal('costByCategory' in merged, false, 'the breakdown of the earlier pricing must not survive the re-pricing');
    });
  });
});
