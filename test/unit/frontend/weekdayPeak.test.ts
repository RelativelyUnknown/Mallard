import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { UsageSnapshot, WeekdayData } from '../../../src/extension-backend/domain/types';
import { mountWeekdayRadial } from '../../../src/extension-frontend/charts/weekdayRadial';
import { readTheme } from '../../../src/extension-frontend/theme';
import { lastOption, StubDatum } from './stubChart';

type WireWeekday = WeekdayData & { peakWeekday?: number | null };

function snapshotWith(weekday: WireWeekday): UsageSnapshot {
  const now = Date.now();
  const s = buildSnapshot(
    [makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits: 5, cost: 0.2 })],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
  s.chartData.weekdayBreakdown = weekday;
  return s;
}

/** Display-order (Mon..Sun) indices of the bars drawn in the accent colour. */
function highlighted(weekday: WireWeekday): number[] {
  const h = mountWeekdayRadial(document.createElement('div'));
  h.update(snapshotWith(weekday));
  const accent = readTheme().accent;
  const bars = lastOption(h).series![0]!.data as StubDatum[];
  assert.equal(bars.length, 7);
  return bars.flatMap((d, i) => (d.itemStyle?.color === accent ? [i] : []));
}

describe('weekdayRadial peak highlight', () => {
  // totals are Sun=0 … Sat=6; the chart displays Mon=0 … Sun=6.
  const totals = [1, 2, 3, 4, 5, 6, 7];

  it('highlights the host\'s peakWeekday (Sun=0) at its Monday-first display position', () => {
    assert.deepEqual(highlighted({ totals, peak: 6, peakWeekday: 6 }), [5], 'Saturday is the 6th bar');
    assert.deepEqual(highlighted({ totals, peak: 0, peakWeekday: 0 }), [6], 'Sunday is the last bar');
    assert.deepEqual(highlighted({ totals, peak: 1, peakWeekday: 1 }), [0], 'Monday is the first bar');
  });

  it('trusts peakWeekday over the legacy peak index when they disagree', () => {
    // The old derivation, (peak + 6) % 7, would have lit Sunday (index 6) here.
    assert.deepEqual(highlighted({ totals, peak: 0, peakWeekday: 6 }), [5]);
  });

  it('highlights nothing when peakWeekday is null (no weekday activity to single out)', () => {
    assert.deepEqual(highlighted({ totals, peak: 0, peakWeekday: null }), []);
  });

  it('hosts that predate peakWeekday still get the peak highlighted from `peak`', () => {
    assert.deepEqual(highlighted({ totals, peak: 3 }), [2], 'Wednesday');
  });
});
