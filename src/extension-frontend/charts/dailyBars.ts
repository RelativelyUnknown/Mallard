/**
 * 30-day daily bar chart — consumes pre-computed DailyBarsData from the host.
 */
import type { EChartsOption, TooltipComponentOption, SeriesOption } from './echarts';
import { readTheme } from '../theme';
import { UsageSnapshot } from '../../extension-backend/domain/types';
import { formatMoney, formatCredits } from '../../extension-backend/domain/format';
import { ChartComponent } from './ChartComponent';
import { escapeHtml } from '../escapeHtml';

export interface DailyBarsHandle {
  update(snapshot: UsageSnapshot): void;
  resize(): void;
  reinit(): void;
}

type DayPoint = UsageSnapshot['chartData']['dailyBars']['points'][number];

/**
 * Tooltip text for the hovered day. Built from the points of the *current*
 * snapshot — it closes over them, so it is rebuilt on every update (including
 * incremental ones) or the tooltip would keep reading the previous render's data.
 */
function tooltipFormatter(points: readonly DayPoint[], currency: string) {
  return (params: TooltipComponentOption): string => {
    const p = (params as unknown as Array<{ dataIndex: number }>)[0];
    if (!p) return '';
    const pt = points[p.dataIndex];
    if (!pt) return '';
    return [
      `<strong>${escapeHtml(pt.date)}</strong>`,
      `${formatCredits(pt.credits)} cr`,
      escapeHtml(formatMoney(pt.cost, currency)),
    ].join('<br/>');
  };
}

class DailyBarsChart extends ChartComponent {
  protected hasData(s: UsageSnapshot): boolean {
    return s.chartData.dailyBars.points.length > 0;
  }

  // Incremental updates only touch today's bar — skip the full rebuild. That
  // is only valid on top of a full render of this same ECharts instance: a
  // freshly (re)created one (first paint, or after a theme reinit) has no axes
  // or series yet, and a partial option would leave bars floating in a void.
  override update(s: UsageSnapshot): void {
    if (s.isIncremental && !this.fresh && this.hasData(s)) {
      const { points } = s.chartData.dailyBars;
      const t = readTheme();
      const sev = [t.sevOk, t.sevWarn, t.sevOver];
      const barData = points.map((p) => ({
        value: p.credits,
        itemStyle: { color: sev[p.colorIndex] ?? t.sevOk },
      }));
      this.chart.setOption(
        {
          animation: true,
          animationDuration: 500,
          tooltip: { formatter: tooltipFormatter(points, s.currency) },
          series: [{ data: barData }],
        } as EChartsOption,
        { notMerge: false, lazyUpdate: false },
      );
      return;
    }

    super.update(s);
  }

  protected buildOption(s: UsageSnapshot): object {
    const { points, budgetLine, projectedLine } = s.chartData.dailyBars;
    const currency = s.currency;
    const t = readTheme();
    const sev = [t.sevOk, t.sevWarn, t.sevOver];

    const barData = points.map((p) => ({
      value: p.credits,
      itemStyle: { color: sev[p.colorIndex] ?? t.sevOk },
    }));

    const series: SeriesOption[] = [
      {
        type: 'bar',
        name: 'Credits',
        data: barData,
        emphasis: { itemStyle: { opacity: 0.85 } },
      },
    ];

    if (budgetLine !== null) {
      series.push({
        type: 'line',
        name: 'Daily budget',
        data: points.map(() => budgetLine),
        lineStyle: { type: 'dashed', color: t.sevWarn, width: 1 },
        symbol: 'none',
        silent: true,
      } as SeriesOption);
    }

    if (projectedLine !== null) {
      series.push({
        type: 'line',
        name: 'Projected pace',
        data: points.map(() => projectedLine),
        lineStyle: { type: 'dotted', color: t.accent, width: 1.5 },
        symbol: 'none',
        silent: true,
      } as SeriesOption);
    }

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        formatter: tooltipFormatter(points, currency),
      },
      grid: { left: 40, right: 16, top: 12, bottom: 40, containLabel: false },
      xAxis: {
        type: 'category',
        data: points.map((p) => p.date),
        axisLabel: { rotate: 45, fontSize: 10, interval: 4 },
      },
      yAxis: { type: 'value', name: 'Credits', nameTextStyle: { fontSize: 10 } },
      series,
      legend: {
        show: series.length > 1,
        top: 0,
        right: 0,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { fontSize: 11 },
      },
    };
  }
}

export function mountDailyBars(el: HTMLElement): DailyBarsHandle {
  return new DailyBarsChart(el);
}
