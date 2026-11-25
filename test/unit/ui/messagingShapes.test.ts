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

  it('keeps a known rangePreset, drops an unknown one, and rejects a non-string', () => {
    assert.deepEqual(parseFilter({ rangePreset: '7d', range: { start: 1, end: 2 } }), {
      range: { start: 1, end: 2 },
      rangePreset: '7d',
    });
    for (const preset of ['today', '30d', 'month', 'all']) {
      assert.equal(parseFilter({ rangePreset: preset })?.rangePreset, preset);
    }
    assert.deepEqual(parseFilter({ rangePreset: 'fortnight' }), {});
    assert.deepEqual(parseFilter({ rangePreset: 'toString' }), {}, 'inherited property names are not presets');
    assert.equal(parseFilter({ rangePreset: 7 }), undefined);
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

  it('setLayout requires a strict version-2 layout: unique ids, integer rects inside the grid, a boolean hidden', () => {
    const panel = { id: 'daily', x: 0, y: 0, w: 2, h: 13, hidden: false };
    const send = (value: unknown) => isHostBoundMsg({ type: 'setLayout', value });
    assert.equal(send({ version: 2, panels: [panel] }), true);
    assert.equal(send({ version: 2, panels: [{ ...panel, x: 2 }] }), true);
    assert.equal(send({ version: 1, panels: [panel] }), false);
    assert.equal(send([panel]), false);
    assert.equal(send({ version: 2, panels: [null] }), false);
    assert.equal(send({ version: 2, panels: ['daily'] }), false);
    assert.equal(send({ version: 2, panels: [{ ...panel, id: 7 }] }), false);
    assert.equal(send({ version: 2, panels: [{ ...panel, w: 'wide' }] }), false);
    assert.equal(send({ version: 2, panels: [{ ...panel, x: 3 }] }), false, 'x + w beyond the 4th column');
    assert.equal(send({ version: 2, panels: [{ ...panel, hidden: 'yes' }] }), false);
    assert.equal(send({ version: 2, panels: [panel, panel] }), false, 'duplicate id');
  });
});
