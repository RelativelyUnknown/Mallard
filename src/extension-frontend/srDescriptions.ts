/**
 * Short plain-text summaries of each chart, written into the visually-hidden
 * `aria-describedby` target next to every chart body so screen-reader users
 * get the headline numbers a sighted user reads off the plot.
 *
 * Keyed by chart body id (the `desc-<bodyId>` element main.ts updates).
 */
import { UsageSnapshot } from '../extension-backend/domain/types';
import { formatCredits, formatMoney, formatTokens } from '../extension-backend/domain/format';

function peakIndex(values: readonly number[]): number {
  let best = -1;
  let bestValue = 0;
  values.forEach((v, i) => {
    if (v > bestValue) { best = i; bestValue = v; }
  });
  return best;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function describeCharts(snapshot: UsageSnapshot): Record<string, string> {
  const { chartData, currency } = snapshot;
  const { dailyBars, heatmap, modelBreakdown, categoryBreakdown, hourlyTimeline } = chartData;
  const out: Record<string, string> = {};

  const peakDay = dailyBars.points.reduce(
    (best, p) => (p.credits > (best?.credits ?? -1) ? p : best),
    dailyBars.points[0] ?? null,
  );
  out['chart-daily'] = peakDay
    ? `30-day bar chart. Peak: ${formatCredits(peakDay.credits)} cr on ${peakDay.date}. Today: ${formatCredits(snapshot.today.credits)} cr.`
    : '30-day bar chart. No data.';

  out['chart-heatmap'] = heatmap.max > 0
    ? `Activity heatmap, past year. Max daily usage: ${formatCredits(heatmap.max)} cr.`
    : 'Activity heatmap. No usage data.';

  const topModel = modelBreakdown.labels[0];
  out['chart-models'] = topModel
    ? `Model breakdown. Top model: ${topModel} with ${formatCredits(modelBreakdown.credits[0] ?? 0)} cr.`
    : 'Model breakdown. No data.';

  const sankey = snapshot.sankeyLinks;
  const topFlow = sankey.reduce<(typeof sankey)[number] | null>(
    (best, l) => (best === null || l.value > best.value ? l : best),
    null,
  );
  out['chart-sankey'] = topFlow
    ? `Model to surface flow, ${sankey.length} flows. Largest: ${topFlow.source} to ${topFlow.target}, ${formatCredits(topFlow.value)} cr.`
    : 'Model to surface flow. No data.';

  out['chart-category'] = categoryBreakdown.available
    ? `Cost by category: ${categoryBreakdown.categories.map((c, i) => `${c} ${formatMoney(categoryBreakdown.costs[i] ?? 0, currency)}`).join(', ')}.`
    : 'Cost category breakdown unavailable.';

  const cumulative = dailyBars.cumulativeCosts;
  const lastDay = dailyBars.points[dailyBars.points.length - 1];
  out['chart-cumulative'] = cumulative.length > 0 && lastDay
    ? `Cumulative spend over ${cumulative.length} days, reaching ${formatMoney(cumulative[cumulative.length - 1] ?? 0, currency)} on ${lastDay.date}.`
    : 'Cumulative spend. No data.';

  const weekdayPeak = peakIndex(chartData.weekdayBreakdown.totals);
  out['chart-weekday'] = weekdayPeak >= 0
    ? `Usage by weekday. Busiest day: ${WEEKDAY_NAMES[weekdayPeak]} with ${formatCredits(chartData.weekdayBreakdown.totals[weekdayPeak] ?? 0)} cr.`
    : 'Usage by weekday. No data.';

  out['chart-hourly'] = hourlyTimeline.hours.some((h) => h > 0)
    ? `Usage by hour. Peak hour: ${hourlyTimeline.peakHour}:00.`
    : 'Usage by hour. No data.';

  const topRepo = snapshot.byRepo[0];
  out['chart-repos'] = topRepo && (topRepo.credits > 0 || topRepo.cost > 0)
    ? `Spend by repository. Top repository: ${topRepo.key} with ${formatCredits(topRepo.credits)} cr.`
    : 'Spend by repository. No data.';

  const trend = chartData.categoryTrend;
  out['chart-category-trend'] = trend.available
    ? `Cost categories over time, ${trend.dates.length} days: ${trend.series.map((s) => s.category).join(', ')}.`
    : 'Cost categories over time. No data.';

  const tokens = chartData.tokensDaily;
  const tokenPeak = peakIndex(tokens.tokens);
  out['chart-tokens'] = tokenPeak >= 0
    ? `Token volume over time. Peak: ${formatTokens(tokens.tokens[tokenPeak] ?? 0)} tokens on ${tokens.dates[tokenPeak] ?? 'an unknown day'}.`
    : 'Token volume over time. No data.';

  const topLanguage = snapshot.byLanguage.find((l) => l.key !== 'unknown');
  out['chart-languages'] = topLanguage && (topLanguage.credits > 0 || topLanguage.cost > 0)
    ? `Spend by detected language. Top language: ${topLanguage.key} with ${formatCredits(topLanguage.credits)} cr.`
    : 'Spend by detected language. No data.';

  const billing = [...(snapshot.githubBilling?.items ?? [])].sort((a, b) => b.netAmount - a.netAmount)[0];
  out['chart-billing'] = billing && (billing.netAmount > 0 || billing.grossAmount > 0)
    ? `GitHub billing line items. Largest: ${billing.model || billing.sku || 'unknown'} at ${formatMoney(billing.netAmount)} net.`
    : 'GitHub billing line items. No data.';

  return out;
}
