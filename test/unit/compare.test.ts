import { strict as assert } from 'assert';
import { compare, toNumeric } from '../../src/extension-backend/domain/compare';
import type { CompareOp } from '../../src/extension-backend/domain/compare';

const OPS: CompareOp[] = ['>', '>=', '<', '<=', '==', '!='];

describe('compare', () => {
  it('applies each operator to two numbers', () => {
    assert.equal(compare(5, 3, '>'), true);
    assert.equal(compare(3, 3, '>'), false);
    assert.equal(compare(3, 3, '>='), true);
    assert.equal(compare(2, 3, '<'), true);
    assert.equal(compare(3, 3, '<'), false);
    assert.equal(compare(3, 3, '<='), true);
    assert.equal(compare(4, 3, '<='), false);
    assert.equal(compare(3, 3, '=='), true);
    assert.equal(compare(3, 4, '!='), true);
    assert.equal(compare(3, 3, '!='), false);
  });

  it('a missing or null operand makes every operator false except !=', () => {
    for (const op of OPS) {
      for (const [l, r] of [[undefined, 1], [1, undefined], [null, 1], [1, null], [undefined, undefined]] as const) {
        assert.equal(compare(l, r, op), op === '!=', `${String(l)} ${op} ${String(r)}`);
      }
    }
  });

  it('ordering operators need two numbers; numeric strings coerce, everything else is false', () => {
    assert.equal(compare('12', 3, '>'), true);
    assert.equal(compare(3, '1e1', '<'), true);
    assert.equal(compare('-3.5', -4, '>'), true);
    for (const bad of ['abc', '', ' 7', '0x10', '0b1', true, NaN, Infinity, {}, []]) {
      for (const op of ['>', '>=', '<', '<='] as const) assert.equal(compare(bad, 1, op), false, `${String(bad)} ${op} 1`);
    }
  });

  it('== / != are numeric when both sides are numeric, strict otherwise', () => {
    assert.equal(compare(50, '50', '=='), true);
    assert.equal(compare('50', '50.0', '=='), true);
    assert.equal(compare('a', 'a', '=='), true);
    assert.equal(compare('a', 'b', '=='), false);
    assert.equal(compare(1, true, '=='), false, 'a boolean is not numeric');
    assert.equal(compare('abc', 1, '!='), true);
    assert.equal(compare(NaN, NaN, '=='), false);
  });
});

describe('toNumeric', () => {
  it('accepts finite numbers and canonical numeric text only', () => {
    assert.equal(toNumeric(4), 4);
    assert.equal(toNumeric('4'), 4);
    assert.equal(toNumeric('+1.5'), 1.5);
    assert.equal(toNumeric('.5'), 0.5);
    assert.equal(toNumeric('1e3'), 1000);
    for (const bad of [NaN, Infinity, '', ' 7', '7 ', '0x10', '1e999', 'x'.repeat(70), '9'.repeat(65), null, undefined, true, {}]) {
      assert.equal(toNumeric(bad), null, String(bad));
    }
  });
});
