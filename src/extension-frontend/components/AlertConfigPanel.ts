import { post } from '../api';
import { UserConfig } from '../../extension-backend/domain/types';

export interface AlertConfigPanelHandle {
  update(config: UserConfig): void;
}

export function mountAlertConfigPanel(el: HTMLElement): AlertConfigPanelHandle {
  el.innerHTML = `
    <div class="wv-config-card">
      <button class="wv-btn" id="open-config-btn" title="Open Mallard's alert settings in the VS Code Settings editor">
        <i class="codicon codicon-edit"></i> Edit alert rules
      </button>
      <span id="rule-count" class="wv-rule-count"></span>
    </div>`;

  el.querySelector('#open-config-btn')!.addEventListener('click', () => {
    post({ type: 'openConfig' });
  });

  return {
    update(config: UserConfig) {
      // The alert rules are the flat rules of the `mallard.alerts.rules` setting.
      const n = config.flatRules?.length ?? 0;
      el.querySelector('#rule-count')!.textContent =
        n === 0 ? 'No rules configured' : `${n} rule${n === 1 ? '' : 's'} configured`;
    },
  };
}
