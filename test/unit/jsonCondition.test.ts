import { strict as assert } from 'assert';
import { evalCondition, evalSimpleCondition, evalRule, parseVarPath, resolveVar, wildcardMatches, JsonConditionSchema } from '../../src/extension-backend/domain/expr/jsonCondition';
import type { JsonCondition, JsonOperand } from '../../src/extension-backend/domain/types';

const ctx: Record<string, unknown> = {
  today: { credits: 50, cost: 2.5, tokens: 1000 },
  budget: { percentOfBudget: 0.4 },
  flag: true,
  empty: '',
};

describe('resolveVar', () => {
  it('resolves a top-level key', () => {
    assert.equal(resolveVar('flag', ctx), true);
  });

  it('resolves a dot-nested path', () => {
    assert.equal(resolveVar('today.credits', ctx), 50);
  });

  it('returns undefined for a missing segment', () => {
    assert.equal(resolveVar('today.missing', ctx), undefined);
  });

  it('returns undefined when a mid-path segment is not an object', () => {
    assert.equal(resolveVar('flag.child', ctx), undefined);
  });

  it('returns undefined for an unknown top-level key', () => {
    assert.equal(resolveVar('unknown', ctx), undefined);
  });
});

describe('evalCondition — literals', () => {
  it('literal true returns true', () => {
    assert.equal(evalCondition(true, ctx), true);
  });

  it('literal false returns false', () => {
    assert.equal(evalCondition(false, ctx), false);
  });
});

describe('evalCondition — var truthy check', () => {
  it('present truthy value is true', () => {
    assert.equal(evalCondition({ var: 'flag' }, ctx), true);
  });

  it('absent path is falsy (undefined)', () => {
    assert.equal(evalCondition({ var: 'nonexistent' }, ctx), false);
  });

  it('empty string is falsy', () => {
    assert.equal(evalCondition({ var: 'empty' }, ctx), false);
  });
});

describe('evalCondition — comparison operators', () => {
  it('> fires when left > right', () => {
    assert.equal(evalCondition({ '>': [{ var: 'today.credits' }, 40] }, ctx), true);
  });

  it('> does not fire when left <= right', () => {
    assert.equal(evalCondition({ '>': [{ var: 'today.credits' }, 50] }, ctx), false);
  });

  it('>= fires when left >= right', () => {
    assert.equal(evalCondition({ '>=': [{ var: 'today.credits' }, 50] }, ctx), true);
  });

  it('< fires when left < right', () => {
    assert.equal(evalCondition({ '<': [{ var: 'today.credits' }, 60] }, ctx), true);
  });

  it('<= fires when left <= right', () => {
    assert.equal(evalCondition({ '<=': [{ var: 'today.credits' }, 50] }, ctx), true);
  });

  it('== fires on strict equality (number)', () => {
    assert.equal(evalCondition({ '==': [{ var: 'today.credits' }, 50] }, ctx), true);
  });

  // Was "== does not coerce types" (50 == '50' → false). Comparison semantics are
  // now defined once: numeric when both sides are numeric, strict otherwise.
  it('== compares numerically when both sides are numeric (number vs numeric string)', () => {
    assert.equal(evalCondition({ '==': [{ var: 'today.credits' }, '50'] }, ctx), true);
    assert.equal(evalCondition({ '!=': [{ var: 'today.credits' }, '50'] }, ctx), false);
  });

  it('!= fires when values differ', () => {
    assert.equal(evalCondition({ '!=': [{ var: 'today.credits' }, 99] }, ctx), true);
  });

  it('!= does not fire on equal values', () => {
    assert.equal(evalCondition({ '!=': [{ var: 'today.credits' }, 50] }, ctx), false);
  });

  it('numeric op returns false when either side is NaN', () => {
    assert.equal(evalCondition({ '>': [NaN, 0] }, {}), false);
    assert.equal(evalCondition({ '<': [NaN, 0] }, {}), false);
  });

  it('literal operands work without var reference', () => {
    assert.equal(evalCondition({ '>': [10, 5] }, {}), true);
    assert.equal(evalCondition({ '>': [5, 10] }, {}), false);
  });
});

