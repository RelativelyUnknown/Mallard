import { strict as assert } from 'assert';
import { LayoutStore } from '../../../src/extension-backend/app/LayoutStore';
import type { ConfigDashboard } from '../../../src/extension-backend/domain/types';
import { makeFakeConfig, makeMemento } from '../helpers';

describe('LayoutStore — dashboard.columns', () => {
  async function setup(dashboard: ConfigDashboard) {
    const userConfig = makeFakeConfig({ dashboard });
    return { userConfig, layout: new LayoutStore(userConfig, makeMemento()) };
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
