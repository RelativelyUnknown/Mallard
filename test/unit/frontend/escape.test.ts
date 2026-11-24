import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { CostCategory, UsageSnapshot } from '../../../src/extension-backend/domain/types';
import { escapeHtml } from '../../../src/extension-frontend/escapeHtml';
import { mountDailyBars } from '../../../src/extension-frontend/charts/dailyBars';
import { mountModelBreakdown } from '../../../src/extension-frontend/charts/modelBreakdown';
import { mountSankey } from '../../../src/extension-frontend/charts/sankey';
import { mountCategoryBreakdown } from '../../../src/extension-frontend/charts/categoryBreakdown';
import { mountCumulativeArea } from '../../../src/extension-frontend/charts/cumulativeArea';
import { mountWeekdayRadial } from '../../../src/extension-frontend/charts/weekdayRadial';
import { mountRepoBreakdown } from '../../../src/extension-frontend/charts/repoBreakdown';
import { mountCategoryTrend } from '../../../src/extension-frontend/charts/categoryTrend';
import { mountTokensTimeline } from '../../../src/extension-frontend/charts/tokensTimeline';
import { mountBillingItems } from '../../../src/extension-frontend/charts/billingItems';
import { mountLanguageBreakdown } from '../../../src/extension-frontend/charts/languageBreakdown';
import { mountRestrictionBanner } from '../../../src/extension-frontend/components/RestrictionBanner';
import { tooltipOf } from './stubChart';

const XSS: string = '<img src=x onerror=1>';
const ESCAPED = '&lt;img src=x onerror=1&gt;';

function baseSnapshot(): UsageSnapshot {
  const now = Date.now();
  return buildSnapshot(
    [
      makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits: 10, cost: 0.4, surface: 'chat' }),
      makeEvent({ ts: now - 2000, modelId: 'claude-sonnet-4-5', credits: 6, cost: 0.24, surface: 'inline' }),
    ],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
}

/** Assert a tooltip rendered the hostile string as inert text. */
function assertInert(html: string, label: string): void {
  assert.ok(!html.includes('<img'), `${label}: raw <img> tag leaked: ${html}`);
  assert.ok(html.includes(ESCAPED), `${label}: expected the escaped payload in: ${html}`);
}

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes ampersands first so existing entities are not double-decoded', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  it('coerces non-strings and leaves plain text untouched', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(undefined), 'undefined');
    assert.equal(escapeHtml('gpt-4o'), 'gpt-4o');
  });

  it('is self-contained: its source evaluates to a working function (SidebarView inlines it)', () => {
    const rebuilt = new Function(`return (${escapeHtml.toString()});`)() as (v: unknown) => string;
    assert.equal(rebuilt(XSS), ESCAPED);
  });
});