describe('evalCondition — boolean operators', () => {
  it('and: all-true fires', () => {
    const cond: JsonCondition = { and: [
      { '>': [{ var: 'today.credits' }, 40] },
      { '<': [{ var: 'budget.percentOfBudget' }, 1] },
    ] };
    assert.equal(evalCondition(cond, ctx), true);
  });

  it('and: short-circuits on first false', () => {
    const cond: JsonCondition = { and: [false, true] };
    assert.equal(evalCondition(cond, ctx), false);
  });

  it('and: empty array is true', () => {
    assert.equal(evalCondition({ and: [] }, ctx), true);
  });

  it('or: short-circuits on first true', () => {
    const cond: JsonCondition = { or: [true, false] };
    assert.equal(evalCondition(cond, ctx), true);
  });

  it('or: all-false is false', () => {
    const cond: JsonCondition = { or: [false, false] };
    assert.equal(evalCondition(cond, ctx), false);
  });

  it('or: empty array is false', () => {
    assert.equal(evalCondition({ or: [] }, ctx), false);
  });

  it('not: inverts true to false', () => {
    assert.equal(evalCondition({ not: true }, ctx), false);
  });

  it('not: inverts false to true', () => {
    assert.equal(evalCondition({ not: false }, ctx), true);
  });

  it('double not is identity', () => {
    const original: JsonCondition = { '>': [{ var: 'today.credits' }, 0] };
    assert.equal(evalCondition({ not: { not: original } }, ctx), evalCondition(original, ctx));
  });
});

describe('evalCondition — deep nesting', () => {
  it('nested and/or/not evaluates correctly', () => {
    const cond: JsonCondition = { and: [
      { or: [false, { '>': [{ var: 'today.credits' }, 40] }] },
      { not: { '>=': [{ var: 'budget.percentOfBudget' }, 1] } },
    ] };
    assert.equal(evalCondition(cond, ctx), true);
  });
});

describe('JsonConditionSchema', () => {
  it('accepts a valid comparison object', () => {
    const r = JsonConditionSchema.safeParse({ '>': [{ var: 'today.credits' }, 50] });
    assert.equal(r.success, true);
  });

  it('accepts boolean literals', () => {
    assert.equal(JsonConditionSchema.safeParse(true).success, true);
    assert.equal(JsonConditionSchema.safeParse(false).success, true);
  });

  it('accepts and/or/not', () => {
    assert.equal(JsonConditionSchema.safeParse({ and: [true, false] }).success, true);
    assert.equal(JsonConditionSchema.safeParse({ or: [true] }).success, true);
    assert.equal(JsonConditionSchema.safeParse({ not: true }).success, true);
  });

  it('rejects an unknown operator key', () => {
    const r = JsonConditionSchema.safeParse({ 'xor': [true, false] });
    assert.equal(r.success, false);
  });

  it('rejects a comparison with wrong arity (3 operands)', () => {
    const r = JsonConditionSchema.safeParse({ '>': [1, 2, 3] });
    assert.equal(r.success, false);
  });

  it('rejects a non-object, non-boolean value', () => {
    const r = JsonConditionSchema.safeParse('today.credits > 0');
    assert.equal(r.success, false);
  });
});

describe('evalSimpleCondition', () => {
  const ctx = { today: { credits: 75 }, topModel: { id: 'claude-sonnet-4' } };

  it('evaluates numeric comparison', () => {
    assert.equal(evalSimpleCondition({ field: 'today.credits', op: '>', value: 50 }, ctx), true);
    assert.equal(evalSimpleCondition({ field: 'today.credits', op: '>', value: 100 }, ctx), false);
  });

  it('evaluates in operator', () => {
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'in', value: ['claude-sonnet-4', 'gpt-4o'] }, ctx), true);
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'in', value: ['gpt-4o'] }, ctx), false);
  });

  it('evaluates in operator with scalar value (non-array)', () => {
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'in', value: 'claude-sonnet-4' as unknown as string[] }, ctx), true);
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'in', value: 'gpt-4o' as unknown as string[] }, ctx), false);
  });

  it('evaluates matches operator with ^/$ anchored patterns', () => {
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'matches', value: '^claude-' }, ctx), true);
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'matches', value: '^gpt-' }, ctx), false);
  });

  // Was "matches operator coerces undefined fieldValue to empty string" (^$ → true):
  // a missing value now never satisfies any operator except !=.
  it('matches is false for a missing field, whatever the pattern', () => {
    assert.equal(evalSimpleCondition({ field: 'nonexistent', op: 'matches', value: '^$' }, ctx), false);
    assert.equal(evalSimpleCondition({ field: 'nonexistent', op: 'matches', value: '*' }, ctx), false);
    assert.equal(evalSimpleCondition({ field: 'nonexistent', op: 'matches', value: '^claude' }, ctx), false);
  });

  it('treats regex metacharacters literally instead of failing', () => {
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'matches', value: '[invalid(' }, ctx), false);
    assert.equal(evalSimpleCondition({ field: 'topModel.id', op: 'matches', value: '(?:a)' }, ctx), false);
  });
});

