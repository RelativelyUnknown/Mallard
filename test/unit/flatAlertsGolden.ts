/**
 * Replays the recorded alert series (test/golden/pipeline.ts `alertSequence`,
 * recorded in test/golden/expected/alerts.*.json) through the flat alert code.
 *
 * The script, the legacy rules and the snapshot assembly are copied from the
 * harness (which drives today's DuckDB-era stack and is replaced by later
 * streams): snapshots come from the real `UsageService` over a stub reader, so
 * they are the same objects the old alert code saw. Nothing here imports the
 * harness, DuckDB or the old alert evaluators.
 */
import { UsageService } from '../../src/extension-backend/app/UsageService';
import type { AlertService } from '../../src/extension-backend/app/AlertService';
import type { UserConfigStore } from '../../src/extension-backend/app/UserConfigStore';
import type { PricingService } from '../../src/extension-backend/pricing/PricingService';
import type { CurrencyService } from '../../src/extension-backend/pricing/CurrencyService';
import type { IngestService } from '../../src/extension-backend/ingest/IngestService';
import type { IEventSnapshotReader, SnapshotSourceData } from '../../src/extension-backend/store/EventReader';
import type { FlatAlertRule } from '../../src/extension-backend/domain/contracts';
import type { HistorySample } from '../../src/extension-backend/domain/expr/context';
import { convertLegacyRules } from '../../src/extension-backend/domain/flatAlertImport';
import {
  buildFlatContext,
  builtinFlatRules,
  evaluateFlatRules,
  pruneCooldowns,
} from '../../src/extension-backend/domain/flatAlerts';
import type { FlatAlertMatch, FlatCooldownState } from '../../src/extension-backend/domain/flatAlerts';
import { evaluateFlatRestriction } from '../../src/extension-backend/domain/flatRestriction';
import type { AlertRule, SnapshotData, UserConfig } from '../../src/extension-backend/domain/types';
import { startOf } from '../../src/extension-backend/util/time';
import { localInstant, withClock, withTz } from '../golden/support/time';

interface ScriptStep {
  local: string;
  today: number;
  todayCost: number;
  mtd: number;
  mtdCost: number;
  branchCredits: number;
  action?: 'snooze-restriction-30m';
}

// Copied from test/golden/pipeline.ts (ALERT_SCRIPT).
export const ALERT_SCRIPT: ScriptStep[] = [
  { local: '2026-01-31T21:00', today: 10, todayCost: 0.4, mtd: 150, mtdCost: 60, branchCredits: 20 },
  { local: '2026-01-31T21:30', today: 30, todayCost: 1.2, mtd: 170, mtdCost: 70, branchCredits: 25 },
  { local: '2026-01-31T22:00', today: 60, todayCost: 2.4, mtd: 200, mtdCost: 82, branchCredits: 38 },
  { local: '2026-01-31T22:30', today: 95, todayCost: 3.8, mtd: 235, mtdCost: 85, branchCredits: 41 },
  { local: '2026-01-31T22:40', today: 125, todayCost: 5, mtd: 240, mtdCost: 85.5, branchCredits: 42 },
  { local: '2026-01-31T22:45', today: 132, todayCost: 5.3, mtd: 245, mtdCost: 86, branchCredits: 42 },
  { local: '2026-01-31T23:00', today: 160, todayCost: 6.4, mtd: 300, mtdCost: 99, branchCredits: 45 },
  { local: '2026-01-31T23:30', today: 165, todayCost: 6.6, mtd: 306, mtdCost: 101, branchCredits: 46, action: 'snooze-restriction-30m' },
  { local: '2026-02-01T00:00', today: 5, todayCost: 0.2, mtd: 5, mtdCost: 2, branchCredits: 0 },
  { local: '2026-02-01T00:30', today: 12, todayCost: 0.5, mtd: 12, mtdCost: 5, branchCredits: 3 },
  { local: '2026-02-01T01:00', today: 55, todayCost: 2.2, mtd: 55, mtdCost: 86, branchCredits: 41 },
  { local: '2026-02-01T01:30', today: 56, todayCost: 2.3, mtd: 56, mtdCost: 86, branchCredits: 41 },
  { local: '2026-02-01T05:30', today: 57, todayCost: 2.3, mtd: 57, mtdCost: 86, branchCredits: 41 },
  { local: '2026-02-01T09:30', today: 90, todayCost: 3.6, mtd: 90, mtdCost: 88, branchCredits: 41 },
  { local: '2026-02-01T09:35', today: 91, todayCost: 3.6, mtd: 91, mtdCost: 88, branchCredits: 41 },
];

export const SONNET_ID = 'claude-sonnet-4-5-20250929';

