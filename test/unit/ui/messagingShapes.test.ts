import { strict as assert } from 'assert';
import { isHostBoundMsg, parseFilter } from '../../../src/extension-backend/ui/messaging';

describe('parseFilter', () => {
  it('rebuilds a well-formed filter', () => {
    const f = parseFilter({
      range: { start: 1, end: 2 },
      models: ['gpt-4o'],
      surfaces: ['chat', 'agent'],
      repos: ['r'],
      branches: ['main'],
      sources: ['local', 'claude-code'],
    });
    assert.deepEqual(f, {
      range: { start: 1, end: 2 },
      models: ['gpt-4o'],
      surfaces: ['chat', 'agent'],
      repos: ['r'],
      branches: ['main'],
      sources: ['local', 'claude-code'],
    });
  });

  it('accepts the empty filter and drops unknown keys', () => {
    assert.deepEqual(parseFilter({}), {});
    assert.deepEqual(parseFilter({ models: ['a'], __proto__: { x: 1 }, evil: 'x' }), { models: ['a'] });
  });

  it('discards unknown surface/source names instead of passing them through', () => {
    assert.deepEqual(parseFilter({ surfaces: ['chat', 'nope'], sources: ['nope'] }), { surfaces: ['chat'], sources: [] });
  });

  it('rejects non-objects and wrong shapes', () => {
    for (const bad of [null, undefined, 'x', 42, [], [{ models: [] }]]) {
      assert.equal(parseFilter(bad), undefined, JSON.stringify(bad));
    }
    for (const bad of [
      { models: 'gpt-4o' },
      { models: [1, 2] },
      { models: [{ toString: 'x' }] },
      { repos: [null] },
      { branches: {} },
      { surfaces: 'chat' },
      { sources: [3] },
      { range: 'today' },
      { range: { start: 'a', end: 2 } },
      { range: { start: 1 } },
      { range: { start: NaN, end: 2 } },
      { range: { start: 1, end: Infinity } },
      { models: ['x'.repeat(5000)] },
    ]) {
      assert.equal(parseFilter(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('isHostBoundMsg — payload shapes', () => {
  it('setFilter requires a valid filter shape, not just an object', () => {
    assert.equal(isHostBoundMsg({ type: 'setFilter', value: { models: ['a'] } }), true);
    assert.equal(isHostBoundMsg({ type: 'setFilter', value: { models: 'a' } }), false);
    assert.equal(isHostBoundMsg({ type: 'setFilter', value: { range: { start: 'x', end: 1 } } }), false);
    assert.equal(isHostBoundMsg({ type: 'setFilter', value: [] }), false);
  });

  it('setConfig requires a plausibly-shaped patch', () => {
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { monthlyBudget: 5, alerts: { velocityEnabled: true } } }), true);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { rules: [{ id: 'r' }], currency: 'EUR' } }), true);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: [] }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { monthlyBudget: '5' } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { monthlyBudget: NaN } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { alerts: { velocityEnabled: 'yes' } } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { alerts: 3 } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { rules: 'all' } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { rules: [null] } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { rules: [{ message: 'no id' }] } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { currency: 5 } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { display: [] } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { branchBudgets: { main: 'lots' } } }), false);
    assert.equal(isHostBoundMsg({ type: 'setConfig', value: { version: 3 } }), false);
  });

  it('setLayout requires an array of objects with a string id', () => {
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [{ id: 'daily', span: 2, hidden: false }] }), true);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [{ id: 'daily', size: 'tall' }] }), true);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [null] }), false);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: ['daily'] }), false);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [{ span: 2 }] }), false);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [{ id: 7 }] }), false);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [{ id: 'daily', span: 'wide' }] }), false);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [{ id: 'daily', hidden: 'yes' }] }), false);
    assert.equal(isHostBoundMsg({ type: 'setLayout', value: [[]] }), false);
  });
});
