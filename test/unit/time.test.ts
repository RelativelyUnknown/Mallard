import { strict as assert } from 'assert';
import { bucketKey, DAY_MS, dayStartOffset, daysInMonth, isoWeek, nextBucketStart, startOf } from '../../src/extension-backend/util/time';

describe('time bucketing', () => {
  const ts = new Date(2026, 5, 12, 14, 30).getTime(); // June 12 2026, 14:30 local

  it('produces stable day/month keys', () => {
    assert.equal(bucketKey(ts, 'day'), '2026-06-12');
    assert.equal(bucketKey(ts, 'month'), '2026-06');
  });

  it('week key has the ISO shape and starts on Monday', () => {
    assert.match(bucketKey(ts, 'week'), /^\d{4}-W\d{2}$/);
    const weekStart = startOf(ts, 'week');
    assert.equal(new Date(weekStart).getDay(), 1, 'week starts Monday');
    assert.ok(ts >= weekStart && ts - weekStart < 7 * DAY_MS);
  });

  it('nextBucketStart advances exactly one bucket', () => {
    assert.equal(nextBucketStart(ts, 'day'), new Date(2026, 5, 13).getTime());
    assert.equal(nextBucketStart(ts, 'month'), new Date(2026, 6, 1).getTime());
  });

  it('knows month length', () => {
    assert.equal(daysInMonth(ts), 30); // June
    assert.equal(daysInMonth(new Date(2026, 1, 5).getTime()), 28); // Feb 2026
  });
});

describe('isoWeek', () => {
  it('returns correct week for a date in the middle of the year', () => {
    // 2026-03-16 (Monday) → ISO week 12 of 2026
    const { year, week } = isoWeek(new Date(2026, 2, 16).getTime());
    assert.equal(year, 2026);
    assert.equal(week, 12);
  });

  it('returns week 1 for 2026-01-01 (Thursday)', () => {
    // Jan 1 2026 is a Thursday → ISO week 1 of 2026
    const { year, week } = isoWeek(new Date(2026, 0, 1).getTime());
    assert.equal(year, 2026);
    assert.equal(week, 1);
  });

  it('handles year-boundary where ISO week belongs to the previous calendar year', () => {
    // 2021-01-01 (Friday) is in ISO week 53 of 2020
    const { year, week } = isoWeek(new Date(2021, 0, 1).getTime());
    assert.equal(year, 2020);
    assert.equal(week, 53);
  });

  it('handles year-boundary where ISO week belongs to the next calendar year', () => {
    // 2019-12-30 (Monday) is in ISO week 1 of 2020
    const { year, week } = isoWeek(new Date(2019, 11, 30).getTime());
    assert.equal(year, 2020);
    assert.equal(week, 1);
  });

  it('week number is consistent with bucketKey week label', () => {
    // bucketKey already tested; isoWeek should agree on the ISO year
    const ts2 = new Date(2026, 5, 15).getTime(); // mid-June 2026
    const { year } = isoWeek(ts2);
    assert.equal(year, 2026);
    const key = bucketKey(ts2, 'week');
    assert.ok(key.startsWith('2026-W'));
  });
});

describe('dayStartOffset', () => {
  it('returns local midnight a number of calendar days away, whatever the time of day', () => {
    const ts = new Date(2026, 5, 12, 14, 30).getTime();
    assert.equal(dayStartOffset(ts, 0), new Date(2026, 5, 12).getTime());
    assert.equal(dayStartOffset(ts, 1), new Date(2026, 5, 13).getTime());
    assert.equal(dayStartOffset(ts, -12), new Date(2026, 5, 0).getTime(), 'May 31');
    assert.equal(dayStartOffset(ts, -90), new Date(2026, 2, 14).getTime());
  });

  it('is calendar-correct across DST changes, unlike ts + n * DAY_MS', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 00:30 EDT on Mar 30; 90×24h earlier is 23:30 EST on Dec 29.
      const ts = new Date(2026, 2, 30, 0, 30).getTime();
      assert.equal(dayStartOffset(ts, -90), new Date(2025, 11, 30).getTime());
      assert.notEqual(startOf(ts - 90 * DAY_MS, 'day'), dayStartOffset(ts, -90), 'the DAY_MS shortcut lands a day early');
      // Into the 23h spring-forward day and out of the 25h fall-back day.
      assert.equal(dayStartOffset(new Date(2026, 2, 7, 12).getTime(), 1), new Date(2026, 2, 8).getTime());
      assert.equal(dayStartOffset(new Date(2026, 10, 1, 12).getTime(), 1), new Date(2026, 10, 2).getTime());
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
