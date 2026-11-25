/**
 * Generates the committed golden fixtures under test/golden/fixtures/.
 *
 * Everything here is MADE-UP data (no real user logs): a synthetic Claude Code
 * project tree, Copilot OTel NDJSON spans and a Copilot span SQLite DB, plus
 * the frozen pricing inputs. The files are committed; this script exists so
 * the data stays reviewable and regenerable:
 *
 *     npx tsx test/golden/generate-fixtures.ts
 *
 * `fixtureTextFiles()` is also asserted byte-for-byte against the committed
 * files in test/unit/golden/fixtures.test.ts, so editing a fixture by hand (or
 * this generator without regenerating) fails the suite.
 *
 * Time is chosen so every golden zone (UTC, America/Los_Angeles, Asia/Kolkata,
 * Australia/Lord_Howe, Pacific/Auckland, Pacific/Chatham) sees: local-midnight
 * month edges (2026-02-01), DST transitions (LA 2026-03-08 and 2026-11-01,
 * Auckland/Chatham 2026-04-05 and 2026-09-27, Lord Howe 2026-04-05 and
 * 2026-10-04), a dense recent fortnight (2026-10-18 .. 2026-11-01, plus a few hours of 2026-11-02), and
 * events older than a year relative to that fortnight.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

export const FIXTURES_DIR = path.join(__dirname, 'fixtures');

type Json = Record<string, unknown>;

// ── Time helpers ──────────────────────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();
const at = (s: string): number => Date.parse(s);
const nano = (ms: number): string => String(BigInt(ms) * 1_000_000n);

// ── Claude Code session lines ─────────────────────────────────────────────────

interface AsstOpts {
  session: string;
  ts: string;
  model: string;
  uuid: string;
  usage: Json;
  content?: unknown[];
  cwd?: string;
  branch?: string | undefined;
  msgId?: string;
  reqId?: string;
  sidechain?: boolean;
}

let uuidCounter = 0;
const nextUuid = (): string => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
};

const TEXT = (t: string): unknown => ({ type: 'text', text: t });
const THINK = (t: string): unknown => ({ type: 'thinking', thinking: t, signature: 'sig' });
const TOOL = (n: string): unknown => ({ type: 'tool_use', id: `toolu_${n}`, name: n, input: { arg: n } });

function usage(input: number, output: number, cacheCreation?: number, cacheRead?: number, extra: Json = {}): Json {
  return {
    input_tokens: input,
    ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreation } : {}),
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    output_tokens: output,
    ...extra,
    service_tier: 'standard',
  };
}

function asst(o: AsstOpts): Json {
  return {
    parentUuid: null,
    isSidechain: o.sidechain ?? false,
    userType: 'external',
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    sessionId: o.session,
    version: '2.0.31',
    ...(o.branch !== undefined ? { gitBranch: o.branch } : {}),
    type: 'assistant',
    message: {
      ...(o.msgId !== undefined ? { id: o.msgId } : {}),
      type: 'message',
      role: 'assistant',
      model: o.model,
      content: o.content ?? [TEXT('ok')],
      stop_reason: null,
      usage: o.usage,
    },
    ...(o.reqId !== undefined ? { requestId: o.reqId } : {}),
    uuid: o.uuid,
    timestamp: o.ts,
  };
}

function userStr(session: string, ts: string, text: string, cwd: string): Json {
  return { parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: session, version: '2.0.31', type: 'user', message: { role: 'user', content: text }, uuid: nextUuid(), timestamp: ts };
}
function userArr(session: string, ts: string, cwd: string): Json {
  return {
    parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: session, version: '2.0.31', type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_Bash', type: 'tool_result', content: 'done', is_error: false }] },
    uuid: nextUuid(), timestamp: ts,
  };
}

const SONNET45 = 'claude-sonnet-4-5-20250929';
const OPUS45 = 'claude-opus-4-5-20251101';
const HAIKU45 = 'claude-haiku-4-5-20251001';
const SONNET4 = 'claude-sonnet-4-20250514';
const HAIKU35 = 'claude-3-5-haiku-20241022';
const SONNET35 = 'claude-3-5-sonnet-20241022';
const SONNET37 = 'claude-3-7-sonnet-20250219';
const OPUS41 = 'claude-opus-4-1-20250805';
const BEDROCK = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const FABLE = 'claude-fable-9';

const S_A1 = 'aaaaaaaa-1111-4111-8111-000000000001';
const S_A2 = 'aaaaaaaa-1111-4111-8111-000000000002';
const S_B1 = 'bbbbbbbb-2222-4222-8222-000000000001';
const S_B2 = 'bbbbbbbb-2222-4222-8222-000000000002';
const S_B3 = 'bbbbbbbb-2222-4222-8222-000000000003';
const S_G1 = 'cccccccc-3333-4333-8333-000000000001';

const P_A1 = '-work-alpha/aaaaaaaa-1111-4111-8111-000000000001.jsonl';
const P_A2 = '-work-alpha/aaaaaaaa-1111-4111-8111-000000000002.jsonl';
const P_B1 = '-work-beta/bbbbbbbb-2222-4222-8222-000000000001.jsonl';
const P_B2 = '-work-beta/bbbbbbbb-2222-4222-8222-000000000002.jsonl';
const P_B3 = '-work-beta/bbbbbbbb-2222-4222-8222-000000000003.jsonl';
const P_G1 = '-work-gamma/cccccccc-3333-4333-8333-000000000001.jsonl';

/** Local midnight of 2026-02-01 as a UTC instant, per golden zone. */
const FEB1_MIDNIGHT: Array<[string, string]> = [
  ['LA', '2026-02-01T08:00:00.000Z'],
  ['UTC', '2026-02-01T00:00:00.000Z'],
  ['Kolkata', '2026-01-31T18:30:00.000Z'],
  ['LordHowe', '2026-01-31T13:00:00.000Z'],
  ['Auckland', '2026-01-31T11:00:00.000Z'],
  ['Chatham', '2026-01-31T10:15:00.000Z'],
];