describe('resolveVar — edge cases', () => {
  it('resolves __proto__ path without throwing (read-only access to prototype)', () => {
    assert.doesNotThrow(() => resolveVar('__proto__', {}));
    assert.doesNotThrow(() => resolveVar('__proto__.toString', {}));
  });

  it('returns undefined when mid-path value is a primitive (stops traversal)', () => {
    assert.equal(resolveVar('a.b.c.d.e', { a: { b: 42 } }), undefined);
  });

  it('handles an empty-string path segment when key is absent on the object', () => {
    // 'a..b' splits to ['a', '', 'b'] — the '' key does not exist here → undefined
    assert.equal(resolveVar('a..b', { a: { noEmptyKey: 1 } }), undefined);
  });
});

describe('evalCondition — non-numeric string operands', () => {
  it('returns false for > when left side is a non-numeric string', () => {
    assert.equal(evalCondition({ '>': ['abc', 5] }, {}), false);
  });

  it('returns false for < when both sides are non-numeric strings', () => {
    assert.equal(evalCondition({ '<': ['abc', 'def'] }, {}), false);
  });

  // Was "== does not coerce non-numeric strings to numbers" using ['5', 5] — but '5'
  // IS numeric, so that pinned the old strict-only rule. Non-numeric strings stay strict.
  it('== compares non-numeric strings strictly, never as numbers', () => {
    assert.equal(evalCondition({ '==': ['abc', 5] }, {}), false);
    assert.equal(evalCondition({ '==': ['abc', 'abc'] }, {}), true);
    assert.equal(evalCondition({ '==': ['', 0] }, {}), false);
    assert.equal(evalCondition({ '==': ['5', 5] }, {}), true);
  });
});

describe('evalRule', () => {
  const ctx = { today: { credits: 75 } };

  it('uses "when" when present', () => {
    const rule = { when: { '>': [{ var: 'today.credits' }, 50] as [JsonOperand, JsonOperand] } };
    assert.equal(evalRule(rule, ctx), true);
  });

  it('uses "conditions" when "when" is absent', () => {
    const rule = { conditions: [{ field: 'today.credits', op: '>' as const, value: 50 }] };
    assert.equal(evalRule(rule, ctx), true);
  });

  it('returns false when neither when nor conditions', () => {
    assert.equal(evalRule({}, ctx), false);
  });

  it('evaluates conditions with match=none via evalRuleConditions', () => {
    const rule = {
      conditions: [
        { field: 'today.credits', op: '>' as const, value: 100 },
        { field: 'today.credits', op: '>' as const, value: 200 },
      ],
      match: 'none' as const,
    };
    assert.equal(evalRule(rule, ctx), true); // credits=75, none match (both fail)
    const rule2 = {
      conditions: [{ field: 'today.credits', op: '>' as const, value: 50 }],
      match: 'none' as const,
    };
    assert.equal(evalRule(rule2, ctx), false); // credits=75 > 50, so "some" match → none=false
  });
});

