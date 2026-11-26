import { strict as assert } from 'assert';
import type { RawEvent } from '../../../src/extension-backend/domain/contracts';
import {
  BUCKET_MS,
  bucketStart,
  filterEvents,
  groupEvents,
  groupsFor,
  localDate,
  matchesRecordFilter,
  rollUpEvents,
  toRawEvent,
} from '../../golden/groupEvents';
import {
  capCutoff,
  isRolledId,
  mergeAttribution,
  mergeRolledRow,
  retentionCutoff,
  rollId,
  rollUpGroups,
  sumOrNull,
  tokensKnownOf,
  toRolledRow,
} from '../../../src/extension-backend/domain/groupEvents';
import type { NormalizedEvent } from '../../golden/pipeline';
import { withTzSync } from '../../golden/support/time';

const T = (iso: string): number => Date.parse(iso);

function ev(partial: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'e', ts: T('2026-03-15T10:07:00Z'), modelId: 'gpt-4o', surface: 'chat', source: 'local',
    repo: null, branch: null, attribution: null, language: null, requests: 1,
    promptTokens: null, completionTokens: null, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
    ...partial,
  };
}

describe('test/golden/groupEvents — the SQL GROUP BY twin', () => {
  it('buckets by 15 minutes of UTC, also before the epoch', () => {
    assert.equal(BUCKET_MS, 900_000);
    assert.equal(bucketStart(T('2026-03-15T10:07:00Z')), T('2026-03-15T10:00:00Z'));
    assert.equal(bucketStart(T('2026-03-15T10:15:00Z')), T('2026-03-15T10:15:00Z'));
    assert.equal(bucketStart(T('2026-03-15T10:29:59.999Z')), T('2026-03-15T10:15:00Z'));
    assert.equal(bucketStart(-1), -BUCKET_MS);
  });

  it('merges rows of one bucket and dimension tuple, summing requests and every token column', () => {
    const [g, ...rest] = groupEvents([
      ev({ id: 'a', promptTokens: 10, completionTokens: 2, cacheReadTokens: 5, cacheCreationTokens: 1, thinkingTokens: 3, requests: 2 }),
      ev({ id: 'b', ts: T('2026-03-15T10:14:59Z'), promptTokens: 20, completionTokens: null, cacheReadTokens: 7, cacheCreationTokens: 2, thinkingTokens: 1 }),
    ]);
    assert.equal(rest.length, 0);
    assert.deepEqual(g, {
      bucketStartMs: T('2026-03-15T10:00:00Z'), modelId: 'gpt-4o', surface: 'chat', source: 'local',
      repo: null, branch: null, language: null, attribution: null, tokensKnown: true,
      requests: 3, promptTokens: 30, completionTokens: 2, cacheReadTokens: 12, cacheCreationTokens: 3, thinkingTokens: 4,
    });
  });

  it('keeps rows apart when any key column differs, tokensKnown included', () => {
    const base = ev();
    const variants: Array<Partial<RawEvent>> = [
      { ts: T('2026-03-15T10:15:00Z') }, { modelId: 'gpt-4.1' }, { surface: 'agent' }, { source: 'claude-code' },
      { repo: 'r' }, { branch: 'b' }, { language: 'ts' }, { attribution: 'heuristic' }, { promptTokens: 1 },
    ];
    for (const v of variants) assert.equal(groupEvents([base, ev(v)]).length, 2, JSON.stringify(v));
  });

  it('tokensKnown is "prompt or completion tokens to price": a known 0/0 row is NOT known (it prices through credits)', () => {
    const known = (p: number | null, c: number | null): boolean => groupEvents([ev({ promptTokens: p, completionTokens: c })])[0]!.tokensKnown;
    assert.deepEqual([known(null, null), known(0, null), known(null, 0), known(0, 0), known(5, 5), known(null, 7), known(3, null)], [false, false, false, false, true, true, true]);
    // A known 0/0 row stays apart from a token-bearing row of the same bucket and dimensions.
    assert.equal(groupEvents([ev({ promptTokens: 0, completionTokens: 0 }), ev({ promptTokens: 4, completionTokens: 0 })]).length, 2);
    // ... but joins a row without counts (both price through credits).
    assert.equal(groupEvents([ev({ promptTokens: 0, completionTokens: 0 }), ev({ promptTokens: null, completionTokens: null })]).length, 1);
  });

  it('returns the groups ordered by bucket, then by key, whatever the input order', () => {
    const groups = groupEvents([
      ev({ ts: T('2026-03-15T10:30:00Z'), modelId: 'b' }),
      ev({ ts: T('2026-03-15T10:00:00Z'), modelId: 'z' }),
      ev({ ts: T('2026-03-15T10:00:00Z'), modelId: 'a' }),
    ]);
    assert.deepEqual(groups.map((g) => [g.bucketStartMs, g.modelId]), [
      [T('2026-03-15T10:00:00Z'), 'a'], [T('2026-03-15T10:00:00Z'), 'z'], [T('2026-03-15T10:30:00Z'), 'b'],
    ]);
  });
});

