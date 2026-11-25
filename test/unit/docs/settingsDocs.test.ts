/**
 * docs/reference/settings.md is generated from the settings table
 * (scripts/gen-settings-docs.ts); this test is the CI check that it has not
 * drifted (the same as `bun run docs:settings:check`).
 */
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { renderGroup, renderSettingsDoc, SETTINGS_DOC } from '../../../scripts/gen-settings-docs';
import { SETTING_ENTRIES, SettingDef } from '../../../src/extension-backend/config/settings';

const doc = readFileSync(SETTINGS_DOC, 'utf8');

describe('docs/reference/settings.md', () => {
  it('is up to date with the settings table (run `bun run docs:settings` after changing it)', () => {
    assert.equal(renderSettingsDoc(doc), doc);
  });

  it('documents every setting, each in the block of its own group', () => {
    const groups = [...new Set(SETTING_ENTRIES.map(([, d]) => d.group))];
    for (const group of groups) {
      const begin = doc.indexOf(`<!-- BEGIN settings:${group} -->\n`);
      const end = doc.indexOf(`<!-- END settings:${group} -->`);
      assert.ok(begin >= 0 && end > begin, `no generated block for "${group}"`);
      const block = doc.slice(begin, end);
      for (const [key, def] of SETTING_ENTRIES) {
        assert.equal(block.includes(`| \`${key}\` |`), def.group === group, `${key} in "${group}"`);
      }
    }
  });
});

describe('renderGroup / renderSettingsDoc', () => {
  const def = (over: Partial<SettingDef<unknown>>): SettingDef<unknown> => ({
    type: 'string', default: '', scope: 'machine', description: 'd', group: 'Dashboard', sanitize: (r) => r, ...over,
  });
  const entries: Array<readonly [string, SettingDef<unknown>]> = [
    ['mallard.num', def({ type: 'number', default: 10, minimum: 1, maximum: 60, scope: 'application', description: 'A | pipe\nand a newline' })],
    ['mallard.int', def({ type: 'integer', default: 3, minimum: 1, maximum: 9, reload: true })],
    ['mallard.free', def({ type: 'number', default: 0 })],
    ['mallard.pick', def({ enum: ['a', 'b'], default: 'a' })],
    ['mallard.list', def({ type: 'array', default: ['x'], items: { type: 'string', enum: ['x', 'y'] } })],
    ['mallard.objs', def({ type: 'array', default: [], items: { type: 'object' } })],
    ['mallard.map', def({ type: 'object', default: {} })],
    ['mallard.other', def({ group: 'Metric export' })],
  ];

  it('renders type, range, default, scope and description, escaping table syntax', () => {
    const lines = renderGroup('Dashboard', entries).split('\n');
    assert.equal(lines[0], '| Setting | Type | Default | Scope | Description |');
    const byKey = (key: string) => lines.find((l) => l.startsWith(`| \`${key}\` |`));
    assert.equal(byKey('mallard.num'), '| `mallard.num` | `number`, 1–60 | `10` | `application` | A \\| pipe and a newline |');
    assert.match(byKey('mallard.int')!, /^\| `mallard.int` \| `integer`, 1–9 \| `3` \| `machine` \| d Applies after a window reload\. \|$/);
    assert.match(byKey('mallard.free')!, /\| `number` \|/, 'no range, no range text');
    assert.match(byKey('mallard.pick')!, /\| `"a" \\\| "b"` \| `"a"` \|/);
    assert.match(byKey('mallard.list')!, /\| `\("x" \\\| "y"\)\[\]` \| `\["x"\]` \|/);
    assert.match(byKey('mallard.objs')!, /\| `object\[\]` \| `\[\]` \|/);
    assert.match(byKey('mallard.map')!, /\| `object` \| `\{\}` \|/);
    assert.equal(byKey('mallard.other'), undefined, 'only the requested group');
  });

  it('replaces every generated block and nothing else', () => {
    const src = 'intro\n<!-- BEGIN settings:Dashboard -->\nstale\n<!-- END settings:Dashboard -->\nmiddle\n<!-- BEGIN settings:Metric export -->\n<!-- END settings:Metric export -->\nouttro\n';
    const out = renderSettingsDoc(src, entries);
    assert.ok(out.startsWith('intro\n<!-- BEGIN settings:Dashboard -->\n| Setting |'));
    assert.ok(!out.includes('stale'));
    assert.ok(out.includes('\nmiddle\n<!-- BEGIN settings:Metric export -->\n| Setting |'));
    assert.ok(out.endsWith('<!-- END settings:Metric export -->\nouttro\n'));
    assert.equal(renderSettingsDoc(out, entries), out, 'idempotent');
    assert.equal(renderSettingsDoc('no markers here', entries), 'no markers here');
  });
});
