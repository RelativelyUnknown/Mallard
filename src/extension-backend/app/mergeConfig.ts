/* c8 ignore next */
/**
 * Pure default-merge for UserConfig. Lives in its own file so it can be
 * unit-tested without pulling in the `vscode` module.
 */
import { ConfigDashboard, DEFAULT_USER_CONFIG, DisplayPrefs, UserConfig } from '../domain/types';
import { opt } from '../util/lang';

/** Inclusive integer bounds for the hand-editable display/dashboard numbers. */
const DISPLAY_RANGES = {
  dailyBarsWindow: [1, 366],
  heatmapWeeks: [1, 104],
  topN: [1, 100],
} as const;
const COLUMNS_RANGE = [1, 4] as const;

const intInRange = (v: unknown, [min, max]: readonly [number, number]): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Keep only the in-range integer display fields; undefined when none survive. */
function sanitizeDisplay(display: DisplayPrefs | undefined): DisplayPrefs | undefined {
  if (!display) return undefined;
  const out: DisplayPrefs = {};
  for (const key of Object.keys(DISPLAY_RANGES) as Array<keyof typeof DISPLAY_RANGES>) {
    const v = display[key];
    if (intInRange(v, DISPLAY_RANGES[key])) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Drop an out-of-range column count; the panels list is passed through. */
function sanitizeDashboard(dashboard: ConfigDashboard | undefined): ConfigDashboard | undefined {
  if (!dashboard) return undefined;
  const { columns, ...rest } = dashboard;
  return intInRange(columns, COLUMNS_RANGE) ? { ...rest, columns } : rest;
}

/** A 3-letter ISO currency code, upper-cased; undefined for anything else. */
function sanitizeCurrency(currency: unknown): string | undefined {
  return typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency)
    ? currency.toUpperCase()
    : undefined;
}

/** Merge a partial over defaults, clamping numbers to be non-negative. */
/* c8 ignore next */
export function mergeConfig(stored?: Partial<UserConfig>): UserConfig {
  const d = DEFAULT_USER_CONFIG;
  const nonNeg = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  return {
    monthlyBudget: nonNeg(stored?.monthlyBudget, d.monthlyBudget),
    includedCredits: nonNeg(stored?.includedCredits, d.includedCredits),
    dailyCreditAlert: nonNeg(stored?.dailyCreditAlert, d.dailyCreditAlert),
    alerts: {
      velocityEnabled:
        typeof stored?.alerts?.velocityEnabled === 'boolean'
          ? stored.alerts.velocityEnabled
          : d.alerts.velocityEnabled,
      velocityCreditsPerHour: nonNeg(
        stored?.alerts?.velocityCreditsPerHour,
        d.alerts.velocityCreditsPerHour,
      ),
    },
    /* c8 ignore next */
    version: stored?.version ?? d.version ?? 1,
    ...(stored?.vars !== undefined
      ? { vars: stored.vars }
      : d.vars !== undefined
        /* c8 ignore next */
        ? { vars: d.vars }
        /* c8 ignore next */
        : {}),
    ...(stored?.groups !== undefined
      ? { groups: stored.groups }
      : d.groups !== undefined
        /* c8 ignore next */
        ? { groups: d.groups }
        /* c8 ignore next */
        : {}),
    ...(stored?.rules !== undefined
      ? { rules: stored.rules }
      : d.rules !== undefined
        /* c8 ignore next */
        ? { rules: d.rules }
        /* c8 ignore next */
        : {}),
    ...(stored?.budget !== undefined
      ? { budget: stored.budget }
      : d.budget !== undefined
        /* c8 ignore next */
        ? { budget: d.budget }
        /* c8 ignore next */
        : {}),
    ...(stored?.branchBudgets !== undefined
      ? { branchBudgets: stored.branchBudgets }
      : {}),
    // Pass-through blocks with no defaults. These were previously dropped
    // here (and by the zod schema), silently killing the config.json
    // githubBilling/dashboard/display features.
    ...(stored?.githubBilling !== undefined ? { githubBilling: stored.githubBilling } : {}),
    ...opt('dashboard', sanitizeDashboard(stored?.dashboard)),
    ...opt('display', sanitizeDisplay(stored?.display)),
    ...opt('currency', sanitizeCurrency(stored?.currency)),
    ...(stored?.export !== undefined ? { export: stored.export } : {}),
  };
}