describe('test/golden/groupEvents — the filter WHERE clause twin', () => {
  const events = [
    ev({ id: 'in', ts: T('2026-03-15T10:00:00Z'), repo: 'alpha', branch: 'main' }),
    ev({ id: 'noRepo', ts: T('2026-03-15T11:00:00Z'), modelId: 'gpt-4.1', surface: 'agent', source: 'claude-code' }),
    ev({ id: 'late', ts: T('2026-03-16T00:00:00Z'), repo: 'beta' }),
  ];
  const ids = (f: Parameters<typeof matchesRecordFilter>[1]): string[] => filterEvents(events, f).map((e) => e.id);

  it('an empty filter, and empty lists, match everything', () => {
    assert.deepEqual(ids({}), ['in', 'noRepo', 'late']);
    assert.deepEqual(ids({ models: [], surfaces: [], sources: [], branches: [], repos: [] }), ['in', 'noRepo', 'late']);
  });

  it('the range is start-inclusive and end-exclusive', () => {
    assert.deepEqual(ids({ range: { start: T('2026-03-15T10:00:00Z'), end: T('2026-03-16T00:00:00Z') } }), ['in', 'noRepo']);
    assert.deepEqual(ids({ range: { start: T('2026-03-15T10:00:01Z'), end: T('2026-03-16T00:00:01Z') } }), ['noRepo', 'late']);
  });

  it('models, surfaces and sources are IN lists', () => {
    assert.deepEqual(ids({ models: ['gpt-4.1'] }), ['noRepo']);
    assert.deepEqual(ids({ surfaces: ['agent', 'edit'] }), ['noRepo']);
    assert.deepEqual(ids({ sources: ['local'] }), ['in', 'late']);
  });

  it('a branch filter never matches a NULL branch', () => {
    assert.deepEqual(ids({ branches: ['main'] }), ['in']);
    assert.deepEqual(ids({ branches: [''] }), []);
  });

  it('"unattributed" in a repo filter means repo IS NULL, next to named repos', () => {
    assert.deepEqual(ids({ repos: ['alpha'] }), ['in']);
    assert.deepEqual(ids({ repos: ['unattributed'] }), ['noRepo']);
    assert.deepEqual(ids({ repos: ['alpha', 'unattributed'] }), ['in', 'noRepo']);
    assert.deepEqual(ids({ repos: ['gamma'] }), []);
  });

  it('conditions combine with AND', () => {
    assert.deepEqual(ids({ models: ['gpt-4o'], repos: ['alpha'], sources: ['local'] }), ['in']);
    assert.deepEqual(ids({ models: ['gpt-4.1'], repos: ['alpha'] }), []);
  });

  it('groupsFor: the groups follow the whole filter, the dim groups only its range', () => {
    const range = { start: T('2026-03-15T00:00:00Z'), end: T('2026-03-15T23:00:00Z') };
    const { groups, dimGroups } = groupsFor(events, { range, models: ['gpt-4o'] });
    assert.deepEqual(groups!.map((g) => g.modelId), ['gpt-4o']);
    assert.deepEqual(dimGroups!.map((g) => g.modelId).sort(), ['gpt-4.1', 'gpt-4o']);
    // No range: the dim groups cover everything.
    assert.equal(groupsFor(events, { models: ['gpt-4o'] }).dimGroups!.length, 3);
  });
});

