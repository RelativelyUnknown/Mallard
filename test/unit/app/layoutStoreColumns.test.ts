import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LayoutStore } from '../../../src/extension-backend/app/LayoutStore';
import { UserConfigStore } from '../../../src/extension-backend/app/UserConfigStore';

describe('LayoutStore — dashboard.columns', () => {
  async function setup(dashboard: unknown) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-layout-cols-'));
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ dashboard }), 'utf8');
    const userConfig = new UserConfigStore(dir);
    return { userConfig, layout: new LayoutStore(userConfig) };
  }

  it('clamps panel spans to the configured column count', async () => {
    const { userConfig, layout } = await setup({
      columns: 2,
      panels: [{ id: 'daily', gridColumn: 'span 4' }],
    });
    assert.equal(layout.get().find((p) => p.id === 'daily')?.span, 2, 'span 4 in a 2-column grid');
    layout.dispose();
    userConfig.dispose();
  });

  it('allows the full width when no column count is configured', async () => {
    const { userConfig, layout } = await setup({ panels: [{ id: 'daily', gridColumn: 'span 4' }] });
    assert.equal(layout.get().find((p) => p.id === 'daily')?.span, 4);
    layout.dispose();
    userConfig.dispose();
  });
});
