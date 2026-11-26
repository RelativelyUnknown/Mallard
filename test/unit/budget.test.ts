import { strict as assert } from 'assert';
import { computeBudget, severityFor } from '../../src/extension-backend/domain/budget';
import { Forecast } from '../../src/extension-backend/domain/types';

function forecastWithCost(projectedCost: number): Forecast {
  return {
    granularity: 'month',
    projectedCredits: projectedCost / 0.04,
    projectedCost,
    low: projectedCost,
    high: projectedCost,
    basis: 'linear',
    asOf: Date.now(),
  };
}

describe('budget', () => {
  it('reports no-budget when none is set', () => {
    const b = computeBudget({
      monthlyBudget: 0,
      includedCredits: 300,
      mtdCredits: 50,
      mtdCost: 2,
      forecast: forecastWithCost(4),
    });
    assert.equal(b.pace, 'no-budget');
    assert.equal(b.projectedOverage, null);
    assert.ok(Math.abs(b.percentOfIncluded - 50 / 300) < 1e-9);
  });

  it('classifies pace by projected ratio', () => {
    const mk = (projCost: number) =>
      computeBudget({
        monthlyBudget: 30,
        includedCredits: 300,
        mtdCredits: 100,
        mtdCost: projCost / 2,
        forecast: forecastWithCost(projCost),
      }).pace;

    assert.equal(mk(12), 'under'); // 0.4
    assert.equal(mk(27), 'on-track'); // 0.9
    assert.equal(mk(36), 'warning'); // 1.2
    assert.equal(mk(45), 'over'); // 1.5
  });

  it('computes projected overage and severity', () => {
    const b = computeBudget({
      monthlyBudget: 30,
      includedCredits: 300,
      mtdCredits: 400,
      mtdCost: 16,
      forecast: forecastWithCost(45),
    });
    assert.ok(b.projectedOverage !== null && Math.abs(b.projectedOverage - 15) < 1e-9);
    assert.equal(severityFor(b), 'error');
  });

  it('percentOfIncluded is 0 when includedCredits is 0', () => {
    const b = computeBudget({
      monthlyBudget: 0,
      includedCredits: 0,
      mtdCredits: 50,
      mtdCost: 2,
      forecast: forecastWithCost(4),
    });
    assert.equal(b.percentOfIncluded, 0);
  });

  it('severityFor returns warning when pace is warning', () => {
    const b = computeBudget({
      monthlyBudget: 30,
      includedCredits: 300,
      mtdCredits: 100,
      mtdCost: 10,
      forecast: forecastWithCost(36), // ratio 1.2 → 'warning'
    });
    assert.equal(b.pace, 'warning');
    assert.equal(severityFor(b), 'warning');
  });

  it('severityFor returns normal when on-track and percentOfIncluded < 1', () => {
    const b = computeBudget({
      monthlyBudget: 0,
      includedCredits: 300,
      mtdCredits: 50,
      mtdCost: 2,
      forecast: forecastWithCost(4),
    });
    assert.equal(b.pace, 'no-budget');
    assert.equal(severityFor(b), 'normal');
  });

  it('negative monthlyBudget is treated as unset (pace = no-budget)', () => {
    const b = computeBudget({
      monthlyBudget: -10,
      includedCredits: 300,
      mtdCredits: 50,
      mtdCost: 2,
      forecast: forecastWithCost(40),
    });
    assert.equal(b.pace, 'no-budget');
    assert.equal(b.projectedOverage, null);
  });

  it('NaN projectedCost with budget set falls back to no-budget pace safely', () => {
    const b = computeBudget({
      monthlyBudget: 20,
      includedCredits: 300,
      mtdCredits: 50,
      mtdCost: 2,
      forecast: forecastWithCost(NaN),
    });
    assert.equal(b.pace, 'no-budget');
    assert.equal(b.projectedOverage, null);
  });

  it('warns when included credits are exhausted even without a budget', () => {
    const b = computeBudget({
      monthlyBudget: 0,
      includedCredits: 300,
      mtdCredits: 350,
      mtdCost: 14,
      forecast: forecastWithCost(20),
    });
    assert.equal(severityFor(b), 'warning');
  });
});

describe('budget — insufficient-data forecasts', () => {
  const insufficient = (projectedCost: number): Forecast => ({
    ...forecastWithCost(projectedCost),
    basis: 'insufficient-data',
  });
  const paceFor = (forecast: Forecast): string =>
    computeBudget({ monthlyBudget: 30, includedCredits: 300, mtdCredits: 10, mtdCost: forecast.projectedCost, forecast }).pace;

  it('does not claim "under" or "on-track" when nothing was forecast', () => {
    assert.equal(paceFor(insufficient(3)), 'no-budget');   // 0.1 of budget
    assert.equal(paceFor(insufficient(27)), 'no-budget');  // 0.9 of budget
    // Same numbers with a real forecast keep their pace.
    assert.equal(paceFor(forecastWithCost(3)), 'under');
    assert.equal(paceFor(forecastWithCost(27)), 'on-track');
  });

  it('still reports warning/over when the month-to-date total alone already exceeds the budget', () => {
    assert.equal(paceFor(insufficient(36)), 'warning');
    assert.equal(paceFor(insufficient(45)), 'over');
  });
});

describe('budget — pace thresholds are inclusive upper bounds', () => {
  // A 100 budget makes ratio === projectedCost / 100 exactly representable at every boundary.
  const paceAt = (projectedCost: number): string =>
    computeBudget({
      monthlyBudget: 100,
      includedCredits: 300,
      mtdCredits: 10,
      mtdCost: 10,
      forecast: forecastWithCost(projectedCost),
    }).pace;

  it('"under" ends at exactly 80% of budget (inclusive); anything above is "on-track"', () => {
    assert.equal(paceAt(79.99), 'under');
    assert.equal(paceAt(80), 'under', 'exactly 0.8 is still under');
    assert.equal(paceAt(81), 'on-track');
  });

  it('"on-track" ends at exactly 100% of budget (inclusive); anything above is "warning"', () => {
    assert.equal(paceAt(99), 'on-track');
    assert.equal(paceAt(100), 'on-track', 'projecting to exactly the budget is on track, not a warning');
    assert.equal(paceAt(100.01), 'warning');
  });

  it('"warning" ends at exactly 125% of budget (inclusive); anything above is "over"', () => {
    assert.equal(paceAt(124.99), 'warning');
    assert.equal(paceAt(125), 'warning', 'exactly 1.25 is still a warning');
    assert.equal(paceAt(126), 'over');
  });

  it('the same boundaries hold for an insufficient-data lower bound (where only warning/over are reported)', () => {
    const insufficient = (projectedCost: number): string =>
      computeBudget({
        monthlyBudget: 100,
        includedCredits: 300,
        mtdCredits: 10,
        mtdCost: projectedCost,
        forecast: { ...forecastWithCost(projectedCost), basis: 'insufficient-data' },
      }).pace;
    assert.equal(insufficient(80), 'no-budget');
    assert.equal(insufficient(100), 'no-budget');
    assert.equal(insufficient(101), 'warning');
    assert.equal(insufficient(125), 'warning');
    assert.equal(insufficient(125.01), 'over');
  });
});
