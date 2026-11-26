/**
 * The re-recorded `alerts` golden (test/golden/expected/alerts*.json, driven by
 * AlertService + RestrictionEngine on the flat rules) against what the old
 * recording said, frozen below as OLD. The old recording came from the JSON
 * rules language; it differs from the new one only as INTENDED_DIFFERENCES.md
 * lists (D7, D8, D15, B6), and each difference is asserted here rather than
 * waved through.
 */
import { strict as assert } from 'assert';
import { alertSequence } from '../golden/pipeline';
import { loadExpected } from '../golden/support/canon';
import { diffGolden } from '../golden/support/diff';
import { GOLDEN_TZS } from '../golden/support/time';

interface RecordedStep {
  local: string;
  warnings: string[];
  restriction: { active: boolean; ruleId: string; reasonMessage: string; isRestricted: boolean };
}

/** [local time, toasts by rule id, restriction rule id, isRestricted] as the old recording had them (identical in every zone). */
const OLD: Array<[string, string[], string, boolean]> = [
  ['01-31T21:00', [], '', false],
  ['01-31T21:30', [], '', false],
  ['01-31T22:00', ['builtin:budget:80', 'builtin:daily'], '', false],
  ['01-31T22:30', ['builtin:branch:feature/x', 'busy-day', 'month-escalation:1', 'sonnet-heavy'], '', false],
  ['01-31T22:40', ['velocity-rule'], '', false],
  ['01-31T22:45', [], '', false],
  ['01-31T23:00', ['builtin:velocity', 'month-escalation:2', 'velocity-rule'], 'restrict-heavy-day', true],
  ['01-31T23:30', ['builtin:budget:100', 'month-escalation:3', 'sonnet-heavy'], 'restrict-over-budget', false],
  ['02-01T00:00', [], '', false],
  ['02-01T00:30', [], '', false],
  ['02-01T01:00', ['builtin:budget:80', 'builtin:daily'], '', false],
  ['02-01T01:30', [], '', false],
  ['02-01T05:30', ['builtin:budget:80', 'builtin:branch:feature/x'], 'restrict-snoozed', true],
  ['02-01T09:30', ['busy-day'], 'restrict-snoozed', true],
  ['02-01T09:35', ['builtin:budget:80', 'builtin:branch:feature/x'], 'restrict-snoozed', true],
];

/** The fixed-format text a rule's toast starts with, by rule id. */
const TOAST_OF: Record<string, string> = {
  'builtin:budget:80': 'budget.percentOfBudget >= 0.8 (now ',
  'builtin:budget:100': 'budget.percentOfBudget >= 1 (now ',
  'builtin:daily': 'today.credits >= 50 (now ',
  'builtin:velocity': 'velocity.creditsPerHour >= 100 (now ',
  'builtin:branch:feature/x': 'currentBranchCredits >= 40 (now ',
  'busy-day': 'today.credits > 80 (now ',
  'month-escalation:1': 'month.credits > 200 (now ',
  'month-escalation:2': 'month.credits > 260 (now ',
  'month-escalation:3': 'month.credits > 300 (now ',
  'sonnet-heavy': 'model:claude-sonnet-4-5-20250929.credits > 120 (now ',
  'velocity-rule': 'velocity.creditsPerHour > 90 (now ',
};

function ruleOfToast(text: string): string {
  const hit = Object.entries(TOAST_OF).find(([, prefix]) => text.startsWith(prefix));
  assert.ok(hit, `unrecognised toast: ${text}`);
  return hit[0];
}

