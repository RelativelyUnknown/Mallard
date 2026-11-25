/**
 * Flat alerts against the frozen answers of the legacy rules language.
 *
 * The old evaluators (`ruleMatches`, `evaluateAlertRules`, the restriction
 * evaluator) were the oracle the flat alerts had to agree with. They are
 * deleted; what they answered for 2,500+ seeded cases is frozen in
 * legacyAlertOracle.json (flatAlertsCases.ts regenerates the same cases from
 * the seeds). Each test converts the legacy rules with the importer, runs them
 * through the flat evaluators and compares with the frozen answer.
 *
 * The one place the two intentionally differ is the cooldown boundary (a flat
 * rule is blocked while elapsed <= cooldown, as the built-ins always were; the
 * old rules fired again at exactly the cooldown): the series cases are built
 * 137 ms off any round number so no gap lands on it.
 */
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { builtinFlatRules } from '../../src/extension-backend/domain/flatAlerts';
import { convertLegacyRules } from '../../src/extension-backend/domain/flatAlertImport';
import { buildFlatContext, evaluateFlatRules, flatRuleMatches, parseFlatRules, pruneCooldowns } from '../../src/extension-backend/domain/flatAlerts';
import type { FlatCooldownState } from '../../src/extension-backend/domain/flatAlerts';
import { evaluateFlatRestriction } from '../../src/extension-backend/domain/flatRestriction';
import {
  BUILTIN_SEEDS,
  MATCH_SEEDS,
  RESTRICTION_SEEDS,
  SERIES_SEEDS,
  SINGLE_SEEDS,
  builtinCase,
  matchCase,
  restrictionCase,
  seriesCase,
  singleCase,
} from './flatAlertsCases';

interface Oracle {
  match: string;
  single: string[];
  series: string[][];
  restriction: string[][];
  builtin: string[][];
}

const ORACLE = JSON.parse(readFileSync(path.join(__dirname, 'legacyAlertOracle.json'), 'utf8')) as Oracle;

/** The legacy id a converted rule came from: threshold levels are `<id>:<n>`. */
const baseId = (id: string): string => id.replace(/:\d+$/, '');

describe('the legacy oracle is complete', () => {
  it('has one frozen answer per generated case', () => {
    assert.equal(ORACLE.match.length, MATCH_SEEDS);
    assert.equal(ORACLE.single.length, SINGLE_SEEDS);
    assert.equal(ORACLE.series.length, SERIES_SEEDS);
    assert.ok(ORACLE.series.every((steps) => steps.length === 8));
    assert.equal(ORACLE.restriction.length, RESTRICTION_SEEDS);
    assert.ok(ORACLE.restriction.every((steps) => steps.length === 10));
    assert.equal(ORACLE.builtin.length, BUILTIN_SEEDS);
    assert.ok(ORACLE.builtin.every((steps) => steps.length === 8));
  });
});

describe('flat rules agree with the frozen legacy answers (generated cases)', function () {
  this.timeout(60_000);

  it('a converted rule matches exactly when the legacy rule did (1500 cases)', () => {
    for (let seed = 1; seed <= MATCH_SEEDS; seed++) {
      const { rule, snapshot, history, now } = matchCase(seed);
      const { converted, skipped } = convertLegacyRules([rule]);
      assert.deepEqual(skipped, [], `seed ${seed}: ${JSON.stringify(rule)} should convert`);
      assert.deepEqual(parseFlatRules(converted).errors, [], `seed ${seed}: converted rules validate`);
      const ctx = buildFlatContext({ snapshot, ...(history ? { history } : {}), now });
      const got = converted.some((flat) => flatRuleMatches(flat, ctx));
      assert.equal(got ? '1' : '0', ORACLE.match[seed - 1], `seed ${seed}: ${JSON.stringify(rule)} -> ${JSON.stringify(converted)}`);
    }
    const matched = [...ORACLE.match].filter((c) => c === '1').length;
    assert.ok(matched > 300 && matched < 1300, `the generator should produce both outcomes (${matched} of 1500 matched)`);
  });

  it('a single evaluation fires the same rules at the same severity (rule lists of 1-4, 800 cases)', () => {
    for (let seed = 1; seed <= SINGLE_SEEDS; seed++) {
      const { rules, snapshot, history, now } = singleCase(seed);
      const { converted } = convertLegacyRules(rules);
      const ctx = buildFlatContext({ snapshot, ...(history ? { history } : {}), now });
      const flat = evaluateFlatRules(converted, ctx, {}, now);
      assert.equal(
        flat.matches.map((m) => `${baseId(m.rule.id)}:${m.severity}`).join(','),
        ORACLE.single[seed - 1],
        `seed ${seed}: ${JSON.stringify(rules)}`,
      );
    }
  });

  it('over a series with cooldowns, each step fires the same rules (150 series of 8 steps)', () => {
    for (let seed = 1; seed <= SERIES_SEEDS; seed++) {
      const { rules, steps } = seriesCase(seed);
      const { converted } = convertLegacyRules(rules);
      let state: FlatCooldownState = {};
      steps.forEach(({ snapshot, history, now }, step) => {
        const flat = evaluateFlatRules(converted, buildFlatContext({ snapshot, ...(history ? { history } : {}), now }), state, now);
        state = flat.state;
        assert.equal(
          flat.matches.map((m) => baseId(m.rule.id)).join(','),
          ORACLE.series[seed - 1]![step],
          `seed ${seed} step ${step}: ${JSON.stringify(rules)}`,
        );
      });
    }
  });

  it('holds, switches and clears the same restriction at every step (60 series of 10 steps, history included)', () => {
    for (let seed = 1; seed <= RESTRICTION_SEEDS; seed++) {
      const { rules, steps } = restrictionCase(seed);
      const { converted, skipped } = convertLegacyRules(rules);
      assert.deepEqual(skipped, [], `seed ${seed}`);
      let held: string | undefined;
      steps.forEach(({ snapshot, history, now }, step) => {
        const flat = evaluateFlatRestriction(converted, buildFlatContext({ snapshot, ...(history ? { history } : {}), now }), held);
        held = flat.active?.id;
        assert.equal(held === undefined ? '' : baseId(held), ORACLE.restriction[seed - 1]![step], `seed ${seed} step ${step}: ${JSON.stringify(rules)}`);
      });
    }
  });

  it('the built-in alerts (budget band, daily, branch cap) fire at the same steps as the old evaluator (200 configs of 8 steps)', () => {
    for (let seed = 1; seed <= BUILTIN_SEEDS; seed++) {
      const { config, branch, steps } = builtinCase(seed);
      const rules = builtinFlatRules(config, branch);
      let state: FlatCooldownState = {};
      steps.forEach(({ snapshot, now }, step) => {
        state = pruneCooldowns(state, rules, now);
        const flat = evaluateFlatRules(rules, buildFlatContext({ snapshot, now }), state, now);
        state = flat.state;
        assert.equal(flat.matches.map((m) => m.rule.id).join(','), ORACLE.builtin[seed - 1]![step], `seed ${seed} step ${step}: ${JSON.stringify(config)} on ${String(branch)}`);
      });
    }
  });
});
