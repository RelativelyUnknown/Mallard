import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { AuthStatus, RestrictionState, UsageSnapshot } from '../../../src/extension-backend/domain/types';
import { setState } from '../../../src/extension-frontend/store';
import { resetFilterSync } from '../../../src/extension-frontend/filterSync';
import { mountFilterBar } from '../../../src/extension-frontend/components/FilterBar';
import { mountGitHubBillingStrip } from '../../../src/extension-frontend/components/GitHubBillingStrip';
import { mountRestrictionBanner } from '../../../src/extension-frontend/components/RestrictionBanner';
import { mountKpiCards } from '../../../src/extension-frontend/components/KpiCards';

function multiSnapshot(extraModel?: string): UsageSnapshot {
  const now = Date.now();
  const events = [
    makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits: 5, cost: 0.2, surface: 'chat', source: 'local', repo: 'acme/app' }),
    makeEvent({ ts: now - 2000, modelId: 'claude-sonnet-4-5', credits: 3, cost: 0.1, surface: 'inline', source: 'claude-code', repo: 'acme/lib' }),
  ];
  if (extraModel) events.push(makeEvent({ ts: now - 3000, modelId: extraModel, credits: 1, cost: 0.04, surface: 'chat', source: 'local' }));
  return buildSnapshot(events, {
    now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
    filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
  });
}

function resetState(): void {
  resetFilterSync();
  setState({ filter: {}, datePreset: 'month' });
}

describe('live updates keep focus: FilterBar rebuilds a region only when its inputs change', () => {
  beforeEach(resetState);
  afterEach(resetState);

  function mount() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const bar = mountFilterBar(el);
    return { el, bar };
  }

  it('an identical snapshot leaves the repo options, model options, surface chips and source chips untouched', () => {
    const { el, bar } = mount();
    const snap = multiSnapshot();
    bar.update(snap, 'cost');
    const regions = {
      repoOption: el.querySelector('#repo-select option:nth-child(2)'),
      modelOption: el.querySelector('#model-dropdown [role="option"]:nth-child(2)'),
      surfaceChip: el.querySelector('[data-surface="chat"]'),
      sourceChip: el.querySelector('[data-source-group="copilot"]'),
    };
    for (const [name, node] of Object.entries(regions)) assert.ok(node, `${name} rendered`);

    bar.update(multiSnapshot(), 'cost');
    assert.equal(el.querySelector('#repo-select option:nth-child(2)'), regions.repoOption);
    assert.equal(el.querySelector('#model-dropdown [role="option"]:nth-child(2)'), regions.modelOption);
    assert.equal(el.querySelector('[data-surface="chat"]'), regions.surfaceChip);
    assert.equal(el.querySelector('[data-source-group="copilot"]'), regions.sourceChip);
    el.remove();
  });

  it('a focused model option keeps focus across a live snapshot', () => {
    const { el, bar } = mount();
    bar.update(multiSnapshot(), 'cost');
    const option = el.querySelectorAll<HTMLElement>('#model-dropdown [role="option"]')[1]!;
    option.focus();
    assert.equal(document.activeElement, option);

    bar.update(multiSnapshot(), 'cost');
    assert.equal(document.activeElement, option, 'same node, still focused');
    el.remove();
  });

  it('a focused surface chip and source chip keep focus after being clicked and the snapshot arriving', () => {
    const { el, bar } = mount();
    bar.update(multiSnapshot(), 'cost');

    const surface = el.querySelector<HTMLElement>('[data-surface="chat"]')!;
    surface.focus();
    surface.click(); // dispatches the filter; the host answers with a fresh snapshot
    bar.update(multiSnapshot(), 'cost');
    assert.equal(document.activeElement, surface);
    assert.equal(surface.getAttribute('aria-pressed'), 'true');

    const source = el.querySelector<HTMLElement>('[data-source-group="claude-code"]')!;
    source.focus();
    source.click();
    bar.update(multiSnapshot(), 'cost');
    assert.equal(document.activeElement, source);
    assert.equal(source.getAttribute('aria-pressed'), 'true');
    el.remove();
  });

  it('when the model list really changes the dropdown is rebuilt and focus returns to the same model', () => {
    const { el, bar } = mount();
    bar.update(multiSnapshot(), 'cost');
    const sonnet = () =>
      [...el.querySelectorAll<HTMLElement>('#model-dropdown [role="option"]')].find((o) => o.dataset.model === 'claude-sonnet-4-5')!;
    const before = sonnet();
    before.focus();

    bar.update(multiSnapshot('gemini-2.5-pro'), 'cost');
    const after = sonnet();
    assert.notEqual(after, before, 'rebuilt, since a model was added');
    assert.ok(el.querySelector('#model-dropdown [data-model="gemini-2.5-pro"]'));
    assert.equal(document.activeElement, after, 'focus put back on the same model');
    el.remove();
  });

  it('the model label and checked state follow the filter even when the option list is unchanged', () => {
    const { el, bar } = mount();
    const snap = multiSnapshot();
    bar.update(snap, 'cost');
    assert.equal(el.querySelector('#model-filter-label')!.textContent, 'All models');

    setState({ filter: { models: ['gpt-4o'] } }); // e.g. toggled from the sidebar
    bar.update(snap, 'cost');
    assert.equal(el.querySelector('#model-filter-label')!.textContent, 'gpt-4o');
    assert.equal(
      el.querySelector('#model-dropdown [data-model="gpt-4o"]')!.getAttribute('aria-selected'),
      'true',
      'option list rebuilt because the selection (an input) changed',
    );
    el.remove();
  });
});

