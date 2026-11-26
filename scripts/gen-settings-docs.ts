/**
 * Regenerates the settings tables in docs/reference/settings.md from the one
 * settings table (src/extension-backend/config/settings.ts), so the reference
 * cannot drift from what the extension actually accepts.
 *
 *   bun run docs:settings          rewrite the generated blocks in place
 *   bun run docs:settings:check    exit 1 if the file is out of date (CI)
 *
 * Only the text between `<!-- BEGIN settings:<group> -->` and
 * `<!-- END settings:<group> -->` is generated; everything around it is prose.
 * test/unit/docs/settingsDocs.test.ts runs the same check in the unit suite.
 */
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { SETTING_ENTRIES, SettingDef, SettingGroup } from '../src/extension-backend/config/settings';

export const SETTINGS_DOC = path.join(__dirname, '..', 'docs', 'reference', 'settings.md');

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const quoted = (values: readonly string[]): string => values.map((v) => JSON.stringify(v)).join(' | ');

function typeCell(def: SettingDef<unknown>): string {
  if (def.enum) return `\`${cell(quoted(def.enum))}\``;
  const itemEnum = (def.items as { enum?: string[] } | undefined)?.enum;
  if (def.type === 'array') return itemEnum ? `\`(${cell(quoted(itemEnum))})[]\`` : '`object[]`';
  if (def.type === 'object') return '`object`';
  const range = def.minimum !== undefined && def.maximum !== undefined ? `, ${def.minimum}–${def.maximum}` : '';
  return `\`${def.type}\`${range}`;
}

function row(key: string, def: SettingDef<unknown>): string {
  const reload = def.reload ? ' Applies after a window reload.' : '';
  return `| \`${key}\` | ${typeCell(def)} | \`${cell(JSON.stringify(def.default))}\` | \`${def.scope}\` | ${cell(def.description)}${reload} |`;
}

/** The table for one group of settings. */
export function renderGroup(group: SettingGroup, entries: ReadonlyArray<readonly [string, SettingDef<unknown>]> = SETTING_ENTRIES): string {
  const rows = entries.filter(([, def]) => def.group === group).map(([key, def]) => row(key, def));
  return ['| Setting | Type | Default | Scope | Description |', '|---------|------|---------|-------|-------------|', ...rows].join('\n');
}

const BLOCK = /(<!-- BEGIN settings:([^>]+?) -->\n)[\s\S]*?(<!-- END settings:\2 -->)/g;

/** `doc` with every generated block replaced by the current table. */
export function renderSettingsDoc(doc: string, entries: ReadonlyArray<readonly [string, SettingDef<unknown>]> = SETTING_ENTRIES): string {
  return doc.replace(BLOCK, (_all, begin: string, group: string, end: string) => `${begin}${renderGroup(group as SettingGroup, entries)}\n${end}`);
}

function main(argv: string[]): number {
  const current = readFileSync(SETTINGS_DOC, 'utf8');
  const next = renderSettingsDoc(current);
  if (argv.includes('--check')) {
    if (next === current) return 0;
    console.error('docs/reference/settings.md is out of date with config/settings.ts: run `bun run docs:settings`.');
    return 1;
  }
  writeFileSync(SETTINGS_DOC, next);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
