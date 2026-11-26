// Deterministic synthetic usage-event generator + schema helpers.
// Events are positional arrays (fast to bind) in COLS order.

export const COLS = [
  'id', 'ts', 'modelId', 'surface', 'source', 'repo', 'branch', 'attribution', 'language',
  'requests', 'promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheCreationTokens', 'thinkingTokens',
];
export const DAY_MS = 86_400_000;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  modelId TEXT NOT NULL,
  surface TEXT NOT NULL,
  source TEXT NOT NULL,
  repo TEXT,
  branch TEXT,
  attribution TEXT,
  language TEXT,
  requests INTEGER NOT NULL DEFAULT 1,
  promptTokens INTEGER,
  completionTokens INTEGER,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  thinkingTokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_model ON events(modelId);
CREATE INDEX IF NOT EXISTS events_repo ON events(repo);
`;

export const UPSERT_SQL = `
INSERT INTO events (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})
ON CONFLICT(id) DO UPDATE SET promptTokens = max(promptTokens, excluded.promptTokens)`;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MODELS = [
  'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-sonnet-4', 'claude-opus-4',
  'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'o4-mini', 'gemini-2.5-pro', 'claude-3-5-haiku', 'grok-code-fast-1',
];
export const LANGS = ['typescript', 'python', 'rust', 'go', 'markdown', 'json', 'java', 'csharp', 'cpp', 'yaml', 'shellscript', 'sql'];
export const REPOS = Array.from({ length: 40 }, (_, i) => `repo-${String(i).padStart(2, '0')}`);

export const hex = (r, n) => {
  let s = '';
  while (s.length < n) s += Math.floor(r() * 0x100000000).toString(16).padStart(8, '0');
  return s.slice(0, n);
};
export const uuid = (r) => `${hex(r, 8)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 4)}-${hex(r, 12)}`;
export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
/** Zipf-ish: low indices much more likely. */
const zipf = (r, n) => Math.min(n - 1, Math.floor(Math.pow(r(), 2.2) * n));
const logn = (r, mu, sigma) => {
  const u = Math.max(1e-9, r()), v = r();
  return Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};

/**
 * Generate n raw events. `clustered` mimics real use (sessions of a few hours in one repo/branch with one or
 * two models, events seconds-to-minutes apart); `uniform` is the cardinality worst case (everything random).
 * Returns positional arrays in COLS order, in generation order (ts only roughly increasing within a session).
 */
export function genEvents(n, { seed = 1, days = 90, endTs = Date.UTC(2026, 10, 24, 12), mode = 'clustered', idPrefix = 'claude-code' } = {}) {
  const r = mulberry32(seed);
  const out = [];
  const startTs = endTs - days * DAY_MS;
  const emit = (ts, model, surface, source, repo, branch, attribution, language, sess) => {
    const completion = Math.round(logn(r, 6, 1));
    const prompt = Math.round(logn(r, 5.5, 1.2));
    const cacheRead = source === 'claude-code' ? Math.round(logn(r, 10, 1)) : 0;
    const cacheCreation = source === 'claude-code' && r() < 0.3 ? Math.round(logn(r, 8, 1)) : 0;
    const thinking = r() < 0.2 ? Math.round(logn(r, 6, 1)) : 0;
    out.push([
      `${idPrefix}:${sess}:${ts}:${model}:${uuid(r)}`,
      ts, model, surface, source, repo, branch, attribution, language,
      1, prompt, completion, cacheRead, cacheCreation, thinking,
    ]);
  };
  if (mode === 'uniform') {
    for (let i = 0; i < n; i++) {
      const repo = r() < 0.15 ? null : pick(r, REPOS);
      emit(
        Math.floor(startTs + r() * (endTs - startTs)), pick(r, MODELS), r() < 0.6 ? 'agent' : 'chat',
        r() < 0.7 ? 'claude-code' : 'copilot', repo, repo && r() < 0.8 ? `branch-${Math.floor(r() * 200)}` : null,
        repo ? (r() < 0.7 ? 'authoritative' : 'heuristic') : null, r() < 0.3 ? null : pick(r, LANGS), hex(r, 8),
      );
    }
    return out;
  }
  let produced = 0;
  while (produced < n) {
    const day = Math.floor(r() * days);
    const dow = new Date(startTs + day * DAY_MS).getUTCDay();
    if ((dow === 0 || dow === 6) && r() < 0.7) continue; // fewer weekend sessions
    const hour = Math.min(23, Math.max(0, Math.round(15 + (r() + r() + r() - 1.5) * 8))); // ~UTC afternoon, spread
    const start = startTs + day * DAY_MS + hour * 3_600_000 + Math.floor(r() * 3_600_000);
    const count = Math.min(n - produced, 20 + Math.floor(logn(r, 4.2, 0.9)));
    const repoIdx = zipf(r, REPOS.length);
    const repo = r() < 0.12 ? null : REPOS[repoIdx];
    const branch = repo && r() < 0.8 ? (r() < 0.5 ? 'main' : `feat/${repoIdx}-${Math.floor(r() * 5)}`) : null;
    const model1 = MODELS[zipf(r, MODELS.length)];
    const model2 = r() < 0.2 ? pick(r, MODELS) : model1;
    const source = r() < 0.7 ? 'claude-code' : 'copilot';
    const surface = r() < 0.65 ? 'agent' : 'chat';
    const attribution = repo ? (r() < 0.75 ? 'authoritative' : 'heuristic') : null;
    const language = r() < 0.25 ? null : LANGS[zipf(r, LANGS.length)];
    const sess = hex(r, 8);
    let ts = start;
    for (let i = 0; i < count; i++) {
      ts += Math.floor(-Math.log(1 - r()) * (r() < 0.05 ? 240_000 : 20_000)); // mostly ~20s gaps, occasional long pauses
      emit(ts, r() < 0.85 ? model1 : model2, surface, source, repo, branch, attribution, language, sess);
    }
    produced += count;
  }
  return out;
}

/** Roll-up-like rows: one per day x model x surface x source x repo, older than the raw range. */
export function genRollups(n, { seed = 7, endTs = Date.UTC(2026, 10, 24, 12), fromDaysAgo = 91, toDaysAgo = 450 } = {}) {
  const r = mulberry32(seed);
  const out = [];
  const seen = new Set();
  const endDay = Math.floor(endTs / DAY_MS) * DAY_MS;
  while (out.length < n) {
    const day = endDay - Math.floor(fromDaysAgo + r() * (toDaysAgo - fromDaysAgo)) * DAY_MS;
    const model = MODELS[zipf(r, MODELS.length)];
    const surface = r() < 0.65 ? 'agent' : 'chat';
    const source = r() < 0.7 ? 'claude-code' : 'copilot';
    const repo = r() < 0.1 ? 'unattributed' : REPOS[zipf(r, REPOS.length)];
    const id = `roll:${day}:${model}:${surface}:${source}:${repo}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const req = 5 + Math.floor(logn(r, 3.5, 1));
    out.push([id, day, model, surface, source, repo, null, null, null, req,
      req * 300, req * 450, source === 'claude-code' ? req * 20000 : 0, req * 500, req * 40]);
  }
  return out;
}

