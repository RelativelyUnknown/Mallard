/**
 * Orchestrates IngestService → EventReader → UsageSnapshot and emits one
 * `onDidChangeSnapshot` stream that the status bar, dashboard, and sidebar
 * all subscribe to.
 */
import * as vscode from 'vscode';
import { readConfig } from '../config';
import { evaluateAlerts, SnapshotSample } from '../domain/alerts';
import { evaluateAlertRules, shouldNotify } from '../domain/alertRules';
import { computeBudget } from '../domain/budget';
import { buildChartData } from '../domain/chartData';
import { forecastMonth } from '../domain/forecast';
import { isIncrementalUpdate } from '../domain/snapshot';
import {
  BillingState,
  COST_CATEGORIES,
  Filter,
  SnapshotData,
  SnapshotSource,
  SourceKind,
  Surface,
  SURFACES,
  SOURCE_KINDS,
  UsageAggregate,
  UsageSnapshot,
} from '../domain/types';
import { DAY_MS, bucketKey, nextBucketStart, startOf } from '../util/time';
import { opt } from '../util/lang';
import { billingErrorKind } from '../billing/GitHubUsageService';
import type { IBillingProvider } from '../billing/IBillingProvider';
import { IngestService } from '../ingest/IngestService';
import { PricingService } from '../pricing/PricingService';
import { CurrencyService } from '../pricing/CurrencyService';
import type { IEventSnapshotReader, SnapshotSourceData } from '../store/EventReader';
import { UserConfigStore } from './UserConfigStore';
import { activeBranch } from '../util/repo';
import { defaultVscodeHost, VscodeHost } from '../util/vscodeHost';
import { IntervalManager } from '../util/IntervalManager';
import { defaultLogger, Logger } from '../util/logger';

/** Keep ~1h of recent samples for velocity alerting. */
const HISTORY_WINDOW_MS = 60 * 60 * 1000;

/**
 * True when a billing failure means "the user simply isn't signed in" rather
 * than a real error. Prefers the typed kind the billing layer attaches to its
 * errors; the message check keeps older/third-party providers working.
 */
function isNotSignedIn(error: Error): boolean {
  if (billingErrorKind(error) === 'not-signed-in') return true;
  // Other providers may tag their errors the same way without sharing the class.
  if ('kind' in error && error.kind === 'not-signed-in') return true;
  return error.message.includes('Not signed in');
}

function isEmptyFilter(f: Filter): boolean {
  return !f.range && !f.models?.length && !f.surfaces?.length &&
         !f.repos?.length && !f.branches?.length && !f.sources?.length;
}

/** A snapshot with its billing keys removed, so a changed billing state replaces rather than merges into them. */
function withoutBilling(data: SnapshotData): Omit<SnapshotData, keyof BillingState> {
  const { authStatus: _status, authError: _error, githubBilling: _billing, ...rest } = data;
  return rest;
}