describe('chart tooltips never emit raw HTML from data', () => {
  function mount<H>(factory: (el: HTMLElement) => H): H {
    return factory(document.createElement('div'));
  }

  it('modelBreakdown: model id and a hostile currency code, in both cost and credit modes', () => {
    const s = baseSnapshot();
    s.currency = '<u>'; // not a valid ISO code, so formatMoney falls back to echoing it
    s.chartData.modelBreakdown = {
      labels: [XSS], credits: [10], costs: [1], tokens: [100], cheapestEquivalentCosts: [0.5],
    };
    const h = mount(mountModelBreakdown);
    h.update(s, 'cost');
    const withGhost = tooltipOf(h)([{ name: XSS, value: 1, seriesIndex: 0 }]);
    assertInert(withGhost, 'modelBreakdown/cost');
    assert.ok(!withGhost.includes('<u>'), 'currency code escaped too');
    h.update(s, 'credits');
    assertInert(tooltipOf(h)([{ name: XSS, value: 10, seriesIndex: 0 }]), 'modelBreakdown/credits');
  });

  it('repoBreakdown: repo key', () => {
    const s = baseSnapshot();
    s.byRepo = [{ key: XSS, credits: 3, cost: 0.1, tokens: 30, heuristicShare: 0.5 }];
    const h = mount(mountRepoBreakdown);
    h.update(s);
    assertInert(tooltipOf(h)([{ dataIndex: 0 }]), 'repoBreakdown');
  });

  it('languageBreakdown: language key', () => {
    const s = baseSnapshot();
    s.byLanguage = [{ key: XSS, credits: 3, cost: 0.1, tokens: 30 }];
    const h = mount(mountLanguageBreakdown);
    h.update(s);
    assertInert(tooltipOf(h)([{ dataIndex: 0 }]), 'languageBreakdown');
  });

  it('sankey: node names in both the node and the edge tooltip', () => {
    const s = baseSnapshot();
    s.sankeyLinks = [{ source: XSS, target: `to-${XSS}`, value: 4 }];
    const h = mount(mountSankey);
    h.update(s);
    const fmt = tooltipOf(h);
    assertInert(fmt({ dataType: 'node', name: XSS, value: 4 }), 'sankey/node');
    const edge = fmt({ dataType: 'edge', name: 'x', value: 4, data: { source: XSS, target: `to-${XSS}`, value: 4 } });
    assertInert(edge, 'sankey/edge');
    assert.ok(edge.includes(`to-${ESCAPED}`), 'target escaped as well as source');
  });

  it('billingItems: billing model and SKU (the label falls back from one to the other)', () => {
    const s = baseSnapshot();
    s.githubBilling = {
      quota: null, fetchedAt: Date.now(), totalNetAmount: 5,
      items: [{ model: XSS, sku: 'sku', grossAmount: 9, netAmount: 5, grossQuantity: 1 }],
    };
    const h = mount(mountBillingItems);
    h.update(s);
    assertInert(tooltipOf(h)([{ dataIndex: 0 }]), 'billingItems/model');

    s.githubBilling = {
      quota: null, fetchedAt: Date.now(), totalNetAmount: 5,
      items: [{ model: '', sku: XSS, grossAmount: 5, netAmount: 5, grossQuantity: 1 }],
    };
    h.update(s);
    assertInert(tooltipOf(h)([{ dataIndex: 0 }]), 'billingItems/sku');
  });

  it('categoryBreakdown: an unrecognised category name', () => {
    const s = baseSnapshot();
    s.chartData.categoryBreakdown = { categories: [XSS as CostCategory], costs: [1], available: true };
    const h = mount(mountCategoryBreakdown);
    h.update(s);
    assertInert(tooltipOf(h)({ name: XSS, value: 1, percent: 100 }), 'categoryBreakdown');
  });

  it('categoryTrend: series name and axis label', () => {
    const s = baseSnapshot();
    s.chartData.categoryTrend = {
      dates: ['01-01'], series: [{ category: XSS as CostCategory, costs: [1] }], available: true,
    };
    const h = mount(mountCategoryTrend);
    h.update(s);
    const html = tooltipOf(h)([{ seriesName: XSS, value: 1, axisValue: XSS }]);
    assert.ok(!html.includes('<img'), html);
    assert.equal(html.split(ESCAPED).length - 1, 2, 'both series name and axis label escaped');
  });

  it('tokensTimeline: date label', () => {
    const s = baseSnapshot();
    s.chartData.tokensDaily = { dates: [XSS], tokens: [10], events: [1] };
    const h = mount(mountTokensTimeline);
    h.update(s);
    assertInert(tooltipOf(h)([{ dataIndex: 0, axisValue: XSS }]), 'tokensTimeline');
  });

  it('dailyBars: date label', () => {
    const s = baseSnapshot();
    s.chartData.dailyBars.points = [{ date: XSS, credits: 3, cost: 0.1, colorIndex: 0 }];
    const h = mount(mountDailyBars);
    h.update(s);
    assertInert(tooltipOf(h)([{ dataIndex: 0 }]), 'dailyBars');
  });

  it('cumulativeArea: date label', () => {
    const s = baseSnapshot();
    s.chartData.dailyBars.points = [{ date: XSS, credits: 3, cost: 0.1, colorIndex: 0 }];
    s.chartData.dailyBars.cumulativeCosts = [0.1];
    const h = mount(mountCumulativeArea);
    h.update(s);
    assertInert(tooltipOf(h)([{ dataIndex: 0 }]), 'cumulativeArea');
  });

  it('weekdayRadial: item name', () => {
    const s = baseSnapshot();
    s.chartData.weekdayBreakdown = { totals: [1, 2, 3, 4, 5, 6, 7], peak: 6 };
    const h = mount(mountWeekdayRadial);
    h.update(s);
    assertInert(tooltipOf(h)({ name: XSS, value: 3 }), 'weekdayRadial');
  });
});

describe('RestrictionBanner escapes rule id and message', () => {
  it('renders hostile reason/rule text as text, in both the active and snoozed views', () => {
    const el = document.createElement('div');
    const banner = mountRestrictionBanner(el);
    banner.update({ version: 1, active: true, ruleId: XSS, reasonMessage: XSS, firedAt: 1, userOverrideUntil: null });
    assert.equal(el.querySelector('img'), null);
    assert.equal(el.querySelector('strong')!.textContent, XSS);

    banner.update({ version: 1, active: true, ruleId: XSS, reasonMessage: XSS, firedAt: 1, userOverrideUntil: Date.now() + 120_000 });
    assert.equal(el.querySelector('img'), null);
    assert.equal(el.querySelector('code')!.textContent, XSS);
  });
});
