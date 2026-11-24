import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { Filter, UsageSnapshot } from '../../../src/extension-backend/domain/types';
import { resolveRangePreset } from '../../../src/extension-backend/domain/rangePreset';
import { setState, state } from '../../../src/extension-frontend/store';
import { mountFilterBar } from '../../../src/extension-frontend/components/FilterBar';
import {
  filterKey,
  filterPatchFromSnapshot,
  postFilter,
  reresolveRelativeRange,
  resetFilterSync,
} from '../../../src/extension-frontend/filterSync';

interface SetFilterMsg { type: 'setFilter'; value: Filter }

function posted(): SetFilterMsg[] {
  const all = (globalThis as unknown as { __postedMessages: Array<{ type: string }> }).__postedMessages;
  return all.filter((m): m is SetFilterMsg => m.type === 'setFilter');
}
function clearPosted(): void {
  (globalThis as unknown as { __postedMessages: unknown[] }).__postedMessages = [];
}

const DAY = 86_400_000;

function multiSnapshot(): UsageSnapshot {
  const now = Date.now();
  return buildSnapshot(
    [
      makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits: 5, cost: 0.2, surface: 'chat', source: 'local', repo: 'acme/app' }),
      makeEvent({ ts: now - 2000, modelId: 'claude-sonnet-4-5', credits: 3, cost: 0.1, surface: 'inline', source: 'claude-code', repo: 'acme/lib' }),
    ],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
}

function reset(): void {
  resetFilterSync();
  setState({ filter: {}, datePreset: 'month' });
  clearPosted();
}

describe('filterKey', () => {
  it('ignores list order and treats empty lists as absent', () => {
    assert.equal(
      filterKey({ models: ['b', 'a'], surfaces: [] }),
      filterKey({ models: ['a', 'b'] }),
    );
  });

  it('distinguishes range, preset and every list dimension', () => {
    const base = filterKey({});
    for (const f of [
      { range: { start: 1, end: 2 } }, { rangePreset: '7d' as const }, { models: ['m'] },
      { surfaces: ['chat' as const] }, { repos: ['r'] }, { branches: ['b'] }, { sources: ['local' as const] },
    ] as Filter[]) {
      assert.notEqual(filterKey(f), base, JSON.stringify(f));
    }
  });
});

describe('FilterBar sends the preset with the range', () => {
  beforeEach(reset);
  afterEach(reset);

  it("clicking '7d' posts rangePreset '7d' plus the day-aligned range it resolves to", () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const bar = mountFilterBar(el);
    bar.update(multiSnapshot(), 'cost');

    const before = Date.now();
    el.querySelector<HTMLButtonElement>('[data-preset="7d"]')!.click();

    const sent = posted().at(-1)!.value;
    assert.equal(sent.rangePreset, '7d');
    const expected = resolveRangePreset('7d', before)!;
    // The test could straddle midnight; either resolution of "now" is valid.
    const alt = resolveRangePreset('7d', Date.now())!;
    assert.ok(
      (sent.range!.start === expected.start && sent.range!.end === expected.end) ||
        (sent.range!.start === alt.start && sent.range!.end === alt.end),
      'range is the resolver output',
    );
    // The end is the next midnight, not "now + 1": events logged later today still match.
    assert.equal(new Date(sent.range!.end).getHours(), 0, 'ends at a local midnight');
    assert.ok(sent.range!.end > Date.now(), 'and that midnight is still ahead');
    assert.equal(state().datePreset, '7d');
    assert.equal(state().filter.rangePreset, '7d');
    el.remove();
  });

  it("clicking 'All time' posts rangePreset 'all' with no range so a reopened panel restores it", () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const bar = mountFilterBar(el);
    bar.update(multiSnapshot(), 'cost');
    el.querySelector<HTMLButtonElement>('[data-preset="all"]')!.click();
    const sent = posted().at(-1)!.value;
    assert.equal(sent.rangePreset, 'all');
    assert.equal('range' in sent, false);
    el.remove();
  });

  it('keeps branches set elsewhere instead of dropping them when another filter changes', () => {
    setState({ filter: { branches: ['main'], rangePreset: 'all' }, datePreset: 'all' });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const bar = mountFilterBar(el);
    bar.update(multiSnapshot(), 'cost');
    el.querySelector<HTMLButtonElement>('[data-preset="today"]')!.click();
    assert.deepEqual(posted().at(-1)!.value.branches, ['main']);
    el.remove();
  });
});

