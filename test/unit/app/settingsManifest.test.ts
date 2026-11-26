/**
 * Table-vs-manifest guard (replaces the old config.json schema drift test):
 * `src/extension-backend/config/settings.ts` is the one definition of every
 * `mallard.*` setting, and `package.json` `contributes.configuration` must say
 * the same thing about keys, defaults, ranges, enums, scopes and descriptions —
 * VS Code shows the manifest, the extension enforces the table.
 */
import { strict as assert } from 'assert';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { SETTING_ENTRIES } from '../../../src/extension-backend/config/settings';
import { manifestProperties, manifestProperty } from '../config/manifestProperty';

interface Manifest {
  capabilities: { untrustedWorkspaces: { restrictedConfigurations?: string[] } };
  contributes: { configuration: Parameters<typeof manifestProperties>[0]; jsonValidation?: unknown };
}
const root = path.join(__dirname, '../../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const props = manifestProperties(pkg.contributes.configuration);

/** Scopes under which a workspace's own settings.json can set the value. */
const WORKSPACE_SETTABLE = ['machine-overridable', 'window', 'resource', 'language-overridable'];

describe('package.json contributes.configuration matches the settings table', () => {
  it('contributes exactly the table\'s keys, nothing more and nothing less', () => {
    assert.deepEqual(Object.keys(props).sort(), SETTING_ENTRIES.map(([k]) => k).sort());
  });

  for (const [key, def] of SETTING_ENTRIES) {
    it(`${key}: type, default, range, enum, scope and description agree`, () => {
      const p = props[key]!;
      assert.equal(p['type'], def.type, 'type');
      assert.deepEqual(p['default'], def.default, 'default');
      assert.equal(p['minimum'], def.minimum, 'minimum');
      assert.equal(p['maximum'], def.maximum, 'maximum');
      assert.deepEqual(p['enum'], def.enum, 'enum');
      assert.equal(p['scope'], def.scope, 'scope');
      assert.equal(p['description'], def.description, 'description');
      assert.deepEqual(p, manifestProperty(def), 'every other part of the property (items, pattern, enumDescriptions…)');
    });
  }

  it('gives every contributed setting an explicit scope (the implicit one, window, lets a workspace override it)', () => {
    for (const [key, p] of Object.entries(props)) assert.ok(p['scope'], `${key} has no scope`);
  });

  it('lists in restrictedConfigurations exactly the settings a workspace could set', () => {
    const expected = SETTING_ENTRIES.filter(([, d]) => WORKSPACE_SETTABLE.includes(d.scope)).map(([k]) => k).sort();
    assert.deepEqual([...(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations ?? [])].sort(), expected);
  });

  it('no longer associates a JSON schema with config.json', () => {
    assert.equal(pkg.contributes.jsonValidation, undefined);
    assert.ok(!existsSync(path.join(root, 'schemas', 'mallard-config.schema.json')));
  });
});

describe('manifestProperties', () => {
  const a = { 'mallard.a': { type: 'string' } };
  const b = { 'mallard.b': { type: 'number' } };

  it('reads the single-object form', () => {
    assert.deepEqual(manifestProperties({ properties: a }), a);
  });

  it('reads the array form, merging every block', () => {
    assert.deepEqual(manifestProperties([{ properties: a }, { properties: b }, {}]), { ...a, ...b });
  });

  it('is empty when nothing is contributed', () => {
    assert.deepEqual(manifestProperties(undefined), {});
    assert.deepEqual(manifestProperties({}), {});
  });
});