describe('live updates keep focus: banners', () => {
  const active: RestrictionState = {
    version: 1, active: true, ruleId: 'budget', reasonMessage: 'Over budget', firedAt: 100, userOverrideUntil: null,
  };

  it('RestrictionBanner does not rebuild (or re-announce) an unchanged alert, and focus stays on its button', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const banner = mountRestrictionBanner(el);
    banner.update(active);
    const alert = el.querySelector('[role="alert"]')!;
    const snooze = el.querySelector<HTMLElement>('#restrict-snooze-15')!;
    snooze.focus();

    banner.update({ ...active });
    banner.update({ ...active });
    assert.equal(el.querySelector('[role="alert"]'), alert, 'same alert node, so no re-announcement');
    assert.equal(document.activeElement, snooze);
    el.remove();
  });

  it('RestrictionBanner still re-renders when the rule fires again or the message changes', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const banner = mountRestrictionBanner(el);
    banner.update(active);
    const first = el.querySelector('[role="alert"]')!;

    banner.update({ ...active, firedAt: 200 });
    const second = el.querySelector('[role="alert"]')!;
    assert.notEqual(second, first, 'a new firing is announced');

    banner.update({ ...active, firedAt: 200, reasonMessage: 'Way over budget' });
    assert.equal(el.querySelector('strong')!.textContent, 'Way over budget');
    el.remove();
  });

  it('RestrictionBanner shows again after being cleared and re-fired with the same key', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const banner = mountRestrictionBanner(el);
    banner.update(active);
    banner.update(null);
    assert.equal(el.style.display, 'none');
    banner.update(active);
    assert.ok(el.querySelector('[role="alert"]'));
    assert.equal(el.style.display, '');
    el.remove();
  });

  function errorSnapshot(authError: string): UsageSnapshot {
    return { ...multiSnapshot(), authStatus: 'error' as AuthStatus, authError };
  }

  it('GitHubBillingStrip keeps its Retry button (and focus) across identical snapshots', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const strip = mountGitHubBillingStrip(el);
    strip.update(errorSnapshot('Network timeout'));
    const retry = el.querySelector<HTMLElement>('button')!;
    retry.focus();

    strip.update(errorSnapshot('Network timeout'));
    assert.equal(el.querySelector('button'), retry);
    assert.equal(document.activeElement, retry);

    strip.update(errorSnapshot('A GitHub Personal Access Token is required.'));
    assert.equal(el.querySelector('button')!.textContent, 'Set PAT', 'a changed error does re-render');
    el.remove();
  });

  it('GitHubBillingStrip re-renders the verified row when the billing total or the local cost changes', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const strip = mountGitHubBillingStrip(el);
    const base = multiSnapshot();
    const signedIn = (net: number, used: number): UsageSnapshot => ({
      ...base,
      authStatus: 'signed-in',
      budget: { ...base.budget, usedCost: used },
      githubBilling: { quota: null, items: [], fetchedAt: 1, totalNetAmount: net },
    });
    strip.update(signedIn(10, 10));
    const row = el.querySelector('.wv-gh-verified')!;
    strip.update(signedIn(10, 10));
    assert.equal(el.querySelector('.wv-gh-verified'), row, 'unchanged -> untouched');
    assert.equal(el.querySelector('.wv-gh-divergence'), null);

    strip.update(signedIn(10, 50));
    assert.ok(el.querySelector('.wv-gh-divergence'), 'local cost drifted from the API total');
    strip.update(signedIn(25, 50));
    assert.match(el.querySelector('.wv-gh-amount')!.textContent!, /25/);

    strip.update({ ...base, authStatus: 'signed-out' });
    assert.ok(el.querySelector('.wv-gh-unverified'));
    el.remove();
  });
});

describe('KpiCards month-to-date tokens', () => {
  it('never fabricates a token count from credits: the Tokens metric shows a dash for MTD', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const kpis = mountKpiCards(el);
    const snap = multiSnapshot();
    snap.budget = { ...snap.budget, usedCredits: 123 };

    kpis.update(snap, 'tokens');
    const mtd = el.querySelector('#kpi-mtd-val')!;
    assert.equal(mtd.textContent, '—');
    assert.ok(!/\d/.test(mtd.textContent!), 'no number at all, in particular not credits x 1000');
    assert.match(el.querySelector('#kpi-mtd-sub')!.textContent!, /123 cr/);
    assert.match(mtd.getAttribute('title')!, /not available/);

    kpis.update(snap, 'credits');
    assert.match(mtd.textContent!, /123 cr/);
    assert.equal(mtd.hasAttribute('title'), false);
    kpis.update(snap, 'cost');
    assert.match(mtd.textContent!, /\$/);
    el.remove();
  });

  it('the Today card still shows its real token total under the Tokens metric', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const kpis = mountKpiCards(el);
    const snap = multiSnapshot();
    snap.today = { credits: 8, cost: 0.3, tokens: 4200 };
    kpis.update(snap, 'tokens');
    assert.equal(el.querySelector('#kpi-today-val')!.textContent, '4.2k tok');
    el.remove();
  });
});