/** Open a DB (path or ':memory:') with a journal/sync preset and the schema. */
export function openDb(DatabaseSync, file, mode = 'wal', busyMs = 5000) {
  const db = new DatabaseSync(file);
  applyMode(db, mode, busyMs);
  db.exec(SCHEMA_SQL);
  return db;
}

export function applyMode(db, mode = 'wal', busyMs = 5000) {
  switch (mode) {
    case 'wal': // plan: WAL + synchronous=NORMAL
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=${busyMs};`);
      break;
    case 'wal-full': // WAL but SQLite's default synchronous=FULL
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${busyMs};`);
      break;
    case 'wal-off': // WAL + synchronous=OFF: no fsync at all (DB is rebuildable from logs; OS crash may corrupt)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA busy_timeout=${busyMs};`);
      break;
    case 'wal-ckpt0': // WAL+NORMAL, auto-checkpoint disabled (caller checkpoints explicitly, e.g. when idle)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=${busyMs};`);
      break;
    case 'wal-ckpt-big': // WAL+NORMAL, checkpoint every 20000 pages (~80 MB of WAL)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=20000; PRAGMA busy_timeout=${busyMs};`);
      break;
    case 'default': // rollback journal (DELETE), synchronous=FULL
      db.exec(`PRAGMA busy_timeout=${busyMs};`);
      break;
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

export function bind(stmt, r) {
  return stmt.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14]);
}