describe('matches — safe wildcard matching (no user regex)', () => {
  const cx = { model: { id: 'Claude-3.5-Sonnet' }, n: 42, flag: true };
  const matches = (value: string, field = 'model.id') =>
    evalSimpleCondition({ field, op: 'matches', value }, cx);

  it('supports * and ? wildcards, case-insensitively, anchored to the whole value', () => {
    assert.equal(matches('claude-*'), true);
    assert.equal(matches('*sonnet'), true);
    assert.equal(matches('claude-?.?-sonnet'), true);
    assert.equal(matches('claude'), false, 'no implicit substring match');
    assert.equal(matches('claude-3.5-sonnet'), true, 'case-insensitive exact');
    assert.equal(matches('claude-3.5'), false, 'anchored at the end');
    assert.equal(matches('*'), true);
    assert.equal(matches('?'), false);
  });

  it('treats regex metacharacters as literals', () => {
    assert.equal(matches('claude-3.5-*'), true);
    assert.equal(matches('claude-3x5-*'), false, '"." is not a wildcard');
    assert.equal(matches('(claude|gpt)*'), false, 'alternation is not supported');
    assert.equal(matches('[a-z]*'), false);
  });

  it('keeps accepting simple ^prefix / suffix$ / ^exact$ anchors', () => {
    assert.equal(matches('^claude-'), true);
    assert.equal(matches('^gpt-'), false);
    assert.equal(matches('sonnet$'), true);
    assert.equal(matches('^claude-3.5-sonnet$'), true);
    assert.equal(matches('^claude$'), false);
  });

  it('REGRESSION: a catastrophic-backtracking pattern runs in linear time (was ~1.5s at 26 chars, ~19s at 30)', () => {
    const victim = { text: `${'a'.repeat(26)}!` };
    const started = Date.now();
    const result = evalSimpleCondition({ field: 'text', op: 'matches', value: '(a|a)*$' }, victim);
    const elapsed = Date.now() - started;
    assert.equal(result, false);
    assert.ok(elapsed < 200, `matches took ${elapsed}ms`);
  });

  it('many-star patterns stay fast on long inputs', () => {
    const victim = { text: 'a'.repeat(500) };
    const started = Date.now();
    assert.equal(evalSimpleCondition({ field: 'text', op: 'matches', value: '*a*a*a*a*a*a*a*a*b' }, victim), false);
    assert.ok(Date.now() - started < 200);
  });

  it('caps input and pattern length (over the cap never matches)', () => {
    assert.equal(wildcardMatches('*', 'a'.repeat(512)), true);
    assert.equal(wildcardMatches('*', 'a'.repeat(513)), false);
    assert.equal(wildcardMatches('a'.repeat(256), 'a'.repeat(256)), true);
    assert.equal(wildcardMatches('a'.repeat(257), 'a'.repeat(257)), false);
  });

  it('only matches string patterns against primitive values', () => {
    assert.equal(evalSimpleCondition({ field: 'n', op: 'matches', value: '4?' }, cx), true, 'numbers are stringified');
    assert.equal(evalSimpleCondition({ field: 'flag', op: 'matches', value: 'true' }, cx), true);
    assert.equal(evalSimpleCondition({ field: 'n', op: 'matches', value: 42 }, cx), false, 'non-string pattern');
    assert.equal(evalSimpleCondition({ field: 'n', op: 'matches', value: ['42'] }, cx), false);
    assert.equal(evalSimpleCondition({ field: 'model', op: 'matches', value: '*' }, cx), false, 'objects never match');
  });
});

describe('comparison semantics (shared by evalCondition and evalSimpleCondition)', () => {
  type Op = '>' | '>=' | '<' | '<=' | '==' | '!=';
  const OPS: Op[] = ['>', '>=', '<', '<=', '==', '!='];
  const cx = { n: 5, s: '5', word: 'abc', yes: true, zero: 0, blank: '', nil: null };

  /** Evaluate the same comparison through both entry points. */
  function both(field: string, op: Op, value: number | string | boolean): [boolean, boolean] {
    const viaJson = evalCondition({ [op]: [{ var: field }, value] } as JsonCondition, cx);
    const viaSimple = evalSimpleCondition({ field, op, value }, cx);
    return [viaJson, viaSimple];
  }

  it('a missing or null operand makes every operator false except !=', () => {
    for (const field of ['missing', 'nil']) {
      for (const op of OPS) {
        const [viaJson, viaSimple] = both(field, op, 5);
        const expected = op === '!=';
        assert.equal(viaJson, expected, `${field} ${op} 5 (evalCondition)`);
        assert.equal(viaSimple, expected, `${field} ${op} 5 (evalSimpleCondition)`);
      }
    }
    // The right-hand side is covered too.
    assert.equal(evalCondition({ '<': [5, { var: 'missing' }] }, cx), false);
    assert.equal(evalCondition({ '!=': [5, { var: 'missing' }] }, cx), true);
  });

  it('ordering operators need two numbers; numeric strings coerce, everything else is false', () => {
    assert.deepEqual(both('s', '>', 4), [true, true], "'5' > 4");
    assert.deepEqual(both('n', '<=', '5'), [true, true], "5 <= '5'");
    assert.deepEqual(both('n', '>=', '1e1'), [false, false], "5 >= '1e1' (=10)");
    for (const field of ['word', 'blank', 'yes']) {
      for (const op of ['>', '>=', '<', '<='] as const) {
        assert.deepEqual(both(field, op, 0), [false, false], `${field} ${op} 0 must not coerce`);
      }
    }
    assert.equal(evalCondition({ '>=': ['0x10', 1] }, {}), false, 'hex is not canonical numeric');
    assert.equal(evalCondition({ '>': [' 7', 1] }, {}), false, 'padded strings are not canonical numeric');
    assert.equal(evalCondition({ '<': [Infinity, 1] }, {}), false);
  });

  it('== / != are numeric when both sides are numeric, strict otherwise', () => {
    assert.deepEqual(both('n', '==', '5'), [true, true]);
    assert.deepEqual(both('s', '==', 5), [true, true]);
    assert.deepEqual(both('n', '!=', '5'), [false, false]);
    assert.deepEqual(both('yes', '==', 1), [false, false], 'booleans are not numbers');
    assert.deepEqual(both('yes', '==', true), [true, true]);
    assert.deepEqual(both('blank', '==', 0), [false, false], "'' is not 0");
    assert.deepEqual(both('word', '==', 'abc'), [true, true]);
    assert.deepEqual(both('word', '!=', 'abc'), [false, false]);
  });

  it("'in' uses the same equality as ==, and a missing field is never 'in'", () => {
    assert.equal(evalSimpleCondition({ field: 'n', op: 'in', value: ['5', 'x'] }, cx), true, "5 in ['5']");
    assert.equal(evalSimpleCondition({ field: 's', op: 'in', value: [5] }, cx), true, "'5' in [5]");
    assert.equal(evalSimpleCondition({ field: 'word', op: 'in', value: ['abc'] }, cx), true);
    assert.equal(evalSimpleCondition({ field: 'blank', op: 'in', value: [0] }, cx), false);
    assert.equal(evalSimpleCondition({ field: 'missing', op: 'in', value: ['', 0] }, cx), false);
  });
});

