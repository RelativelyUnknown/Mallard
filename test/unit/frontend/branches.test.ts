import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { UsageSnapshot, RestrictionState, GitHubBillingData } from '../../../src/extension-backend/domain/types';
import { formatMoney } from '../../../src/extension-backend/domain/format';
import { mountGitHubBillingStrip } from '../../../src/extension-frontend/components/GitHubBillingStrip';
import { mountKpiCards } from '../../../src/extension-frontend/components/KpiCards';
import { mountStatusBanner } from '../../../src/extension-frontend/components/StatusBanner';
import { mountRestrictionBanner } from '../../../src/extension-frontend/components/RestrictionBanner';
import { mountEmptyState } from '../../../src/extension-frontend/components/EmptyState';
import { mountAlertConfigPanel } from '../../../src/extension-frontend/components/AlertConfigPanel';
import { mountCurrencySelector } from '../../../src/extension-frontend/components/CurrencySelector';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';

function makeSnapshot(credits = 100): UsageSnapshot {
  const now = Date.now();
  return buildSnapshot(
    [makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits, cost: credits * 0.04 })],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
}

function clearPosted() {
  (globalThis as unknown as { __postedMessages: unknown[] }).__postedMessages = [];
}
function getPosted(): unknown[] {
  return (globalThis as unknown as { __postedMessages: unknown[] }).__postedMessages;
}

