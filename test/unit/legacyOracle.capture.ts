/**
 * ONE-OFF: captures what the OLD alert evaluators answered for the generated
 * cases of flatAlertsCases.ts, into legacyAlertOracle.json (the frozen oracle
 * behind flatAlertsFrozen.test.ts). It needs the old rules language, so it ran
 * once on the pre-deletion code (git b156a14 + the flatAlertsCases generators)
 * and is deleted together with that language.
 *
 *     npx tsx --require ./test/unit/setup/vscode-mock.cjs test/unit/legacyOracle.capture.ts
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateAlerts } from '../../src/extension-backend/domain/alerts';
import { RestrictionEngine } from '../../src/extension-backend/app/RestrictionEngine';
import { evaluateAlertRules, ruleMatches } from '../../src/extension-backend/domain/alertRules';
import { buildRuleContext } from '../../src/extension-backend/domain/expr/context';
import type { AlertRule } from '../../src/extension-backend/domain/types';
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

const asLegacy = (rules: unknown): AlertRule[] => rules as AlertRule[];

async function main(): Promise<void> {
  let match = '';
  for (let seed = 1; seed <= MATCH_SEEDS; seed++) {
    const { rule, snapshot, history, now } = matchCase(seed);
    const ctx = buildRuleContext({ snapshot, ...(history ? { history } : {}), now });
    match += ruleMatches(asLegacy([rule])[0]!, ctx, now) ? '1' : '0';
  }

  const single: string[] = [];
  for (let seed = 1; seed <= SINGLE_SEEDS; seed++) {
    const { rules, snapshot, history, now } = singleCase(seed);
    const fired = evaluateAlertRules({ snapshot, ...(history ? { history } : {}), rules: asLegacy(rules), fired: new Map(), now });
    single.push(fired.map((f) => `${f.ruleId}:${f.severity}`).join(','));
  }

  const series: string[][] = [];
  for (let seed = 1; seed <= SERIES_SEEDS; seed++) {
    const { rules, steps } = seriesCase(seed);
    const fired = new Map<string, number>();
    series.push(
      steps.map(({ snapshot, history, now }) =>
        evaluateAlertRules({ snapshot, ...(history ? { history } : {}), rules: asLegacy(rules), fired, now }).map((f) => f.ruleId).join(','),
      ),
    );
  }

  // The old built-in alert keys, as the flat rule that replaces each.
  const builtinId = (key: string): string =>
    key.startsWith('budget-100-') ? 'builtin:budget:100'
      : key.startsWith('budget-80-') ? 'builtin:budget:80'
        : key.startsWith('daily-') ? 'builtin:daily'
          : key.replace(/^branch:/, 'builtin:branch:');
  const builtin: string[][] = [];
  for (let seed = 1; seed <= BUILTIN_SEEDS; seed++) {
    const { config, steps } = builtinCase(seed);
    const fired = new Map<string, number>();
    const history: Array<{ ts: number; todayCredits: number }> = [];
    builtin.push(
      steps.map(({ snapshot, now }) => {
        const events = evaluateAlerts(snapshot as never, history, config, fired, now);
        for (const e of events) fired.set(e.key, now);
        return events.map((e) => builtinId(e.key)).join(',');
      }),
    );
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-oracle-'));
  const restriction: string[][] = [];
  try {
    const engine = new RestrictionEngine(dir);
    for (let seed = 1; seed <= RESTRICTION_SEEDS; seed++) {
      const { rules, steps } = restrictionCase(seed);
      await engine.clearAll();
      const held: string[] = [];
      for (const { snapshot, history, now } of steps) {
        const state = await engine.reconcile({ snapshot, ...(history ? { history } : {}), rules: asLegacy(rules), now, signedIn: false });
        held.push(state.active ? state.ruleId : '');
      }
      restriction.push(held);
    }
    engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // One line per case so a diff of a re-capture stays readable.
  const lines = (items: unknown[]): string => `[\n    ${items.map((i) => JSON.stringify(i)).join(',\n    ')}\n  ]`;
  const text = [
    '{',
    '  "_comment": "Frozen answers of the old alert evaluators (ruleMatches, evaluateAlertRules, RestrictionEngine.reconcile) for the seeded cases of flatAlertsCases.ts, captured at git b156a14 before the rules language was deleted. match: one char per case (1 = the legacy rule matched). single: per case the rules that fired as id:severity. series: per case, per step, the rule ids that fired (cooldowns carried over steps). restriction: per case, per step, the rule id holding the restriction (empty = none). builtin: per case, per step, the built-in alerts that fired (old keys mapped to builtin:* rule ids; velocity off).",',
    `  "match": ${JSON.stringify(match)},`,
    `  "single": ${lines(single)},`,
    `  "series": ${lines(series)},`,
    `  "restriction": ${lines(restriction)},`,
    `  "builtin": ${lines(builtin)}`,
    '}',
    '',
  ].join('\n');
  await fs.writeFile(path.join(__dirname, 'legacyAlertOracle.json'), text);
  const matched = [...match].filter((c) => c === '1').length;
  console.log(`match ${matched}/${match.length}; single ${single.filter(Boolean).length}/${single.length} non-empty; series ${series.flat().filter(Boolean).length} firing steps; restriction ${restriction.flat().filter(Boolean).length} held steps; builtin ${builtin.flat().filter(Boolean).length} firing steps`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