for (const tz of GOLDEN_TZS) {
  describe(`the alerts golden against the old recording — ${tz}`, () => {
    let recorded: RecordedStep[];
    before(async () => {
      recorded = (await loadExpected('alerts', tz)) as RecordedStep[];
    });

    it('is what the harness records today (this runs without the DuckDB sqlite extension that the full pipeline test needs)', async function () {
      this.timeout(30_000);
      const diff = diffGolden(await alertSequence({ tz }), recorded);
      assert.equal(diff, null, `alerts (${tz}) no longer matches the recording:\n${diff ?? ''}`);
    });

    it('records the same script', () => {
      assert.deepEqual(recorded.map((s) => s.local.slice(5)), OLD.map((s) => s[0]));
    });

    it('D15: every toast is the fixed format, "<metric> <op> <value> (now <current>)"', () => {
      for (const s of recorded) {
        for (const w of s.warnings) assert.match(w, /^\S+ (>|>=|<|<=|==|!=) -?[\d.]+ \(now -?[\d.]+\)$/, w);
      }
    });

    it('raises the same toasts at the same steps, except the documented cooldown boundary', () => {
      // `sonnet-heavy` last fired at 22:30 with a 1 h cooldown, and the old rules language raised it again at EXACTLY
      // 23:30. Flat rules treat the boundary like the built-ins always did (blocked while elapsed <= cooldown), which the
      // same recording shows for the 4 h built-ins; only that firing goes.
      const expected = OLD.map(([local, toasts]) => (local === '01-31T23:30' ? toasts.filter((id) => id !== 'sonnet-heavy') : toasts));
      assert.deepEqual(
        recorded.map((s) => s.warnings.map(ruleOfToast)),
        expected,
      );
    });

    it('D7: the built-in velocity toast carries the least-squares rate, and fires where that rate crosses the threshold', () => {
      const at = (local: string) => recorded.find((s) => s.local.endsWith(local))!;
      assert.ok(at('01-31T23:00').warnings.includes('velocity.creditsPerHour >= 100 (now 101.10)'));
      // The same number the rule-based alert has always read; the old built-in said "about 100" (first to last).
      assert.ok(at('01-31T23:00').warnings.includes('velocity.creditsPerHour > 90 (now 101.10)'));
      // At 22:40 the least-squares rate (91.15) is under the built-in threshold of 100: only the rule fires.
      assert.deepEqual(at('01-31T22:40').warnings, ['velocity.creditsPerHour > 90 (now 91.15)']);
    });

    it('D8: the month rollover re-fires the 80 % alert on the first snapshot of the new month', () => {
      const at = (local: string) => recorded.find((s) => s.local.endsWith(local))!.warnings.map(ruleOfToast);
      assert.ok(at('01-31T22:00').includes('builtin:budget:80'));
      assert.ok(at('02-01T01:00').includes('builtin:budget:80'), 'only 3 h after the January firing, but a new YYYY-MM key');
    });

    it('B6 and D15: restriction differs from the old recording only where a velocity restriction now matches or the importer skipped a rule', () => {
      recorded.forEach((s, i) => {
        const [local, , oldRule, oldRestricted] = OLD[i]!;
        const now = s.restriction;
        if (now.ruleId === 'restrict-velocity') return; // B6: never matched before, now follows the alert history
        if (oldRule === 'restrict-snoozed') {
          // The importer reports a rule with `snoozeUntil` instead of converting it.
          assert.equal(now.ruleId, '', local);
          return;
        }
        assert.deepEqual([now.ruleId, now.isRestricted], [oldRule, oldRestricted], local);
      });
    });

    it('B6: the velocity restriction follows the least-squares rate of the alert history', () => {
      assert.deepEqual(
        recorded.map((s) => [s.local.slice(5), s.restriction.ruleId, s.restriction.isRestricted] as const),
        [
          ['01-31T21:00', '', false], // one sample: no rate yet
          ['01-31T21:30', 'restrict-velocity', true],
          ['01-31T22:00', 'restrict-velocity', true],
          ['01-31T22:30', 'restrict-velocity', true],
          ['01-31T22:40', 'restrict-velocity', true],
          ['01-31T22:45', 'restrict-velocity', true],
          ['01-31T23:00', 'restrict-heavy-day', true], // declared before the velocity rule
          ['01-31T23:30', 'restrict-over-budget', false], // declared first, and snoozed for 30 minutes
          ['02-01T00:00', '', false], // the counter fell: the rate window restarts, and the snooze is over
          ['02-01T00:30', 'restrict-velocity', true],
          ['02-01T01:00', 'restrict-velocity', true],
          ['02-01T01:30', 'restrict-velocity', true],
          ['02-01T05:30', '', false], // the 01:30 sample is more than an hour old
          ['02-01T09:30', '', false],
          ['02-01T09:35', 'restrict-velocity', true],
        ],
      );
    });

    it('the restriction reason is the rule condition, without a value that would change with every snapshot', () => {
      for (const s of recorded) {
        if (s.restriction.active) assert.match(s.restriction.reasonMessage, /^\S+ (>|>=|<|<=|==|!=) -?[\d.]+$/);
      }
    });
  });
}