describe('test/golden/groupEvents — golden conversion and rollup twin', () => {
  it('toRawEvent renames model, keeps nulls and turns absent cache/thinking tokens into 0', () => {
    const golden: NormalizedEvent = {
      id: 'x', ts: 5, model: 'gpt-4o', surface: 'chat', source: 'local', repo: null, branch: 'b', attribution: 'heuristic', language: null,
      promptTokens: null, completionTokens: 4, cacheCreationTokens: null, cacheReadTokens: 9, thinkingTokens: null,
      credits: 1, cost: 1, estimated: true, costByCategory: null,
    };
    assert.deepEqual(toRawEvent(golden), {
      id: 'x', ts: 5, modelId: 'gpt-4o', surface: 'chat', source: 'local', repo: null, branch: 'b', attribution: 'heuristic', language: null,
      requests: 1, promptTokens: null, completionTokens: 4, cacheReadTokens: 9, cacheCreationTokens: 0, thinkingTokens: 0,
    });
  });

  const NOW = T('2026-11-02T09:30:00Z');

  it('rolls events older than the local midnight `retentionDays` ago, per day/model/surface/source/repo', () => {
    const rolled = withTzSync('America/Los_Angeles', () => {
      const cutoff = T('2026-10-03T07:00:00Z'); // local midnight 30 days before Nov 2
      return rollUpEvents(
        [
          ev({ id: 'raw', ts: cutoff }), // exactly at the cutoff: stays raw
          ev({ id: 'a', ts: cutoff - 1, repo: 'alpha', branch: 'main', language: 'ts', attribution: 'authoritative', promptTokens: 10, completionTokens: null, cacheReadTokens: 5 }),
          ev({ id: 'b', ts: cutoff - 3_600_000, repo: 'alpha', attribution: 'heuristic', promptTokens: 1, completionTokens: 2, thinkingTokens: 4, requests: 2 }),
          ev({ id: 'c', ts: cutoff - 1, repo: 'alpha', surface: 'agent' }), // another surface: its own row
          ev({ id: 'd', ts: cutoff - 25 * 3_600_000, repo: 'alpha' }), // the day before
          ev({ id: 'e', ts: cutoff - 1, repo: null, promptTokens: null, completionTokens: null }),
        ],
        NOW,
        30,
      );
    });
    assert.equal(rolled.cutoff, T('2026-10-03T07:00:00Z'));
    assert.deepEqual(rolled.rows.map((r) => r.id).slice(0, 1), ['raw']);
    assert.deepEqual(rolled.rolled.map((r) => r.id), [
      'roll:2026-10-01:gpt-4o:alpha:chat:local',
      'roll:2026-10-02:gpt-4o:alpha:agent:local',
      'roll:2026-10-02:gpt-4o:alpha:chat:local',
      'roll:2026-10-02:gpt-4o:unattributed:chat:local',
    ]);
    const chat = rolled.rolled.find((r) => r.id === 'roll:2026-10-02:gpt-4o:alpha:chat:local')!;
    assert.deepEqual(chat, {
      id: chat.id, ts: T('2026-10-02T07:00:00Z'), modelId: 'gpt-4o', surface: 'chat', source: 'local', repo: 'alpha',
      branch: null, attribution: 'heuristic', language: null, requests: 3,
      promptTokens: 11, completionTokens: 2, cacheReadTokens: 5, cacheCreationTokens: 0, thinkingTokens: 4,
    });
    assert.deepEqual(rolled.members.get(chat.id)!.map((m) => m.id), ['a', 'b']);
    // SUM() of only NULLs stays NULL; authoritative alone stays authoritative; no attribution stays none.
    const none = rolled.rolled.find((r) => r.id.includes('unattributed'))!;
    assert.deepEqual([none.promptTokens, none.completionTokens, none.repo, none.attribution], [null, null, null, null]);
    const solo = rolled.rolled.find((r) => r.id === 'roll:2026-10-02:gpt-4o:alpha:agent:local')!;
    assert.equal(solo.attribution, null);
    const authoritative = withTzSync('UTC', () => rollUpEvents([ev({ ts: T('2026-01-01T00:00:00Z'), attribution: 'authoritative' })], NOW, 30));
    assert.equal(authoritative.rolled[0]!.attribution, 'authoritative');
  });

  it('localDate is the local calendar date in the zone in force', () => {
    const ts = T('2026-03-15T23:30:00Z');
    assert.equal(withTzSync('UTC', () => localDate(ts)), '2026-03-15');
    assert.equal(withTzSync('Pacific/Auckland', () => localDate(ts)), '2026-03-16');
  });
});