describe('var paths — bracket segments and own-property reads', () => {
  it('parseVarPath splits dotted paths as before and reads bracket segments literally', () => {
    assert.deepEqual(parseVarPath('today.credits'), ['today', 'credits']);
    assert.deepEqual(parseVarPath('model["gpt-4.1"].credits'), ['model', 'gpt-4.1', 'credits']);
    assert.deepEqual(parseVarPath("repo['foo.js']"), ['repo', 'foo.js']);
    assert.deepEqual(parseVarPath('a["x"]["y.z"].b'), ['a', 'x', 'y.z', 'b']);
    assert.deepEqual(parseVarPath('a["it\\"s"]'), ['a', 'it"s'], 'backslash escapes the quote');
    assert.deepEqual(parseVarPath('a[0]'), ['a', '0'], 'bare bracket content');
    assert.deepEqual(parseVarPath('a..b'), ['a', '', 'b'], 'empty segments are kept');
  });

  it('parseVarPath rejects malformed paths', () => {
    assert.equal(parseVarPath('a["b'), null);
    assert.equal(parseVarPath('a["b"'), null);
    assert.equal(parseVarPath('a[b'), null);
    assert.equal(parseVarPath('a["b"]c'), null);
  });

  it('REGRESSION: keys containing dots are reachable (gpt-4.1, claude-3.5-sonnet, foo.js)', () => {
    const cx = {
      model: { 'gpt-4.1': { credits: 12 }, 'claude-3.5-sonnet': { credits: 7 } },
      repo: { 'foo.js': { cost: 3 }, 'a.b/c.d': { cost: 9 } },
    };
    assert.equal(resolveVar('model["gpt-4.1"].credits', cx), 12);
    assert.equal(resolveVar("model['claude-3.5-sonnet'].credits", cx), 7);
    assert.equal(resolveVar('repo["foo.js"].cost', cx), 3);
    assert.equal(resolveVar("repo['a.b/c.d'].cost", cx), 9);
    // The unquoted dotted form still means nested access (and so does not find them).
    assert.equal(resolveVar('model.gpt-4.1.credits', cx), undefined);
    assert.equal(evalCondition({ '>': [{ var: 'model["gpt-4.1"].credits' }, 10] }, cx), true);
    assert.equal(evalSimpleCondition({ field: "repo['foo.js'].cost", op: '==', value: 3 }, cx), true);
  });

  it('only reads own properties: inherited names resolve to undefined', () => {
    const cx: Record<string, unknown> = { a: {} };
    assert.equal(resolveVar('constructor', cx), undefined);
    assert.equal(resolveVar('a.constructor', cx), undefined);
    assert.equal(resolveVar('__proto__', cx), undefined);
    assert.equal(resolveVar('a.__proto__', cx), undefined);
    assert.equal(resolveVar('a["toString"]', cx), undefined);
    assert.equal(resolveVar('a.hasOwnProperty', cx), undefined);
    assert.equal(evalCondition({ var: 'constructor' }, cx), false);
  });

  it('reads an own "__proto__" key from a null-prototype map as plain data', () => {
    const map = Object.create(null) as Record<string, unknown>;
    map['__proto__'] = { credits: 1 };
    assert.equal(resolveVar('m["__proto__"].credits', { m: map }), 1);
    assert.equal(Object.getPrototypeOf(map), null);
  });
});