type FileMap = Map<string, string[]>;
function push(files: FileMap, file: string, ...lines: string[]): void {
  const cur = files.get(file) ?? [];
  cur.push(...lines);
  files.set(file, cur);
}
const J = (o: Json): string => JSON.stringify(o);

/** The Claude tree (pass 1) and the lines/bytes appended before pass 2. */
function claudeFiles(): { pass1: Map<string, string>; pass2: Map<string, string> } {
  uuidCounter = 0;
  const f1: FileMap = new Map();
  const f2: FileMap = new Map();
  const raw1 = new Map<string, string>(); // exact-text overrides (unterminated files)
  const raw2 = new Map<string, string>();

  // ── Session A1: alpha, plain cwd ────────────────────────────────────────────
  const A = '/work/alpha';
  push(f1, P_A1, J(userStr(S_A1, '2025-02-10T09:14:00.000Z', 'hello', A)));
  // Older than a year relative to the recent fortnight: outside the 365-day default range.
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2025-02-10T09:15:00.000Z', model: SONNET35, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_m01', reqId: 'req_m01', usage: usage(1200, 300) })));
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2025-06-20T14:00:00.000Z', model: SONNET37, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_m02', reqId: 'req_m02', usage: usage(2000, 500, 1000, 4000) })));
  // New-year edge in UTC: tool_use makes it agent work; cache creation/read tokens.
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2025-12-31T23:30:00.000Z', model: OPUS45, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_m03', reqId: 'req_m03', content: [TEXT('plan'), TOOL('Edit')], usage: usage(3000, 900, 500, 7000) })));
  push(f1, P_A1, J(userArr(S_A1, '2025-12-31T23:30:05.000Z', A)));
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2026-01-01T00:15:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_m04', reqId: 'req_m04', usage: usage(800, 250) })));
  // Streamed message: three lines, same message.id + requestId, cumulative usage growing, thinking -> text -> tool_use.
  const streamIds = { msgId: 'msg_stream1', reqId: 'req_stream1' };
  const streamLines = [
    asst({ session: S_A1, ts: '2026-01-12T10:00:00.000Z', model: OPUS45, uuid: nextUuid(), cwd: A, branch: 'feature/x', ...streamIds, content: [THINK('hmm')], usage: usage(2500, 1, 800, 12000) }),
    asst({ session: S_A1, ts: '2026-01-12T10:00:01.100Z', model: OPUS45, uuid: nextUuid(), cwd: A, branch: 'feature/x', ...streamIds, content: [TEXT('Looking at it')], usage: usage(2500, 45, 800, 12000) }),
    asst({ session: S_A1, ts: '2026-01-12T10:00:03.200Z', model: OPUS45, uuid: nextUuid(), cwd: A, branch: 'feature/x', ...streamIds, content: [TOOL('Read')], usage: usage(2500, 210, 800, 12000) }),
  ];
  push(f1, P_A1, ...streamLines.map(J));
  // Thinking-style usage field next to the standard ones.
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2026-01-12T11:00:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'feature/x', msgId: 'msg_m05', reqId: 'req_m05', content: [THINK('deep'), TEXT('answer')], usage: usage(1100, 600, undefined, undefined, { thinking_tokens: 400 }) })));
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2026-01-12T11:30:00.000Z', model: OPUS45, uuid: nextUuid(), cwd: A, branch: 'feature/x', msgId: 'msg_m05b', reqId: 'req_m05b', usage: usage(300, 80, undefined, undefined, { output_thinking_tokens: 120, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } }) })));
  // Sidechain sub-agent turn on haiku; the feed prices haiku-4.5 without a cache-read rate.
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2026-01-20T16:45:10.000Z', model: HAIKU45, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_m06', reqId: 'req_m06', sidechain: true, content: [TOOL('Grep')], usage: usage(5000, 700, 0, 20000) })));
  // No message.id / requestId: ids fall back to session suffix + ts + model + uuid.
  const sameMs = '2026-01-21T09:00:00.000Z';
  push(f1, P_A1, J(asst({ session: S_A1, ts: sameMs, model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'main', usage: usage(120, 40) })));
  push(f1, P_A1, J(asst({ session: S_A1, ts: sameMs, model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'main', usage: usage(130, 45) })));
  const noUuid = asst({ session: S_A1, ts: '2026-01-21T09:30:00.000Z', model: HAIKU45, uuid: 'x', cwd: A, usage: usage(60, 20) });
  delete noUuid['uuid'];
  push(f1, P_A1, J(noUuid));
  // A garbage line mid-file: DuckDB's ignore_errors drops it.
  push(f1, P_A1, 'this is not json {{{');
  push(f1, P_A1, J({ type: 'summary', summary: 'A short session', leafUuid: nextUuid() }));
  // Message whose later lines only arrive in the NEXT ingest pass (partial-usage gap).
  push(f1, P_A1, J(asst({ session: S_A1, ts: '2026-11-02T04:50:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_late', reqId: 'req_late', content: [TEXT('starting')], usage: usage(900, 5) })));
  push(f2, P_A1,
    J(asst({ session: S_A1, ts: '2026-11-02T04:50:02.000Z', model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_late', reqId: 'req_late', content: [TOOL('Bash')], usage: usage(900, 180) })),
    J(asst({ session: S_A1, ts: '2026-11-02T04:50:04.000Z', model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_late', reqId: 'req_late', content: [TEXT('done')], usage: usage(900, 400) })),
    // A new id with a timestamp older than the watermark: skipped by the SQL watermark filter forever.
    J(asst({ session: S_A1, ts: '2026-01-02T10:00:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: A, branch: 'main', msgId: 'msg_old_late', reqId: 'req_old_late', usage: usage(77, 33) })),
  );

  // ── Session A2: resumed session (replay under a new sessionId) + month-edge rows ──
  const replay = (l: Json): Json => ({ ...l, sessionId: S_A2 });
  push(f1, P_A2, ...streamLines.map((l) => J(replay(l))));
  push(f1, P_A2, J(replay(asst({ session: S_A1, ts: '2025-12-31T23:30:00.000Z', model: OPUS45, uuid: 'x', cwd: A, branch: 'main', msgId: 'msg_m03', reqId: 'req_m03', content: [TEXT('plan'), TOOL('Edit')], usage: usage(3000, 900, 500, 7000) }))));
  const UI = '/work/alpha/packages/ui'; // nested folder: longest workspace folder wins
  FEB1_MIDNIGHT.forEach(([zone, t], i) => {
    push(f1, P_A2, J(asst({ session: S_A2, ts: t, model: i % 2 ? HAIKU45 : SONNET45, uuid: nextUuid(), cwd: UI, branch: i % 3 ? 'main' : 'feature/x', msgId: `msg_edge_${zone}`, reqId: `req_edge_${zone}`, usage: usage(100 + i, 20 + i) })));
  });

  // ── Session B1: beta ────────────────────────────────────────────────────────
  const B = '/work/beta';
  const b1 = (ts: string, model: string, n: string, u: Json, extra: Partial<AsstOpts> = {}): void =>
    push(f1, P_B1, J(asst({ session: S_B1, ts, model, uuid: nextUuid(), cwd: B, branch: 'fix/y', msgId: `msg_${n}`, reqId: `req_${n}`, usage: u, ...extra })));
  b1('2026-02-03T14:00:00.000Z', SONNET4, 'b01', usage(1500, 400));
  b1('2026-02-10T08:00:00.000Z', SONNET45, 'b02', usage(900, 300), { content: [TOOL('Write')] });
  b1('2026-02-10T08:05:00.000Z', HAIKU35, 'b03', usage(700, 120, 200, 900));
  b1('2026-02-14T12:00:00.000Z', FABLE, 'b04', usage(400, 100)); // unknown to manifest and to both price tables
  b1('2026-03-02T10:30:00.000Z', BEDROCK, 'b05', usage(2200, 650, 0, 3000));
  b1('2026-03-05T09:00:00.000Z', OPUS41, 'b06', usage(1800, 500, 300, 2500), { content: [TOOL('Task')] });
  // US spring-forward day (LA: 10:00Z is the 02:00 -> 03:00 gap).
  b1('2026-03-08T09:30:00.000Z', SONNET45, 'b07', usage(310, 90));
  b1('2026-03-08T09:59:59.999Z', HAIKU45, 'b08', usage(320, 91));
  b1('2026-03-08T10:00:00.000Z', SONNET45, 'b09', usage(330, 92));
  b1('2026-03-08T10:30:00.000Z', OPUS45, 'b10', usage(340, 93));
  // Southern-hemisphere DST end (2026-04-05 local; the repeated hour in Auckland/Lord Howe/Chatham).
  b1('2026-04-04T13:30:00.000Z', SONNET45, 'b11', usage(350, 94));
  b1('2026-04-04T14:30:00.000Z', SONNET45, 'b12', usage(360, 95));
  b1('2026-04-04T14:45:00.000Z', HAIKU45, 'b13', usage(370, 96));
  b1('2026-04-04T15:15:00.000Z', HAIKU45, 'b14', usage(380, 97));
  // Southern-hemisphere DST start.
  b1('2026-09-26T13:30:00.000Z', SONNET45, 'b15', usage(390, 98));
  b1('2026-09-26T14:30:00.000Z', SONNET45, 'b16', usage(400, 99));
  b1('2026-10-03T15:15:00.000Z', HAIKU45, 'b17', usage(410, 100));
  b1('2026-10-03T15:45:00.000Z', HAIKU45, 'b18', usage(420, 101));
  // US DST end: 01:30 happens twice in LA.
  b1('2026-11-01T08:30:00.000Z', OPUS45, 'b19', usage(430, 102));
  b1('2026-11-01T09:30:00.000Z', OPUS45, 'b20', usage(440, 103));

  // ── Session G1: gamma (cwd is not a workspace folder) ──────────────────────────
  const G = '/work/gamma';
  const g1 = (ts: string, model: string, n: string, u: Json, extra: Partial<AsstOpts> = {}): void =>
    push(f1, P_G1, J(asst({ session: S_G1, ts, model, uuid: nextUuid(), cwd: G, msgId: `msg_${n}`, reqId: `req_${n}`, usage: u, ...extra })));
  g1('2026-03-15T10:00:00.000Z', SONNET45, 'g01', usage(500, 150), { branch: 'main' }); // branch only -> authoritative, no repo
  g1('2026-03-15T10:10:00.000Z', SONNET45, 'g02', usage(510, 151)); // neither branch nor repo -> unattributed
  // Skipped lines: synthetic model, zero tokens, no usage block at all.
  push(f1, P_G1, J(asst({ session: S_G1, ts: '2026-03-15T10:20:00.000Z', model: '<synthetic>', uuid: nextUuid(), cwd: G, msgId: 'msg_synth', reqId: 'req_synth', usage: usage(0, 0) })));
  push(f1, P_G1, J(asst({ session: S_G1, ts: '2026-03-15T10:30:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: G, msgId: 'msg_zero', reqId: 'req_zero', usage: usage(0, 0, 0, 0) })));
  const noUsage = asst({ session: S_G1, ts: '2026-03-15T10:40:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: G, msgId: 'msg_nousage', reqId: 'req_nousage', usage: {} });
  delete (noUsage['message'] as Json)['usage'];
  push(f1, P_G1, J(noUsage));
  // OTel-ish row with model + usage at the top level (no `message` object).
  push(f1, P_G1, J({ type: 'assistant', sessionId: S_G1, cwd: G, model: HAIKU45, usage: { input_tokens: 250, output_tokens: 60 }, timestamp: '2026-03-16T08:00:00.000Z', uuid: nextUuid() }));

  // ── Dense recent fortnight (alpha / beta / gamma), 2 messages a day ─────────────
  const projects: Array<[string, string, string, string]> = [
    [P_A1, S_A1, '/work/alpha', 'main'],
    [P_B2, S_B2, '/work/beta', 'feature/x'],
    [P_A2, S_A2, '/work/alpha', 'fix/y'],
    [P_B3, S_B3, '/work/beta', 'main'],
  ];
  const models = [SONNET45, OPUS45, HAIKU45, SONNET45, HAIKU35, SONNET4];
  const day0 = at('2026-10-18T00:00:00.000Z');
  for (let d = 0, i = 0; d < 15; d++) {
    for (const hour of [9, 15]) {
      const [file, session, cwd, branch] = projects[i % projects.length]!;
      const ts = iso(day0 + d * 86_400_000 + hour * 3_600_000 + (d * 7 + i) * 60_000);
      const tool = i % 3 === 0;
      const side = i % 5 === 0;
      const n = `d${String(i).padStart(2, '0')}`;
      push(f1, file, J(asst({
        session, ts, model: models[i % models.length]!, uuid: nextUuid(), cwd, branch: i % 7 === 6 ? undefined : branch,
        msgId: `msg_${n}`, reqId: `req_${n}`, sidechain: side, content: tool ? [TOOL('Bash')] : [TEXT('x')],
        usage: usage(400 + 137 * i, 80 + 53 * i, i % 4 === 0 ? 200 + i : undefined, i % 4 === 1 ? 5000 + 90 * i : undefined),
      })));
      i++;
    }
  }
  // Last line of the fortnight is complete JSON with NO trailing newline, and a later pass finishes it.
  const unterminated = J(asst({ session: S_B3, ts: '2026-11-02T04:00:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: B, branch: 'main', msgId: 'msg_unterm', reqId: 'req_unterm', usage: usage(640, 160) }));
  raw1.set(P_B3, `${(f1.get(P_B3) ?? []).join('\n')}\n${unterminated}`);
  raw2.set(P_B3, `\n${J(asst({ session: S_B3, ts: '2026-11-02T04:10:00.000Z', model: SONNET45, uuid: nextUuid(), cwd: B, branch: 'main', msgId: 'msg_afterterm', reqId: 'req_afterterm', usage: usage(650, 161) }))}\n`);
  f1.delete(P_B3);

  // A file whose last line is cut mid-write; pass 2 delivers the rest of that line plus another.
  const cutLine = J(asst({ session: S_B1, ts: '2026-11-02T04:30:00.000Z', model: HAIKU45, uuid: nextUuid(), cwd: B, branch: 'main', msgId: 'msg_cut', reqId: 'req_cut', content: [TEXT('a long answer that was cut off mid write')], usage: usage(700, 170) }));
  const cutAt = cutLine.indexOf('long answer') + 4;
  push(f1, P_B1, J(asst({ session: S_B1, ts: '2026-11-02T04:20:00.000Z', model: HAIKU45, uuid: nextUuid(), cwd: B, branch: 'main', msgId: 'msg_precut', reqId: 'req_precut', usage: usage(690, 169) })));
  raw1.set(P_B1, `${(f1.get(P_B1) ?? []).join('\n')}\n${cutLine.slice(0, cutAt)}`);
  raw2.set(P_B1, `${cutLine.slice(cutAt)}\n${J(asst({ session: S_B1, ts: '2026-11-02T04:35:00.000Z', model: HAIKU45, uuid: nextUuid(), cwd: B, branch: 'main', msgId: 'msg_postcut', reqId: 'req_postcut', usage: usage(710, 171) }))}\n`);
  f1.delete(P_B1);

  // Live rows (pass 2 only): no cwd and no gitBranch, so the active-editor heuristic applies when "live".
  const ingestNow2 = at('2026-11-02T06:30:00.000Z');
  push(f2, P_G1,
    J(asst({ session: S_G1, ts: iso(ingestNow2 - 2 * 60_000), model: SONNET45, uuid: nextUuid(), msgId: 'msg_live1', reqId: 'req_live1', usage: usage(220, 60) })), // live: heuristic repo/branch/language
    J(asst({ session: S_G1, ts: iso(ingestNow2 - 10 * 60_000), model: SONNET45, uuid: nextUuid(), msgId: 'msg_notlive', reqId: 'req_notlive', usage: usage(230, 61) })), // 10 min old: not live
    J(asst({ session: S_G1, ts: iso(ingestNow2 - 1 * 60_000), model: OPUS45, uuid: nextUuid(), cwd: '/work/alpha', branch: 'main', msgId: 'msg_live2', reqId: 'req_live2', usage: usage(240, 62) })), // live with cwd: authoritative repo, heuristic language
  );

  const out1 = new Map<string, string>();
  const out2 = new Map<string, string>();
  for (const [file, lines] of f1) out1.set(file, `${lines.join('\n')}\n`);
  for (const [file, text] of raw1) out1.set(file, text);
  for (const [file, lines] of f2) out2.set(file, `${lines.join('\n')}\n`);
  for (const [file, text] of raw2) out2.set(file, text);
  return { pass1: out1, pass2: out2 };
}

// ── Copilot OTel spans ────────────────────────────────────────────────────────

interface Span {
  name: string;
  id?: string;
  ms?: number;
  model?: string;
  input?: number;
  output?: number;
  extra?: Record<string, string | number>;
}

function otlpAttrs(s: Span): unknown[] {
  const attrs: unknown[] = [];
  if (s.model !== undefined) attrs.push({ key: 'gen_ai.request.model', value: { stringValue: s.model } });
  if (s.input !== undefined) attrs.push({ key: 'gen_ai.usage.input_tokens', value: { intValue: String(s.input) } });
  if (s.output !== undefined) attrs.push({ key: 'gen_ai.usage.output_tokens', value: { intValue: String(s.output) } });
  for (const [k, v] of Object.entries(s.extra ?? {})) attrs.push({ key: k, value: typeof v === 'number' ? { doubleValue: v } : { stringValue: v } });
  return attrs;
}

function otlpLine(s: Span): string {
  return J({
    traceId: 'trace-0001',
    ...(s.id !== undefined ? { spanId: s.id } : {}),
    name: s.name,
    kind: 3,
    ...(s.ms !== undefined ? { startTimeUnixNano: nano(s.ms), endTimeUnixNano: nano(s.ms + 900) } : {}),
    attributes: otlpAttrs(s),
  });
}

function copilotOtel(): { pass1: string; pass2: string } {
  const spans: Span[] = [];
  const dayMs = at('2026-10-18T00:00:00.000Z');
  // Month-edge spans one millisecond BEFORE each zone's local midnight of 2026-02-01.
  FEB1_MIDNIGHT.forEach(([zone, t], i) => spans.push({ name: i % 2 ? 'chat' : 'inline_completion', id: `edge-${zone}`, ms: at(t) - 1, model: i % 2 ? 'gpt-4.1' : 'gpt-4o', input: 90 + i, output: 15 + i }));
  // Model spellings: dotted/dashed, dated, unknown, no tokens, zero tokens, no model, no timestamp.
  spans.push(
    { name: 'chat', id: 'sp-001', ms: at('2026-01-05T10:00:00.000Z'), model: 'gpt-4.1', input: 1200, output: 300 },
    { name: 'invoke_agent', id: 'sp-002', ms: at('2026-01-05T10:01:00.000Z'), model: 'claude-sonnet-4.5', input: 5000, output: 900 },
    { name: 'chat', id: 'sp-003', ms: at('2026-01-05T10:02:00.000Z'), model: 'claude-opus-4.5', input: 4000, output: 800 },
    { name: 'edit_file', id: 'sp-004', ms: at('2026-01-06T09:00:00.000Z'), model: 'gpt-5-mini', input: 2000, output: 400, extra: { 'gen_ai.request.language': 'python' } },
    { name: 'chat', id: 'sp-005', ms: at('2026-01-06T09:05:00.000Z'), model: 'gemini-2.5-pro', input: 3000, output: 700 },
    { name: 'chat', id: 'sp-006', ms: at('2026-01-06T09:10:00.000Z'), model: 'o3-mini', input: 800, output: 200 }, // not in the price feed: credit-multiplier cost + 2-way split
    { name: 'chat', id: 'sp-007', ms: at('2026-01-06T09:15:00.000Z'), model: 'mystery-model-x', input: 500, output: 100 }, // unknown model
    { name: 'chat', id: 'sp-008', ms: at('2026-01-06T09:20:00.000Z'), model: 'gpt-4.1', input: 0, output: 0 }, // zero tokens, still a request
    { name: 'chat', id: 'sp-009', ms: at('2026-01-06T09:25:00.000Z'), model: 'claude-sonnet-4.5' }, // no usage attributes at all
    { name: 'execute_tool', id: 'sp-010', ms: at('2026-01-07T09:00:00.000Z'), model: 'gpt-4o', input: 100, output: 20 },
    { name: 'chat', id: 'sp-011', ms: at('2026-01-07T09:30:00.000Z'), input: 100, output: 20 }, // no model: skipped
    { name: 'chat', id: 'sp-012', model: 'gpt-4o', input: 100, output: 20 }, // no timestamp: skipped
    { name: 'chat', id: 'sp-001', ms: at('2026-01-05T10:00:00.000Z'), model: 'gpt-4.1', input: 9999, output: 9999 }, // duplicate span id: first wins
    { name: 'inline_completion', ms: at('2026-01-08T11:00:00.000Z'), model: 'gpt-4o', input: 40, output: 8 }, // no span id: ts+model id
    { name: 'inline_completion', ms: at('2026-01-08T11:00:00.000Z'), model: 'gpt-4o', input: 41, output: 9 }, // same ts+model: collides on that id
    { name: 'chat', id: 'sp-old', ms: at('2025-03-03T12:00:00.000Z'), model: 'gpt-4.1', input: 700, output: 200 }, // older than a year
    // DST edges.
    { name: 'chat', id: 'sp-dst-la1', ms: at('2026-03-08T09:59:59.999Z'), model: 'gpt-4.1', input: 110, output: 22 },
    { name: 'chat', id: 'sp-dst-la2', ms: at('2026-03-08T10:00:00.000Z'), model: 'gpt-4.1', input: 111, output: 23 },
    { name: 'chat', id: 'sp-dst-s1', ms: at('2026-04-04T13:59:59.999Z'), model: 'gpt-4o', input: 120, output: 24 },
    { name: 'chat', id: 'sp-dst-s2', ms: at('2026-04-04T14:00:00.000Z'), model: 'gpt-4o', input: 121, output: 25 },
    { name: 'chat', id: 'sp-dst-s3', ms: at('2026-04-04T15:00:00.000Z'), model: 'gpt-4o', input: 122, output: 26 },
    { name: 'chat', id: 'sp-dst-n1', ms: at('2026-09-26T13:59:59.999Z'), model: 'gpt-5-mini', input: 130, output: 27 },
    { name: 'chat', id: 'sp-dst-n2', ms: at('2026-09-26T14:00:00.000Z'), model: 'gpt-5-mini', input: 131, output: 28 },
    { name: 'chat', id: 'sp-dst-lh', ms: at('2026-10-03T15:30:00.000Z'), model: 'gpt-5-mini', input: 132, output: 29 },
    { name: 'chat', id: 'sp-dst-la3', ms: at('2026-11-01T08:59:59.999Z'), model: 'gpt-4.1', input: 133, output: 30 },
    { name: 'chat', id: 'sp-dst-la4', ms: at('2026-11-01T09:00:00.000Z'), model: 'gpt-4.1', input: 134, output: 31 },
  );
  // Dense recent fortnight.
  const dense = ['gpt-4.1', 'gpt-4o', 'claude-sonnet-4.5', 'gpt-5-mini', 'gemini-2.5-pro', 'o3-mini', 'claude-opus-4.5'];
  const names = ['chat', 'invoke_agent', 'inline_completion', 'edit_file', 'chat', 'execute_tool'];
  for (let d = 0, i = 0; d < 15; d++) {
    for (const hour of [10, 13, 20]) {
      if ((d + hour) % 4 === 0) continue; // a few quiet slots
      spans.push({ name: names[i % names.length]!, id: `dense-${String(i).padStart(2, '0')}`, ms: dayMs + d * 86_400_000 + hour * 3_600_000 + i * 30_000, model: dense[i % dense.length]!, input: 300 + 41 * i, output: 60 + 17 * i });
      i++;
    }
  }
  const ingestNow2 = at('2026-11-02T06:30:00.000Z');
  const pass2: Span[] = [
    { name: 'chat', id: 'live-001', ms: ingestNow2 - 60_000, model: 'gpt-4.1', input: 180, output: 40, extra: { 'gen_ai.request.language': 'go' } }, // live, row language wins
    { name: 'invoke_agent', id: 'live-002', ms: ingestNow2 - 90_000, model: 'claude-sonnet-4.5', input: 800, output: 150 }, // live: heuristic repo/branch/language
    { name: 'chat', id: 'live-003', ms: ingestNow2 - 9 * 60_000, model: 'gpt-4o', input: 90, output: 10 }, // not live
    { name: 'chat', id: 'sp-002', ms: at('2026-01-05T10:01:00.000Z'), model: 'claude-sonnet-4.5', input: 5000, output: 900 }, // replay of an earlier span (older than the watermark)
  ];
  return {
    pass1: `${spans.map(otlpLine).join('\n')}\n`,
    pass2: `${pass2.map(otlpLine).join('\n')}\n`,
  };
}

/** Copilot spans whose attributes are an OTLP-style map (and an ISO `timestamp` instead of nanos). */
function copilotMap(): string {
  const rows: Json[] = [
    { name: 'chat', spanId: 'map-001', timestamp: '2026-03-01T10:00:00.000Z', attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 250 } },
    { name: 'invoke_agent', spanId: 'map-002', timestamp: '2026-03-01T10:05:00.000Z', attributes: { 'gen_ai.request.model': 'claude-sonnet-4.5', 'gen_ai.usage.input_tokens': 2000, 'gen_ai.usage.output_tokens': 500 } },
    { name: 'chat', spanId: 'map-003', timestamp: '2026-03-02 08:30:00.250', attributes: { 'gen_ai.request.model': 'gpt-4.1', 'gen_ai.usage.input_tokens': 150, 'gen_ai.usage.output_tokens': 30 } }, // naive (zone-less) timestamp is UTC
    { name: 'chat', spanId: 'map-004', timestamp: '2026-03-02T21:30:00.000-08:00', attributes: { 'gen_ai.request.model': 'gpt-4.1', 'gen_ai.usage.input_tokens': 160, 'gen_ai.usage.output_tokens': 31 } }, // offset timestamp
    { name: 'chat', spanId: 'map-005', timestamp: '2026-03-03T11:00:00.000Z', attributes: { 'gen_ai.request.model': 'mystery-model-x', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 0 } },
    { name: 'chat', spanId: 'map-006', timestamp: '2026-03-03T11:10:00.000Z', attributes: { 'gen_ai.response.model': 'gpt-5-mini', 'gen_ai.usage.prompt_tokens': 70, 'gen_ai.usage.completion_tokens': 14 } }, // alternate attribute names
    { name: 'inline_completion', spanId: 'map-007', timestamp: '2026-03-03T11:20:00.000Z', attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': '55', 'gen_ai.usage.output_tokens': '6', 'gen_ai.operation.surface': 'inline' } }, // numeric strings
    { name: 'chat', spanId: 'map-008', timestamp: '2026-03-03T11:30:00.000Z', attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': -5, 'gen_ai.usage.output_tokens': 6 } }, // negative token count is ignored
  ];
  return `${rows.map(J).join('\n')}\n`;
}

/** One OTLP-array line and one attribute-map line: DuckDB types `attributes` as JSON and nothing maps. */
function copilotMixed(): string {
  return `${[
    { name: 'chat', spanId: 'mix-001', timestamp: '2026-03-04T10:00:00.000Z', attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: '10' } }] },
    { name: 'chat', spanId: 'mix-002', timestamp: '2026-03-04T10:01:00.000Z', attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 11 } },
  ].map(J).join('\n')}\n`;
}

/** Rows of the span DB (flat columns, as CopilotConnector reads `SELECT * FROM spans`). */
export const SPANS_DB_COLUMNS = [
  'span_id', 'trace_id', 'name', 'timestamp', 'startTimeUnixNano',
  'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.operation.name', 'language',
] as const;
export type SpanDbRow = Array<string | number | bigint | null>;

export function spansDbRows(): SpanDbRow[] {
  const r = (id: string, name: string, ts: string | null, nanos: bigint | null, model: string | null, resp: string | null, i: number | null, o: number | null, op: string | null, lang: string | null): SpanDbRow =>
    [id, 'trace-db-1', name, ts, nanos, model, resp, i, o, op, lang];
  return [
    r('db-001', 'chat', '2026-03-10T09:00:00.000Z', null, 'gpt-4.1', null, 400, 90, 'chat', 'typescript'),
    r('db-002', 'invoke_agent', null, BigInt(at('2026-03-10T09:05:00.000Z')) * 1_000_000n, 'claude-sonnet-4.5', null, 3000, 700, 'invoke_agent', null),
    r('db-003', 'chat', '2026-03-10T09:10:00.000Z', null, null, 'gpt-5-mini', 220, 44, 'chat', null),
    r('db-004', 'inline_completion', '2026-03-11T14:00:00.000Z', null, 'gpt-4o', null, 60, 12, 'inline_completion', 'rust'),
    r('db-005', 'chat', '2026-03-11T14:05:00.000Z', null, 'mystery-model-x', null, 60, 12, 'chat', null),
    r('db-006', 'chat', '2026-03-11T14:10:00.000Z', null, 'gpt-4o', null, 0, 0, 'chat', null),
    r('db-007', 'edit_file', '2026-03-12T09:00:00.000Z', null, 'claude-opus-4.5', null, 1500, 300, 'edit_file', null),
    r('db-008', 'chat', null, null, 'gpt-4o', null, 5, 5, 'chat', null), // no timestamp: skipped
    r('db-009', 'chat', '2026-03-12T09:30:00.000Z', null, null, null, 5, 5, 'chat', null), // no model: skipped
    r('db-010', 'chat', '2026-10-30T10:00:00.000Z', null, 'gemini-2.5-pro', null, 900, 250, 'chat', null),
    r('db-011', 'execute_tool', '2026-10-30T10:05:00.000Z', null, 'gpt-4.1', null, 90, 10, 'execute_tool', null),
    r('db-012', 'chat', '2026-11-01T09:15:00.000Z', null, 'gpt-4o', null, 70, 17, 'chat', null),
  ];
}

/** Create `copilot/spans.db` (binary, committed) with the Node built-in SQLite driver. */
export async function writeSpansDb(file: string): Promise<void> {
  const { DatabaseSync } = (await import('node:sqlite')) as typeof import('node:sqlite');
  await fs.rm(file, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    const cols = SPANS_DB_COLUMNS.map((c, i) => {
      const type = i === 4 ? 'INTEGER' : c.startsWith('gen_ai.usage') ? 'INTEGER' : 'TEXT';
      return `"${c}" ${type}${i === 0 ? ' PRIMARY KEY' : ''}`;
    });
    db.exec(`CREATE TABLE spans (${cols.join(', ')})`);
    const stmt = db.prepare(`INSERT INTO spans VALUES (${SPANS_DB_COLUMNS.map(() => '?').join(', ')})`);
    for (const row of spansDbRows()) stmt.run(...row);
  } finally {
    db.close();
  }
}

// ── Pricing inputs ────────────────────────────────────────────────────────────

function pricingManifest(): Json {
  return {
    version: 7,
    pricePerCredit: 0.04,
    updatedAt: '2026-10-01T00:00:00.000Z',
    models: {
      'gpt-4.1': 0,
      'gpt-4o': 0.33,
      'gpt-5-mini': 0.33,
      'o3-mini': 0.33,
      'gemini-2.5-pro': 1,
      'claude-sonnet-4-5': 6,
      'claude-sonnet-4': 1,
      'claude-opus-4-5': 15,
      'claude-opus': 10,
      'claude-haiku-4-5': 0.33,
      'claude-3.5-haiku': 0.33,
      'claude-3.5-sonnet': 1,
      'claude-3.7-sonnet': 1.25,
      unknown: 1.5,
    },
  };
}

function tokenPrices(): Json {
  return {
    'claude-sonnet-4.5': { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
    'claude-opus-4.5': { input: 5e-6, output: 25e-6, cacheRead: 5e-7, cacheWrite: 6.25e-6 },
    'claude-haiku-4.5': { input: 1e-6, output: 5e-6 },
    'gpt-4.1': { input: 2e-6, output: 8e-6 },
    'gpt-4o': { input: 2.5e-6, output: 1e-5 },
    'gpt-5-mini': { input: 2.5e-7, output: 2e-6, thinking: 2e-6 },
    'gemini-2.5-pro': { input: 1.25e-6, output: 1e-5 },
  };
}

// ── Assembly ──────────────────────────────────────────────────────────────────

/** Every text fixture: relative path (posix) -> exact contents. */
export function fixtureTextFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const claude = claudeFiles();
  for (const [f, t] of claude.pass1) out.set(`claude/${f}`, t);
  for (const [f, t] of claude.pass2) out.set(`claude-pass2/${f}`, t);
  const otel = copilotOtel();
  out.set('copilot/otel.jsonl', otel.pass1);
  out.set('copilot-pass2/otel.jsonl', otel.pass2);
  out.set('copilot/otel-map.jsonl', copilotMap());
  out.set('copilot/otel-mixed.jsonl', copilotMixed());
  out.set('pricing/manifest.json', `${JSON.stringify(pricingManifest(), null, 2)}\n`);
  out.set('pricing/token-prices.json', `${JSON.stringify(tokenPrices(), null, 2)}\n`);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export async function generateFixtures(dir = FIXTURES_DIR): Promise<string[]> {
  await fs.rm(dir, { recursive: true, force: true });
  const written: string[] = [];
  for (const [rel, text] of fixtureTextFiles()) {
    const dest = path.join(dir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, text);
    written.push(rel);
  }
  await writeSpansDb(path.join(dir, 'copilot', 'spans.db'));
  written.push('copilot/spans.db');
  return written;
}

if (require.main === module) {
  generateFixtures().then(
    (files) => console.log(`wrote ${files.length} fixture files under ${FIXTURES_DIR}`),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