/** The legacy rules of the recording (copied from pipeline.ts `alertRules`). */
export function legacyAlertRules(snoozeUntil: string): AlertRule[] {
  return [
    { id: 'busy-day', severity: 'warning', cooldown: '2h', message: 'Busy day: {{today.credits}} credits so far', conditions: [{ field: 'today.credits', op: '>', value: 80 }] },
    {
      id: 'month-escalation', severity: 'info', message: 'Month at {{month.credits}} credits',
      thresholds: [
        { field: 'month.credits', op: '>', value: 200, severity: 'info', cooldown: '45m' },
        { field: 'month.credits', op: '>', value: 260, severity: 'warning', cooldown: '45m' },
        { field: 'month.credits', op: '>', value: 300, severity: 'critical', cooldown: '45m' },
      ],
    },
    { id: 'sonnet-heavy', severity: 'info', cooldown: '1h', message: 'Sonnet used {{ model["claude-sonnet-4-5-20250929"].credits }} credits', when: { '>': [{ var: `model["${SONNET_ID}"].credits` }, 120] } },
    { id: 'velocity-rule', severity: 'info', cooldown: '15m', message: 'Rule velocity {{velocity.creditsPerHour}} cr/h', when: { '>': [{ var: 'velocity.creditsPerHour' }, 90] } },
    { id: 'needs-signin', severity: 'warning', requiresAuth: true, message: 'Signed-in only rule', conditions: [{ field: 'today.credits', op: '>', value: 0 }] },
    { id: 'restrict-over-budget', severity: 'critical', message: 'Budget exceeded', when: { '>=': [{ var: 'budget.percentOfBudget' }, 1] }, restrict: { reEnableWhen: { '<': [{ var: 'budget.percentOfBudget' }, 0.9] } } },
    { id: 'restrict-heavy-day', severity: 'critical', message: 'Heavy day', conditions: [{ field: 'today.credits', op: '>', value: 150 }], restrict: {} },
    { id: 'restrict-snoozed', severity: 'warning', message: 'Snoozed rule', conditions: [{ field: 'today.credits', op: '>', value: 20 }], snoozeUntil, restrict: {} },
    { id: 'restrict-velocity', severity: 'warning', message: 'Spending fast', when: { '>': [{ var: 'velocity.creditsPerHour' }, 1] }, restrict: {} },
  ];
}

export const ALERT_CONFIG: UserConfig = {
  monthlyBudget: 100,
  includedCredits: 300,
  dailyCreditAlert: 50,
  alerts: { velocityEnabled: true, velocityCreditsPerHour: 100 },
  version: 1,
  branchBudgets: { 'feature/x': 40 },
};

const BRANCH = 'feature/x';

/** Copied from pipeline.ts `scriptData`: what the store would have read at this step. */
function scriptData(step: ScriptStep, now: number): SnapshotSourceData {
  const totals = (credits: number, cost: number, count: number) => ({ credits, cost, tokens: credits * 1000, eventCount: count });
  return {
    totals: { all: totals(step.mtd, step.mtdCost, 40), mtd: totals(step.mtd, step.mtdCost, 40), today: totals(step.today, step.todayCost, 6) },
    estimatedEventCount: 40,
    daily: [{ dayStart: startOf(now, 'day'), credits: step.today, cost: step.todayCost, tokens: step.today * 1000, eventCount: 6, catInput: 0, catOutput: 0, catCacheRead: 0, catCacheCreation: 0, catThinking: 0, catTool: 0 }],
    models: [{ modelId: SONNET_ID, credits: step.mtd * 0.6, cost: step.mtdCost * 0.6, tokens: step.mtd * 600 }, { modelId: 'gpt-4.1', credits: step.mtd * 0.4, cost: step.mtdCost * 0.4, tokens: step.mtd * 400 }],
    repos: [{ repo: 'alpha', credits: step.mtd, cost: step.mtdCost, tokens: step.mtd * 1000, heuristicShare: 0 }],
    languages: [],
    hourly: [],
    categories: [],
    sankey: [],
    dims: { models: [SONNET_ID, 'gpt-4.1'], surfaces: ['chat'], sources: ['claude-code'], repos: ['alpha'] },
    weekday: [0, 0, 0, 0, 0, 0, 0],
  };
}

/** The unfiltered snapshots UsageService computes for the script, with the branch fields the harness got from a fake git API. */
async function recordSnapshots(times: number[]): Promise<SnapshotData[]> {
  let current = 0;
  const reader: IEventSnapshotReader = {
    readSnapshotCache: async () => scriptData(ALERT_SCRIPT[current]!, times[current]!),
    readFilteredSnapshot: async () => scriptData(ALERT_SCRIPT[current]!, times[current]!),
    creditsByBranch: async () => 0,
  };
  const noop = { process() {}, dispose() {}, onAlertFired: () => ({ dispose() {} }) } as unknown as AlertService;
  const svc = new UsageService(
    reader,
    { pricePerCredit: 0.04 } as unknown as PricingService,
    { getStatus: () => ({ kind: 'ok' as const }), dispose() {} } as unknown as IngestService,
    { get: () => ALERT_CONFIG, onDidChange: () => ({ dispose() {} }) } as unknown as UserConfigStore,
    { currentRates: () => ({}) } as unknown as CurrencyService,
    undefined,
    { showWarningMessage: async () => undefined, executeCommand: async () => undefined } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
    noop,
  );
  const snapshots: SnapshotData[] = [];
  svc.onDidComputeUnfiltered((s) => snapshots.push(s));
  try {
    for (let i = 0; i < ALERT_SCRIPT.length; i++) {
      current = i;
      await withClock(times[i]!, () => svc.setFilter({}));
    }
  } finally {
    svc.dispose();
  }
  return snapshots.map((s, i) => ({ ...s, currentBranch: BRANCH, currentBranchCredits: ALERT_SCRIPT[i]!.branchCredits }));
}

