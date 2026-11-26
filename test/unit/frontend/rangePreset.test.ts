import { strict as assert } from 'assert';
import { isRelativePreset, resolveRangePreset } from '../../../src/extension-backend/domain/rangePreset';
import { DAY_MS } from '../../../src/extension-backend/util/time';

const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number =>
  new Date(y, m - 1, d, h, min, s, ms).getTime();

describe('resolveRangePreset — day and month boundaries', () => {
  it("'today' spans local midnight to the next local midnight", () => {
    const now = local(2026, 6, 15, 13, 45);
    assert.deepEqual(resolveRangePreset('today', now), { start: local(2026, 6, 15), end: local(2026, 6, 16) });
  });

  it("'today' at exactly 00:00:00.000 starts at that instant, and at 23:59:59.999 still ends at the next midnight", () => {
    assert.equal(resolveRangePreset('today', local(2026, 6, 15))!.start, local(2026, 6, 15));
    const lastMs = local(2026, 6, 15, 23, 59, 59, 999);
    assert.deepEqual(resolveRangePreset('today', lastMs), { start: local(2026, 6, 15), end: local(2026, 6, 16) });
  });

  it("'7d' covers today plus the six calendar days before it", () => {
    const r = resolveRangePreset('7d', local(2026, 6, 15, 9))!;
    assert.equal(r.start, local(2026, 6, 9));
    assert.equal(r.end, local(2026, 6, 16));
  });

  it("'30d' covers today plus the twenty-nine calendar days before it", () => {
    const r = resolveRangePreset('30d', local(2026, 6, 15, 9))!;
    assert.equal(r.start, local(2026, 5, 17));
    assert.equal(r.end, local(2026, 6, 16));
  });

  it("'7d' reaches back across a month boundary", () => {
    // Mar 3 2026: six days back is Feb 25 (2026 is not a leap year).
    assert.equal(resolveRangePreset('7d', local(2026, 3, 3, 12))!.start, local(2026, 2, 25));
  });

  it("'30d' reaches back across a year boundary", () => {
    assert.equal(resolveRangePreset('30d', local(2026, 1, 10, 12))!.start, local(2025, 12, 12));
  });

  it("'month' runs from the 1st to the 1st of the next month", () => {
    assert.deepEqual(resolveRangePreset('month', local(2026, 6, 15, 12)), {
      start: local(2026, 6, 1),
      end: local(2026, 7, 1),
    });
  });

  it("'month' on the last instant of a month still ends at the next month's start", () => {
    const now = local(2026, 1, 31, 23, 59, 59, 999);
    assert.deepEqual(resolveRangePreset('month', now), { start: local(2026, 1, 1), end: local(2026, 2, 1) });
  });

  it("'month' in December rolls the end into January of the next year", () => {
    assert.equal(resolveRangePreset('month', local(2026, 12, 31, 12))!.end, local(2027, 1, 1));
  });

  it("'month' respects leap-year February", () => {
    const r = resolveRangePreset('month', local(2028, 2, 10))!;
    assert.equal(Math.round((r.end - r.start) / DAY_MS), 29);
  });

  it("'all' has no range", () => {
    assert.equal(resolveRangePreset('all', local(2026, 6, 15)), undefined);
  });

  it('every resolved range contains the instant it was resolved at (new events always fall inside)', () => {
    const now = local(2026, 6, 15, 23, 59, 59, 999);
    for (const preset of ['today', '7d', '30d', 'month'] as const) {
      const r = resolveRangePreset(preset, now)!;
      assert.ok(r.start <= now && now < r.end, `${preset} must contain now`);
    }
  });

  it('re-resolving a day later moves the range forward (the stale-range bug)', () => {
    const day1 = resolveRangePreset('7d', local(2026, 6, 15, 12))!;
    const day2 = resolveRangePreset('7d', local(2026, 6, 16, 12))!;
    assert.equal(day2.start - day1.start, DAY_MS);
    assert.equal(day2.end - day1.end, DAY_MS);
    // An event from the second day lies outside the first day's range.
    assert.ok(local(2026, 6, 16, 1) >= day1.end);
    assert.ok(local(2026, 6, 16, 1) < day2.end);
  });
});

describe('isRelativePreset', () => {
  it('is true for every preset that moves with the clock and false for all/undefined', () => {
    for (const p of ['today', '7d', '30d', 'month'] as const) assert.equal(isRelativePreset(p), true, p);
    assert.equal(isRelativePreset('all'), false);
    assert.equal(isRelativePreset(undefined), false);
  });
});

describe('resolveRangePreset — DST', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = 'America/New_York';
  });
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('the test timezone really observes DST (guards the tests below against a no-op TZ)', () => {
    assert.equal(local(2026, 3, 9) - local(2026, 3, 8), 23 * 3_600_000);
  });

  it("'today' on the spring-forward day is 23 hours long and still midnight-aligned", () => {
    const r = resolveRangePreset('today', local(2026, 3, 8, 15))!;
    assert.equal(r.end - r.start, 23 * 3_600_000);
    assert.equal(new Date(r.start).getHours(), 0);
    assert.equal(new Date(r.end).getHours(), 0);
  });

  it("'today' on the fall-back day is 25 hours long and still midnight-aligned", () => {
    const r = resolveRangePreset('today', local(2026, 11, 1, 15))!;
    assert.equal(r.end - r.start, 25 * 3_600_000);
    assert.equal(new Date(r.start).getHours(), 0);
    assert.equal(new Date(r.end).getHours(), 0);
  });

  it("'7d' spanning spring-forward starts at local midnight, not an hour off", () => {
    // Mar 10 minus six 24h blocks would land at 23:00 on Mar 3 (EST/EDT shift).
    const r = resolveRangePreset('7d', local(2026, 3, 10, 12))!;
    const start = new Date(r.start);
    assert.equal(start.getDate(), 4);
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
  });

  it("'30d' spanning fall-back starts at local midnight", () => {
    const r = resolveRangePreset('30d', local(2026, 11, 20, 12))!;
    const start = new Date(r.start);
    assert.equal(start.getMonth(), 9); // October
    assert.equal(start.getDate(), 22);
    assert.equal(start.getHours(), 0);
  });

  it("'month' is midnight-aligned at both ends across the DST change", () => {
    const r = resolveRangePreset('month', local(2026, 3, 20))!;
    assert.equal(r.start, local(2026, 3, 1));
    assert.equal(r.end, local(2026, 4, 1));
    // March 2026 has 31 days but one of them is 23h long.
    assert.equal(r.end - r.start, 31 * DAY_MS - 3_600_000);
  });
});
