/* c8 ignore next */
/**
 * Shared, locale-aware formatters used by both the host and the webview.
 * Pure — no `vscode`, no DOM.
 */
import { Metric } from './types';

export function formatMoney(amount: number, currency = 'USD'): string {
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    // A positive amount below the currency's smallest displayed unit would
    // render as a misleading zero ("$0.00"); show the floor instead.
    const smallest = 10 ** -(fmt.resolvedOptions().maximumFractionDigits ?? 2);
    if (amount > 0 && amount < smallest) return `<${fmt.format(smallest)}`;
    return fmt.format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}

export function formatTokens(n: number): string {
  // Thresholds sit half a display step below each unit so a value that rounds
  // up to the next unit (999_950 → "1000.0k") is promoted instead of overflowing.
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 999.5) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCredits(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString();
}

/* c8 ignore next */
export function formatMetric(value: number, metric: Metric, currency = 'USD'): string {
  switch (metric) {
    case 'cost':
      return formatMoney(value, currency);
    case 'credits':
      return `${formatCredits(value)} cr`;
    case 'tokens':
      return `${formatTokens(value)} tok`;
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unknown metric: ${_exhaustive}`);
    }
  }
}