describe('domain/groupEvents — the pieces the stores share', () => {
  it('tokensKnownOf: prompt + completion tokens above zero', () => {
    assert.deepEqual(
      [[null, null], [0, 0], [0, null], [1, null], [null, 1], [2, 3]].map(([p, c]) => tokensKnownOf(p!, c!)),
      [false, false, false, true, true, true],
    );
  });

  it('sumOrNull is NULL only when both sides are; mergeAttribution lets heuristic win over authoritative over none', () => {
    assert.deepEqual([[null, null], [null, 2], [3, null], [3, 2], [0, null]].map(([a, b]) => sumOrNull(a!, b!)), [null, 2, 3, 5, 0]);
    const all = [null, 'authoritative', 'heuristic'] as const;
    const expected = [
      [null, 'authoritative', 'heuristic'],
      ['authoritative', 'authoritative', 'heuristic'],
      ['heuristic', 'heuristic', 'heuristic'],
    ];
    all.forEach((a, i) => all.forEach((b, j) => assert.equal(mergeAttribution(a, b), expected[i]![j], `${a} + ${b}`)));
  });

  it('rollId and isRolledId', () => {
    const id = withTzSync('UTC', () => rollId(ev({ ts: T('2026-03-15T23:59:59Z'), modelId: 'm', repo: null, surface: 'agent', source: 'claude-code' })));
    assert.equal(id, 'roll:2026-03-15:m:unattributed:agent:claude-code');
    assert.deepEqual([id, 'claude-code:1', 'roll', ''].map(isRolledId), [true, false, false, false]);
  });

  it('toRolledRow keeps the dimensions, drops branch and language, sits at local midnight; "unattributed" is no repo', () => {
    withTzSync('Pacific/Auckland', () => {
      const e = ev({ ts: T('2026-03-15T10:07:00Z'), repo: 'unattributed', branch: 'b', language: 'ts', attribution: 'heuristic', requests: 2, promptTokens: 5 });
      const row = toRolledRow(e, 'roll:x');
      assert.deepEqual(row, {
        id: 'roll:x', ts: T('2026-03-14T11:00:00Z'), modelId: 'gpt-4o', surface: 'chat', source: 'local', repo: null, branch: null, attribution: 'heuristic',
        language: null, requests: 2, promptTokens: 5, completionTokens: null, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
      });
      assert.equal(toRolledRow(ev({ repo: 'alpha' }), 'roll:y').repo, 'alpha');
    });
  });

  it('mergeRolledRow sums, keeps NULL only for NULL + NULL, and merges attribution', () => {
    const a = toRolledRow(ev({ promptTokens: null, completionTokens: 4, attribution: 'authoritative', cacheReadTokens: 1 }), 'roll:a');
    const b = toRolledRow(ev({ promptTokens: null, completionTokens: null, attribution: 'heuristic', cacheReadTokens: 2, thinkingTokens: 3, requests: 4 }), 'roll:a');
    const m = mergeRolledRow(a, b);
    assert.deepEqual([m.promptTokens, m.completionTokens, m.attribution, m.cacheReadTokens, m.thinkingTokens, m.requests], [null, 4, 'heuristic', 3, 3, 5]);
  });

  it('rollUpGroups orders the rolled rows by time then id and reports the members', () => {
    withTzSync('UTC', () => {
      const { rolled, members } = rollUpGroups([
        ev({ id: 'b', ts: T('2026-03-16T01:00:00Z'), modelId: 'b' }),
        ev({ id: 'a1', ts: T('2026-03-15T01:00:00Z'), modelId: 'z' }),
        ev({ id: 'a2', ts: T('2026-03-15T02:00:00Z'), modelId: 'a' }),
        ev({ id: 'a3', ts: T('2026-03-15T03:00:00Z'), modelId: 'z' }),
      ]);
      assert.deepEqual(rolled.map((r) => [r.id, r.requests]), [
        ['roll:2026-03-15:a:unattributed:chat:local', 1],
        ['roll:2026-03-15:z:unattributed:chat:local', 2],
        ['roll:2026-03-16:b:unattributed:chat:local', 1],
      ]);
      assert.deepEqual(members.get('roll:2026-03-15:z:unattributed:chat:local')!.map((e) => e.id), ['a1', 'a3']);
    });
  });

  it('retentionCutoff is a local midnight; capCutoff the next midnight after the boundary row, never later than today', () => {
    withTzSync('America/Los_Angeles', () => {
      const now = T('2026-11-02T20:00:00Z'); // Nov 2, 13:00 local
      assert.equal(retentionCutoff(now, 30), T('2026-10-03T07:00:00Z'));
      assert.equal(capCutoff(T('2026-10-20T15:00:00Z'), now), T('2026-10-21T07:00:00Z'));
      assert.equal(capCutoff(T('2026-11-02T10:00:00Z'), now), T('2026-11-02T08:00:00Z'), 'today is never rolled for the cap');
      // The DST fall-back day (Nov 1, 25 hours long) ends at the right midnight.
      assert.equal(capCutoff(T('2026-11-01T12:00:00Z'), now), T('2026-11-02T08:00:00Z'));
    });
  });
});