describe('components — remaining branch coverage', () => {
  it('GitHubBillingStrip renders quota with resetDate and cost divergence warning', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountGitHubBillingStrip(el);
    const snap = makeSnapshot(100);
    const billing: GitHubBillingData = {
      quota: { plan: 'copilot_pro', entitlement: 300, used: 75, resetDate: Date.now() + 86400000, unlimited: false },
      items: [{ model: 'gpt-4o', sku: 'premium', grossAmount: 10, netAmount: 9, grossQuantity: 100 }],
      fetchedAt: Date.now(),
      totalNetAmount: 100, // diverges from localCost to trigger the warning
    };
    h.update({ ...snap, authStatus: 'signed-in', githubBilling: billing });
    assert.equal(el.querySelector('.wv-gh-badge')!.textContent!.trim(), 'Verified by GitHub');
    assert.equal(el.querySelector('.wv-gh-amount')!.textContent, `${formatMoney(100, 'USD')} actual`);
    assert.match(el.querySelector('.wv-gh-reset')!.textContent!, /^Resets \S+/);
    const warning = el.querySelector('.wv-gh-divergence')!;
    assert.ok(warning, 'local estimate is far from the billed total');
    assert.ok(warning.textContent!.includes(formatMoney(100, 'USD')), 'warning names the API figure');
    el.remove();
  });

  it('GitHubBillingStrip shows a generic error with a Retry action that posts signIn', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountGitHubBillingStrip(el);
    const snap = makeSnapshot(100);
    h.update({ ...snap, authStatus: 'error', authError: 'Network timeout' });
    assert.ok(el.textContent!.includes('Network timeout'));
    const btn = el.querySelector('button')!;
    assert.equal(btn.textContent, 'Retry');
    clearPosted();
    btn.click();
    assert.ok(getPosted().some((m) => JSON.stringify(m).includes('signIn')));
    el.remove();
  });

  it('GitHubBillingStrip shows a Set PAT action when the error requires a Personal Access Token', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountGitHubBillingStrip(el);
    const snap = makeSnapshot(100);
    h.update({ ...snap, authStatus: 'error', authError: 'A GitHub Personal Access Token is required.' });
    const btn = el.querySelector('button')!;
    assert.equal(btn.textContent, 'Set PAT');
    clearPosted();
    btn.click();
    assert.ok(getPosted().some((m) => JSON.stringify(m).includes('setGitHubPat')));
    el.remove();
  });

  it('GitHubBillingStrip falls back to a generic error message when authError is undefined', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountGitHubBillingStrip(el);
    const snap = makeSnapshot(100);
    h.update({ ...snap, authStatus: 'error' });
    assert.ok(el.textContent!.includes('GitHub sign-in failed.'));
    el.remove();
  });

  it('GitHubBillingStrip renders quota with null resetDate', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountGitHubBillingStrip(el);
    const snap = makeSnapshot(100);
    h.update({
      ...snap,
      authStatus: 'signed-in',
      githubBilling: { quota: { plan: 'unlimited', entitlement: 0, used: 0, resetDate: null, unlimited: true }, items: [], fetchedAt: Date.now(), totalNetAmount: 0 },
    });
    assert.ok(el.querySelector('.wv-gh-verified'), 'verified row still shown');
    assert.equal(el.querySelector('.wv-gh-reset'), null, 'no reset date to show, so no "Resets" label');
    assert.equal(el.querySelector('.wv-gh-divergence'), null, 'nothing billed, so nothing to diverge from');
    el.remove();
  });

  it('GitHubBillingStrip hides the reset label rather than printing "Invalid Date"', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountGitHubBillingStrip(el);
    h.update({
      ...makeSnapshot(100),
      authStatus: 'signed-in',
      githubBilling: { quota: { plan: 'p', entitlement: 1, used: 0, resetDate: Number.NaN, unlimited: false }, items: [], fetchedAt: 1, totalNetAmount: 1 },
    });
    assert.equal(el.querySelector('.wv-gh-reset'), null);
    assert.ok(!el.textContent!.includes('Invalid Date'));
    el.remove();
  });

  it('KpiCards renders projected cost range when forecast is linear', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountKpiCards(el);
    const snap = makeSnapshot(100);
    // Force a non-insufficient-data forecast so the projected-cost branch runs.
    h.update({ ...snap, forecast: { granularity: 'month', projectedCredits: 300, projectedCost: 12.5, low: 10, high: 15, basis: 'linear', asOf: Date.now() } }, 'cost');
    assert.equal(el.querySelector('#kpi-proj-val')!.textContent, formatMoney(12.5, 'USD'));
    // The range is in credits x price-per-credit (0.04), not raw credits.
    assert.equal(
      el.querySelector('#kpi-proj-sub')!.textContent,
      `${formatMoney(10 * 0.04, 'USD')} – ${formatMoney(15 * 0.04, 'USD')}`,
    );
    el.remove();
  });

  it('KpiCards says more data is needed while the forecast has insufficient data', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountKpiCards(el);
    const snap = makeSnapshot(100);
    h.update({ ...snap, forecast: { ...snap.forecast, basis: 'insufficient-data' } }, 'cost');
    assert.equal(el.querySelector('#kpi-proj-val')!.textContent, '—');
    assert.equal(el.querySelector('#kpi-proj-sub')!.textContent, 'Need 3+ days of data');
    el.remove();
  });

  it('KpiCards renders no-model dash when topModels is empty', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountKpiCards(el);
    const snap = makeSnapshot(0);
    h.update({ ...snap, topModels: [] }, 'cost');
    assert.equal(el.querySelector('#kpi-model-val')!.textContent, '—');
    assert.equal(el.querySelector('#kpi-model-sub')!.textContent, '');
    el.remove();
  });

  it('StatusBanner flashes the dot on incremental update with ok status', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountStatusBanner(el);
    const dot = () => el.querySelector('.wv-banner-dot')!;
    h.update(makeSnapshot(100));
    assert.equal(dot().classList.contains('wv-banner-dot--flash'), false, 'a full snapshot does not flash');

    // Update with isIncremental=true and ok status to trigger the flash
    h.update({ ...makeSnapshot(100), isIncremental: true, status: { kind: 'ok', reason: '' } });
    assert.equal(dot().classList.contains('wv-banner-dot--flash'), true);

    h.update({ ...makeSnapshot(100), isIncremental: true, status: { kind: 'degraded', reason: 'x' } });
    assert.equal(el.querySelector<HTMLElement>('.wv-banner')!.dataset.kind, 'warn');
    el.remove();
  });

  it('RestrictionBanner: dismiss hides on re-show, snooze/disable buttons post', () => {
    clearPosted();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountRestrictionBanner(el);
    const active: RestrictionState = { version: 1, active: true, ruleId: 'r', reasonMessage: 'Over budget', firedAt: 12345, userOverrideUntil: null };
    // Show the active banner
    h.update(active);
    // Click Dismiss to set the dismissedKey
    const dismissBtn = el.querySelector('#restrict-dismiss') as HTMLButtonElement;
    dismissBtn.click();
    // Re-show with the same state → should hide (dismissedKey === key)
    h.update(active);
    assert.equal(el.style.display, 'none', 'banner hidden after dismiss');
    // Re-show with a different firedAt → should show again
    const active2: RestrictionState = { ...active, firedAt: 67890 };
    h.update(active2);
    // Click snooze 15, snooze 60, and disable buttons
    (el.querySelector('#restrict-snooze-15') as HTMLButtonElement).click();
    (el.querySelector('#restrict-snooze-60') as HTMLButtonElement).click();
    (el.querySelector('#restrict-disable') as HTMLButtonElement).click();
    assert.ok(getPosted().some((m) => JSON.stringify(m).includes('restrictSnooze')), 'snooze posted');
    assert.ok(getPosted().some((m) => JSON.stringify(m).includes('disableExtension')), 'disable posted');
    // Test the override (snoozed) state
    h.update({ ...active2, userOverrideUntil: Date.now() + 60000 });
    assert.match(el.querySelector('.wv-restrict-override')!.textContent!, /Snoozed for 1m\. Rule r will show again/);
    assert.equal(el.querySelector('[role="alert"]'), null, 'the alert is replaced by the snoozed notice');
    el.remove();
  });

  it('RestrictionBanner: a dismissed alert stays dismissed after a snooze ends, but a new firing shows again', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountRestrictionBanner(el);
    const active: RestrictionState = { version: 1, active: true, ruleId: 'r', reasonMessage: 'Over budget', firedAt: 111, userOverrideUntil: null };
    h.update(active);
    el.querySelector<HTMLButtonElement>('#restrict-dismiss')!.click();
    assert.equal(el.style.display, 'none');

    // Snoozing replaces the (hidden) alert with the snoozed notice...
    h.update({ ...active, userOverrideUntil: Date.now() + 5 * 60_000 });
    assert.ok(el.querySelector('.wv-restrict-override'), 'the snoozed notice is shown');
    assert.notEqual(el.style.display, 'none');

    // ...and when the snooze runs out the SAME firing must not come back after the user dismissed it.
    h.update(active);
    assert.equal(el.style.display, 'none', 'hidden again, not re-alerted');
    assert.equal(el.innerHTML, '');

    h.update({ ...active, firedAt: 222 });
    assert.equal(el.querySelector('[role="alert"] strong')!.textContent, 'Over budget', 'a fresh firing is announced');
    el.remove();
  });

  it('RestrictionBanner: an unchanged state is not re-rendered (no repeated screen-reader announcement, focus kept)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountRestrictionBanner(el);
    const active: RestrictionState = { version: 1, active: true, ruleId: 'r', reasonMessage: 'Over budget', firedAt: 111, userOverrideUntil: null };
    h.update(active);
    const alert = el.querySelector('[role="alert"]');
    h.update({ ...active });
    assert.equal(el.querySelector('[role="alert"]'), alert, 'same DOM node: not rebuilt');

    const snoozed = { ...active, userOverrideUntil: Date.now() + 10 * 60_000 };
    h.update(snoozed);
    const notice = el.querySelector('.wv-restrict-override');
    h.update({ ...snoozed });
    assert.equal(el.querySelector('.wv-restrict-override'), notice, 'the snoozed notice is not rebuilt either');

    h.update(null);
    assert.equal(el.style.display, 'none');
    el.style.display = '';
    h.update({ ...active, active: false });
    assert.equal(el.style.display, '', 'already hidden state is not hidden twice');
    el.remove();
  });

  it('RestrictionBanner hides when state is null', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountRestrictionBanner(el);
    h.update(null);
    assert.equal(el.style.display, 'none', 'hidden when null');
    el.remove();
  });

  it('EmptyState buttons post refresh, signIn and enableCopilotTelemetry', () => {
    clearPosted();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountEmptyState(el);
    h.update(true, 'No data');
    assert.equal(el.style.display, '');
    assert.equal(el.querySelector('#empty-reason')!.textContent, 'No data');

    el.querySelectorAll('button').forEach((btn) => btn.click());
    assert.deepEqual(getPosted(), [
      { type: 'refresh' },
      { type: 'command', id: 'signIn' },
      { type: 'command', id: 'enableCopilotTelemetry' },
    ]);

    h.update(false);
    assert.equal(el.style.display, 'none');
    assert.equal(el.querySelector('#empty-reason')!.textContent, '');
    el.remove();
  });

  it('AlertConfigPanel button posts openConfig and the count reflects the configured rules', () => {
    clearPosted();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountAlertConfigPanel(el);
    h.update(DEFAULT_USER_CONFIG);
    const count = () => el.querySelector('#rule-count')!.textContent;
    assert.equal(count(), 'No rules configured');

    el.querySelector<HTMLButtonElement>('button')!.click();
    assert.deepEqual(getPosted(), [{ type: 'openConfig' }]);

    // The rules are the flat `mallard.alerts.rules` setting.
    const flat = { id: 'r1', metric: 'today.credits', op: '>', value: 1, cooldown: '1h', severity: 'info' } as const;
    h.update({ ...DEFAULT_USER_CONFIG, flatRules: [flat] });
    assert.equal(count(), '1 rule configured');
    h.update({ ...DEFAULT_USER_CONFIG, flatRules: [flat, { ...flat, id: 'r2' }] });
    assert.equal(count(), '2 rules configured');
    h.update({ ...DEFAULT_USER_CONFIG, flatRules: [] });
    assert.equal(count(), 'No rules configured');
    el.remove();
  });

  it('CurrencySelector syncs selection when the currency list is unchanged', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountCurrencySelector(el, () => {});
    // First call populates options with EUR selected
    h.update({ USD: 1, EUR: 0.92 }, 'EUR');
    // Second call with SAME currencies but different selected → sync branch
    h.update({ USD: 1, EUR: 0.92 }, 'USD');
    const select = el.querySelector('select') as HTMLSelectElement;
    assert.equal(select.value, 'USD');
    el.remove();
  });
});