describe('hydrating local filter state from a snapshot', () => {
  beforeEach(reset);
  afterEach(reset);

  it('adopts surfaces, repos, branches, sources, range and preset, and moves the date preset button', () => {
    const range = { start: 1_000, end: 2_000 };
    const incoming: Filter = {
      surfaces: ['chat'], repos: ['acme/app'], branches: ['main'], sources: ['local'],
      models: ['gpt-4o'], range, rangePreset: '30d',
    };
    const patch = filterPatchFromSnapshot(incoming)!;
    assert.deepEqual(patch.filter, incoming);
    assert.equal(patch.datePreset, '30d');
    assert.equal(posted().length, 0, 'hydration never echoes a setFilter back');
  });

  it('returns null (no state change) when the snapshot filter already equals local state', () => {
    setState({ filter: { models: ['a', 'b'], rangePreset: '7d' }, datePreset: '7d' });
    assert.equal(filterPatchFromSnapshot({ models: ['b', 'a'], rangePreset: '7d' }), null);
  });

  it('adopts a filter removed elsewhere (e.g. the sidebar clearing the model list)', () => {
    setState({ filter: { models: ['gpt-4o'], rangePreset: '7d' }, datePreset: '7d' });
    const patch = filterPatchFromSnapshot({ rangePreset: '7d' })!;
    assert.equal('models' in patch.filter, false);
    assert.equal(patch.datePreset, '7d');
  });

  it('keeps the current preset button when the incoming filter carries a range but no preset', () => {
    setState({ datePreset: '7d' });
    const patch = filterPatchFromSnapshot({ range: { start: 1, end: 2 } })!;
    assert.equal(patch.datePreset, '7d');
  });

  it('a snapshot computed before a just-posted filter cannot clobber it, but the echo clears the guard', () => {
    const mine: Filter = { models: ['gpt-4o'], rangePreset: 'all' };
    setState({ filter: mine, datePreset: 'all' });
    postFilter(mine, 1_000);

    assert.equal(filterPatchFromSnapshot({}, 2_000), null, 'stale pre-filter snapshot ignored');
    assert.equal(filterPatchFromSnapshot(mine, 2_500), null, 'echo matches local state');
    // Guard cleared by the echo: a genuinely different later filter is adopted.
    assert.deepEqual(filterPatchFromSnapshot({ models: ['x'] }, 3_000)!.filter, { models: ['x'] });
  });

  it('stops shielding local state once the host has had ample time to reply', () => {
    postFilter({ models: ['mine'] }, 1_000);
    assert.ok(filterPatchFromSnapshot({ models: ['host'] }, 20_000), 'host version adopted after the TTL');
  });

  it('FilterBar.update shows the hydrated preset, surface, repo and source selections', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const bar = mountFilterBar(el);
    const snap = multiSnapshot();
    bar.update(snap, 'cost');

    setState({
      filter: { rangePreset: '30d', surfaces: ['chat'], repos: ['acme/lib'], sources: ['claude-code'] },
      datePreset: '30d',
    });
    bar.update(snap, 'cost');

    assert.equal(el.querySelector('[data-preset="30d"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(el.querySelector('[data-preset="month"]')!.getAttribute('aria-pressed'), 'false');
    assert.equal(el.querySelector('[data-surface="chat"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(el.querySelector<HTMLSelectElement>('#repo-select')!.value, 'acme/lib');
    assert.equal(el.querySelector('[data-source-group="claude-code"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(posted().length, 0, 'rendering hydrated state does not post anything');
    el.remove();
  });
});

describe('re-resolving a relative date preset', () => {
  beforeEach(reset);
  afterEach(reset);

  const noon = new Date(2026, 5, 15, 12).getTime();

  it('re-posts once with today\'s range when the stored range has gone stale, and not again', () => {
    const yesterday = resolveRangePreset('7d', noon - DAY)!;
    setState({ filter: { rangePreset: '7d', range: yesterday, models: ['gpt-4o'] }, datePreset: '7d' });

    reresolveRelativeRange(noon);
    assert.equal(posted().length, 1);
    const sent = posted()[0]!.value;
    assert.deepEqual(sent.range, resolveRangePreset('7d', noon));
    assert.deepEqual(sent.models, ['gpt-4o'], 'other filter dimensions are preserved');
    assert.deepEqual(state().filter.range, sent.range, 'local state follows without waiting for the host');

    reresolveRelativeRange(noon);
    reresolveRelativeRange(noon + 5 * 60_000);
    assert.equal(posted().length, 1, 'a current range is never re-posted');
  });

  it('does not loop when the host echoes the re-resolved filter back', () => {
    setState({ filter: { rangePreset: 'today', range: resolveRangePreset('today', noon - DAY)! }, datePreset: 'today' });
    reresolveRelativeRange(noon);
    const echoed = posted()[0]!.value;

    assert.equal(filterPatchFromSnapshot(echoed, noon + 100), null);
    reresolveRelativeRange(noon + 200);
    assert.equal(posted().length, 1);
  });

  it('is a no-op for All time, for absolute ranges with no preset, and for an empty filter', () => {
    setState({ filter: { rangePreset: 'all' }, datePreset: 'all' });
    reresolveRelativeRange(noon);
    setState({ filter: { range: { start: 1, end: 2 } } });
    reresolveRelativeRange(noon);
    setState({ filter: {} });
    reresolveRelativeRange(noon);
    assert.equal(posted().length, 0);
  });

  it('treats ranges within a minute as current (clock skew) but not an hour apart', () => {
    const exact = resolveRangePreset('month', noon)!;
    setState({ filter: { rangePreset: 'month', range: { start: exact.start + 30_000, end: exact.end - 30_000 } } });
    reresolveRelativeRange(noon);
    assert.equal(posted().length, 0);

    setState({ filter: { rangePreset: 'month', range: { start: exact.start, end: exact.end - 3_600_000 } } });
    reresolveRelativeRange(noon);
    assert.equal(posted().length, 1);
  });

  it('a relative preset with no range at all (e.g. restored without one) gets its range filled in', () => {
    setState({ filter: { rangePreset: '30d' }, datePreset: '30d' });
    reresolveRelativeRange(noon);
    assert.deepEqual(posted()[0]!.value.range, resolveRangePreset('30d', noon));
  });

  it('will not re-post the identical range again within the cool-down even if the host keeps echoing a stale one', () => {
    const stale = resolveRangePreset('today', noon - DAY)!;
    setState({ filter: { rangePreset: 'today', range: stale } });
    reresolveRelativeRange(noon);
    setState({ filter: { rangePreset: 'today', range: stale } }); // host echoed the old range back
    reresolveRelativeRange(noon + 1_000);
    assert.equal(posted().length, 1);
  });
});
