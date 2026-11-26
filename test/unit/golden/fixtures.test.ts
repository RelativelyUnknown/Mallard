import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { FIXTURES_DIR, fixtureTextFiles } from '../../golden/generate-fixtures';

/**
 * The committed golden fixtures are generated (test/golden/generate-fixtures.ts).
 * Keep them honest: any hand edit, or a generator change that was not
 * regenerated, fails here instead of silently moving every recording.
 */
describe('golden fixtures', () => {
  it('match what the generator produces, byte for byte', async () => {
    for (const [rel, text] of fixtureTextFiles()) {
      const onDisk = await fs.readFile(path.join(FIXTURES_DIR, rel), 'utf8');
      assert.equal(onDisk, text, `${rel} differs from the generator output; run: npx tsx test/golden/generate-fixtures.ts`);
    }
  });

  it('has no files the generator does not know about', async () => {
    const known = new Set([...fixtureTextFiles().keys(), 'copilot/spans.db']);
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else found.push(path.relative(FIXTURES_DIR, full).split(path.sep).join('/'));
      }
    };
    await walk(FIXTURES_DIR);
    assert.deepEqual(found.filter((f) => !known.has(f)), []);
  });

  it('ships the span DB as a real SQLite file', async () => {
    const head = (await fs.readFile(path.join(FIXTURES_DIR, 'copilot', 'spans.db'))).subarray(0, 16).toString('latin1');
    assert.equal(head, 'SQLite format 3\u0000');
  });

  it('keeps every JSON fixture parseable except the deliberately broken lines', () => {
    const bad: string[] = [];
    for (const [rel, text] of fixtureTextFiles()) {
      if (rel.endsWith('.json')) {
        JSON.parse(text);
        continue;
      }
      for (const [i, line] of text.split('\n').entries()) {
        if (!line) continue;
        try {
          JSON.parse(line);
        } catch {
          bad.push(`${rel}:${i + 1}`);
        }
      }
    }
    // One garbage line, and the two truncated tails (cut mid-write, completed by the second pass).
    assert.equal(bad.length, 3, bad.join(', '));
    assert.ok(bad.some((b) => b.startsWith('claude/-work-alpha/')), 'garbage line');
    assert.ok(bad.some((b) => b.startsWith('claude/-work-beta/')), 'truncated tail in pass 1');
    assert.ok(bad.some((b) => b.startsWith('claude-pass2/-work-beta/')), 'its continuation in pass 2');
  });
});