export class UsageService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<SnapshotData>();
  readonly onDidChangeSnapshot = this._onDidChange.event;

  /**
   * Fires only for snapshots computed with NO filter active (and for billing
   * changes merged into the last such snapshot). Alerts, the velocity history
   * and the restriction engine feed off this stream: a filtered snapshot
   * describes a slice of the data, so evaluating budgets or restriction rules
   * against it would fire (or clear) them on the wrong numbers.
   */
  private readonly _onDidComputeUnfiltered = new vscode.EventEmitter<SnapshotData>();
  readonly onDidComputeUnfiltered = this._onDidComputeUnfiltered.event;

  /** Fires when GitHub auth/billing changes — no usage recompute involved. */
  private readonly _onDidChangeBilling = new vscode.EventEmitter<BillingState>();
  readonly onDidChangeBilling = this._onDidChangeBilling.event;

  /** Fires once per alert/rule notification actually shown — lets UI
   *  surfaces (the sidebar gauge) react to the moment an alert fires,
   *  not just passively reflect the latest snapshot percentage. */
  private readonly _onAlertFired = new vscode.EventEmitter<{ message: string }>();
  readonly onAlertFired = this._onAlertFired.event;

  private data?: SnapshotData;
  /** The latest snapshot computed with no filter (see onDidComputeUnfiltered). */
  private unfiltered?: SnapshotData;
  /** The compute currently running, and the single follow-up queued behind it. */
  private inFlight?: Promise<void>;
  private queued?: Promise<void>;
  /** Composed wire snapshot, cached until the next data/billing change. */
  private composed?: UsageSnapshot;
  private prevComposed?: UsageSnapshot;
  private filter: Filter = {};
  private lastComputeFiltered = false;
  private readonly timer = new IntervalManager();
  private readonly alertFired = new Map<string, number>();
  private readonly history: SnapshotSample[] = [];
  private billing: BillingState = { authStatus: 'signed-out' };
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly reader: IEventSnapshotReader,
    private readonly pricing: PricingService,
    private readonly ingest: IngestService,
    private readonly userConfig: UserConfigStore,
    private readonly currency: CurrencyService,
    private readonly github?: IBillingProvider,
    private readonly host: VscodeHost = defaultVscodeHost,
    private readonly logger: Logger = defaultLogger,
  ) {
    if (github) {
      this.subs.push(github.onDidChange(() => this.background('GitHub billing refresh', this.refreshGitHub())));
    }
    this.subs.push(userConfig.onDidChange(() => this.background('recompute after config change', this.compute())));
  }

  /** Fire-and-forget with the failure logged instead of an unhandled rejection. */
  private background(what: string, work: Promise<unknown>): void {
    work.catch((err: unknown) => this.logger.error('usage', `${what} failed`, err));
  }

  /**
   * The full wire snapshot, composed lazily: chart data is only built when a
   * consumer (webview bridge, report, exporter) actually asks for it, not on
   * every recompute path.
   */
  get current(): UsageSnapshot | undefined {
    if (!this.data) return undefined;
    if (!this.composed) {
      const { chartInputs, ...rest } = this.data;
      const chartData = buildChartData(
        chartInputs.dayAggregates,
        rest.topModels,
        rest.budget,
        rest.forecast,
        rest.generatedAt,
        chartInputs.categoryBreakdown,
        chartInputs.hourlyTimeline,
        rest.pricePerCredit,
        this.pricing.currentManifest,
        chartInputs.weekday,
        this.userConfig.get().display,
        chartInputs.categoryDaily,
      );
      const next: UsageSnapshot = { ...rest, ...this.billing, chartData, isIncremental: false };
      // Partial dashboard updates only make sense while filtering.
      if (this.lastComputeFiltered) {
        next.isIncremental = isIncrementalUpdate(this.prevComposed, next);
      }
      this.composed = next;
    }
    return this.composed;
  }

  getFilter(): Filter {
    return this.filter;
  }

  getLogPaths(): string[] {
    return this.ingest.getLogPaths();
  }

  getSearchedDirs(): string[] {
    return this.ingest.getSearchedDirs();
  }

  getKnownDirs(): string[] {
    return this.ingest.getKnownDirs();
  }

  getStatus() {
    return this.ingest.getStatus();
  }

  async setFilter(filter: Filter): Promise<void> {
    this.filter = filter;
    await this.compute();
  }

  async start(): Promise<void> {
    // Emit an immediate snapshot so the dashboard shows a loading state
    // while the initial log parse runs in the background.
    await this.compute();
    this.scheduleTimer();
    this.background('GitHub billing refresh', this.refreshGitHub());
    this.background('initial ingest', this.ingest.start().then(() => this.compute()));
  }

  onConfigChanged(): void {
    this.scheduleTimer();
    this.background('recompute after settings change', this.compute());
  }

  async refresh(): Promise<void> {
    await this.ingest.start();
    await this.compute();
    this.background('GitHub billing refresh', this.refreshGitHub());
  }

  async signInGitHub(): Promise<void> {
    if (!this.github) return;
    if (await this.github.needsPat?.()) {
      // githubBilling.mode is "pat" with no PAT stored yet — getToken()
      // never falls through to interactive OAuth in this mode, so calling
      // signIn() here would be a silent no-op. Surface it instead.
      this.billing = {
        authStatus: 'error',
        authError:
          'A GitHub Personal Access Token is required (githubBilling.mode is "pat"). ' +
          'Run "Mallard: Set GitHub Personal Access Token" from the Command Palette.',
      };
      await this.emitBillingChange();
      return;
    }
    await this.github.signIn?.();
    await this.refreshGitHub();
  }

  private async refreshGitHub(): Promise<void> {
    if (!this.github) return;
    const result = await this.github.fetch();
    if (result.isOk()) {
      this.billing = { authStatus: 'signed-in', githubBilling: result.value };
    } else {
      const authStatus = isNotSignedIn(result.error) ? ('signed-out' as const) : ('error' as const);
      this.billing = {
        authStatus,
        ...(authStatus === 'error' ? { authError: result.error.message } : {}),
      };
    }
    await this.emitBillingChange();
  }

  /**
   * Billing rides its own cadence: merge into the cached data and re-emit —
   * no DuckDB read, no chart rebuild, no metric export. Before the first
   * compute there is nothing to merge into, so fall back to a full compute
   * (assembleSnapshot folds this.billing in).
   */
  private async emitBillingChange(): Promise<void> {
    this.invalidateComposed();
    if (this.data) {
      this.data = { ...withoutBilling(this.data), ...this.billing };
      if (this.unfiltered) {
        this.unfiltered = { ...withoutBilling(this.unfiltered), ...this.billing };
        this._onDidComputeUnfiltered.fire(this.unfiltered);
      }
      this._onDidChange.fire(this.data);
    } else {
      await this.compute();
    }
    this._onDidChangeBilling.fire(this.billing);
  }

  private invalidateComposed(): void {
    if (this.composed) this.prevComposed = this.composed;
    delete this.composed;
  }

  /**
   * Serialised compute: one run in flight, at most one queued behind it. A
   * burst of triggers (timer + filter change + config edit + ingest finishing)
   * therefore collapses into the running compute plus ONE follow-up that reads
   * the latest filter/config when it starts, so a slow older read can never
   * land after — and overwrite — a newer one.
   */
  private compute(): Promise<void> {
    if (!this.inFlight) return this.startCompute();
    const go = (): Promise<void> => {
      delete this.queued;
      return this.startCompute();
    };
    this.queued ??= this.inFlight.then(go, go);
    return this.queued;
  }

  private startCompute(): Promise<void> {
    const run: Promise<void> = this.runCompute().finally(() => {
      if (this.inFlight === run) delete this.inFlight;
    });
    this.inFlight = run;
    return run;
  }

  private async runCompute(): Promise<void> {
    const userConfig = this.userConfig.get();
    const now = Date.now();
    for (const [key, ts] of this.alertFired)
      if (now - ts > 86_400_000) this.alertFired.delete(key);

    const branch = activeBranch();

    // Currency lives in config.json only (set from the dashboard; the old
    // mallard.currency setting is no longer contributed).
    const displayCurrency = userConfig.currency ?? 'USD';
    const fxRates = this.currency.currentRates();
    const fxRate = displayCurrency !== 'USD' ? (fxRates[displayCurrency] ?? 1) : 1;

    // Both read paths return the same SnapshotSourceData shape: the fast path
    // reads the pre-materialized snap_* tables, the filtered path pushes all
    // aggregation into DuckDB. Only the filtered path computes isIncremental
    // (partial dashboard updates only make sense while filtering).
    const filtered = !isEmptyFilter(this.filter);
    const dataPromise = filtered
      ? this.reader.readFilteredSnapshot({
          ...this.filter,
          range: this.filter.range ?? { start: startOf(now - 365 * DAY_MS, 'day'), end: now + DAY_MS },
        })
      : this.reader.readSnapshotCache();
    const [data, currentBranchCredits] = await Promise.all([
      dataPromise,
      branch ? this.reader.creditsByBranch(branch) : Promise.resolve(0),
    ]);

    const next = this.assembleSnapshot(data, {
      now, userConfig, branch, displayCurrency, fxRate, currentBranchCredits,
    });

    this.data = next;
    this.lastComputeFiltered = filtered;
    this.invalidateComposed();
    if (!filtered) {
      // Filtered snapshots go to the UI only — see onDidComputeUnfiltered.
      this.unfiltered = next;
      this.recordSample(now, next);
      this.fireAlerts(next, userConfig, now);
      this._onDidComputeUnfiltered.fire(next);
    }
    this._onDidChange.fire(next);
  }

  /** Build a SnapshotData from the normalized data bundle (either read path). */
  private assembleSnapshot(
    data: SnapshotSourceData,
    opts: {
      now: number;
      userConfig: ReturnType<UserConfigStore['get']>;
      branch: string | undefined;
      displayCurrency: string;
      fxRate: number;
      currentBranchCredits: number;
    },
  ): SnapshotData {
    const { now, userConfig, branch, displayCurrency, fxRate, currentBranchCredits } = opts;

    // ── Day aggregates (for forecast + chart) ──────────────────────────────
    const dayAggregates: UsageAggregate[] = data.daily.map((row) => ({
      granularity: 'day',
      bucketKey:   bucketKey(row.dayStart, 'day'),
      start:       row.dayStart,
      end:         nextBucketStart(row.dayStart, 'day'),
      credits:     row.credits,
      cost:        row.cost * fxRate,
      tokens:      Number(row.tokens),
      byModel:     {},
      eventCount:  row.eventCount,
      estimated:   false,
    }));

    const forecast = forecastMonth(dayAggregates, now, this.pricing.pricePerCredit * fxRate);

    const budget = computeBudget({
      monthlyBudget:   userConfig.monthlyBudget > 0 ? userConfig.monthlyBudget : null,
      includedCredits: userConfig.includedCredits,
      mtdCredits:      data.totals.mtd.credits,
      mtdCost:         data.totals.mtd.cost * fxRate,
      forecast,
    });

    // ── Dimensions ──────────────────────────────────────────────────────────
    const allModels   = data.dims.models;
    const allSurfaces = data.dims.surfaces.filter((s): s is Surface    => SURFACES.has(s as Surface));
    const allSources  = data.dims.sources.filter( (s): s is SourceKind => SOURCE_KINDS.has(s as SourceKind));
    const allRepos    = data.dims.repos;

    const topModels = data.models.map((m) => ({
      key:     m.modelId,
      credits: m.credits,
      cost:    m.cost * fxRate,
      tokens:  Number(m.tokens),
    }));

    const byRepo = data.repos.map((r) => ({
      key:     r.repo,
      credits: r.credits,
      cost:    r.cost * fxRate,
      tokens:  Number(r.tokens),
      heuristicShare: r.heuristicShare,
    }));

    const byLanguage = data.languages.map((l) => ({
      key:     l.language,
      credits: l.credits,
      cost:    l.cost * fxRate,
      tokens:  Number(l.tokens),
    }));

    const sankeyLinks = data.sankey.map((s) => ({
      source: s.model,
      target: s.surface,
      value:  s.credits,
    }));

    // ── Chart data ──────────────────────────────────────────────────────────
    const catMap = new Map(data.categories.map((c) => [c.category, c.cost]));
    const catKeys = COST_CATEGORIES.filter((c) => (catMap.get(c) ?? 0) > 0);
    const categoryBreakdown = catKeys.length > 0
      ? { categories: catKeys, costs: catKeys.map((c) => catMap.get(c) ?? 0), available: true }
      : { categories: [] as typeof catKeys, costs: [] as number[], available: false };

    // Per-day category costs (fx-adjusted) for the category-trend chart.
    const categoryDaily = data.daily.map((row) => ({
      dayStart: row.dayStart,
      costs: {
        ...(row.catInput         > 0 ? { input:          row.catInput * fxRate }         : {}),
        ...(row.catOutput        > 0 ? { output:         row.catOutput * fxRate }        : {}),
        ...(row.catCacheRead     > 0 ? { cache_read:     row.catCacheRead * fxRate }     : {}),
        ...(row.catCacheCreation > 0 ? { cache_creation: row.catCacheCreation * fxRate } : {}),
        ...(row.catThinking      > 0 ? { thinking:       row.catThinking * fxRate }      : {}),
        ...(row.catTool          > 0 ? { tool:           row.catTool * fxRate }          : {}),
      },
    }));

    const hourArr = new Array<number>(24).fill(0);
    for (const h of data.hourly) hourArr[h.hourLocal] = h.credits;
    const maxHourCredits = Math.max(...hourArr);
    // null when there is no hourly activity at all — indexOf(0) would
    // otherwise always report midnight as the "peak".
    const peakHour = maxHourCredits > 0 ? hourArr.indexOf(maxHourCredits) : null;
    const hourlyTimeline = { hours: hourArr, peakHour };

    // ── Range from the daily extent ─────────────────────────────────────────
    const rangeStart = data.daily[0]?.dayStart ?? startOf(now - 29 * DAY_MS, 'day');
    const rangeEnd   = (data.daily[data.daily.length - 1]?.dayStart ?? now) + DAY_MS;

    const hasData = data.totals.all.eventCount > 0;
    // Snapshot-level provenance derived from the data: 'mixed' when more than one
    // event source is present, the single source when there's exactly one, else
    // 'lm' as the neutral default. (The old ternary collapsed any multi-connector
    // mix to 'local' and mapped the no-data case to 'local' arbitrarily.)
    const source: SnapshotSource =
      allSources.length > 1 ? 'mixed' : (allSources[0] ?? 'lm');

    return {
      generatedAt:   now,
      source,
      status:        hasData ? { kind: 'ok' } : this.ingest.getStatus(),
      currency:      displayCurrency,
      pricePerCredit: this.pricing.pricePerCredit * fxRate,
      fxRates:       this.currency.currentRates(),
      filter:        this.filter,
      range:         { start: rangeStart, end: rangeEnd },
      forecast,
      budget,
      topModels,
      today:         { credits: data.totals.today.credits, cost: data.totals.today.cost * fxRate, tokens: Number(data.totals.today.tokens) },
      allModels,
      allSurfaces,
      allSources,
      sankeyLinks,
      allRepos,
      byRepo,
      byLanguage,
      // Raw chart inputs travel on the data; render-ready chart data is
      // composed lazily in `current` at the UI boundary.
      chartInputs: { dayAggregates, categoryBreakdown, hourlyTimeline, weekday: data.weekday, categoryDaily },
      ...this.billing,
      currentBranchCredits,
      totalEventCount:     data.totals.all.eventCount,
      estimatedEventCount: data.estimatedEventCount,
      ...opt('currentBranch', branch),
    };
  }

  private recordSample(now: number, s: SnapshotData): void {
    this.history.push({ ts: now, todayCredits: s.today.credits });
    const cutoff = now - HISTORY_WINDOW_MS;
    while (this.history.length > 0 && this.history[0]!.ts < cutoff) this.history.shift();
  }

  private fireAlerts(s: SnapshotData, uc: ReturnType<UserConfigStore['get']>, now: number): void {
    const alerts = evaluateAlerts(s, this.history, uc, this.alertFired, now);
    for (const a of alerts) {
      void this.host.showWarningMessage(a.message);
      this.alertFired.set(a.key, now);
      this._onAlertFired.fire({ message: a.message });
    }

    const ruleResults = evaluateAlertRules({
      snapshot: s,
      history: this.history,
      rules: uc.rules ?? [],
      ...opt('groups', uc.groups),
      ...opt('vars', uc.vars),
      ...opt('branchBudgets', uc.branchBudgets),
      signedIn: s.authStatus === 'signed-in',
      fired: this.alertFired,
      now,
    });
    for (const r of ruleResults) {
      if (shouldNotify(r.rule)) {
        void this.host.showWarningMessage(r.message);
        this._onAlertFired.fire({ message: r.message });
      }
    }
  }

  private scheduleTimer(): void {
    // readConfig() already clamps refreshIntervalMinutes to [1, 60]
    const mins = readConfig().refreshIntervalMinutes;
    this.timer.schedule(() => this.background('scheduled refresh', this.refresh()), mins * 60_000);
  }

  dispose(): void {
    this.timer[Symbol.dispose]();
    this.ingest.dispose();
    this._onDidChange.dispose();
    this._onDidComputeUnfiltered.dispose();
    this._onDidChangeBilling.dispose();
    this._onAlertFired.dispose();
    this.subs.forEach((d) => d.dispose());
    this.github?.dispose();
  }
}