/** The rolling history AlertService keeps: one sample per snapshot, the last hour only. */
const HISTORY_WINDOW_MS = 3_600_000;

export interface ReplayStep {
  local: string;
  /** Ids of the rules that toasted, in order. */
  toasts: string[];
  /** Every firing of the step (toasting or not). */
  matches: FlatAlertMatch[];
  /** The restriction after this step, by rule id (empty string = none), emulating RestrictionEngine's snooze handling. */
  restriction: { ruleId: string; isRestricted: boolean };
  /** Same, with the rule list that has no velocity restriction (the recording's other restrict rules only). */
  restrictionWithoutVelocity: { ruleId: string; isRestricted: boolean };
}

export interface Replay {
  steps: ReplayStep[];
  converted: FlatAlertRule[];
  skipped: Array<{ id: string; reason: string }>;
  rules: FlatAlertRule[];
  /** The cooldown state after the last step (what AlertService would have persisted). */
  cooldowns: FlatCooldownState;
}

/** The snooze handling of RestrictionEngine (persisted state + `userOverrideUntil`), which stays outside the pure evaluator. */
class EngineEmulation {
  held: string | undefined;
  override: number | null = null;
  constructor(private readonly rules: FlatAlertRule[]) {}

  reconcile(ctx: ReturnType<typeof buildFlatContext>, now: number): void {
    if (this.override !== null && this.override <= now) this.override = null; // expireOverride
    if (this.override !== null && this.held !== undefined) return; // a snoozed active restriction is left as is
    const result = evaluateFlatRestriction(this.rules, ctx, this.held);
    // A restriction that starts (or switches rule) forgets the earlier snooze, as RestrictionEngine.reconcile does.
    if (result.active && result.active.id !== this.held) this.override = null;
    this.held = result.active?.id;
  }

  snooze(now: number, minutes: number): void {
    this.override = now + minutes * 60_000;
  }

  state(now: number): { ruleId: string; isRestricted: boolean } {
    return { ruleId: this.held ?? '', isRestricted: this.held !== undefined && !(this.override !== null && this.override > now) };
  }
}

export async function replayFlat(tz: string): Promise<Replay> {
  return withTz(tz, async () => {
    const times = ALERT_SCRIPT.map((s) => localInstant(s.local));
    const snapshots = await recordSnapshots(times);
    // The snoozed rule is un-snoozed at the 05:30 step; the importer sees the rules as of the first step.
    const legacy = legacyAlertRules(new Date(localInstant('2026-02-01T05:00')).toISOString());
    const { converted, skipped } = convertLegacyRules(legacy, [], { now: times[0]! });
    const rules = [...builtinFlatRules(ALERT_CONFIG, BRANCH), ...converted];
    const withoutVelocity = rules.filter((r) => r.id !== 'restrict-velocity');

    const history: HistorySample[] = [];
    let cooldowns: FlatCooldownState = {};
    const all = new EngineEmulation(rules);
    const noVelocity = new EngineEmulation(withoutVelocity);
    const steps: ReplayStep[] = [];
    for (let i = 0; i < ALERT_SCRIPT.length; i++) {
      const step = ALERT_SCRIPT[i]!;
      const now = times[i]!;
      const snapshot = snapshots[i]!;
      history.push({ ts: now, todayCredits: snapshot.today.credits });
      const cutoff = now - HISTORY_WINDOW_MS;
      while (history.length > 0 && history[0]!.ts < cutoff) history.shift();
      const ctx = buildFlatContext({ snapshot, history: [...history], now });

      cooldowns = pruneCooldowns(cooldowns, rules, now);
      const evaluation = evaluateFlatRules(rules, ctx, cooldowns, now);
      cooldowns = evaluation.state;

      all.reconcile(ctx, now);
      noVelocity.reconcile(ctx, now);
      if (step.action === 'snooze-restriction-30m') {
        all.snooze(now, 30);
        noVelocity.snooze(now, 30);
      }
      steps.push({
        local: step.local,
        toasts: evaluation.matches.filter((m) => m.notify).map((m) => m.rule.id),
        matches: evaluation.matches,
        restriction: all.state(now),
        restrictionWithoutVelocity: noVelocity.state(now),
      });
    }
    return { steps, converted, skipped, rules, cooldowns };
  });
}
