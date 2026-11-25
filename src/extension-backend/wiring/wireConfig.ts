/**
 * Wires user configuration and the things configured from it: the settings-backed
 * `ConfigService` (the one source of budgets, alerts, display and export targets),
 * the one-time import of a pre-settings `config.json`, the dashboard layout, and
 * the GitHub billing session (its `githubBilling` settings are delivered at
 * startup and kept live on every change).
 */
import { GitHubSession } from '../billing/GitHubSession';
import { GitHubUsageService } from '../billing/GitHubUsageService';
import { ConfigService, watchValue } from '../app/ConfigService';
import { importLegacyConfig, ImportResult } from '../app/ConfigImporter';
import { LayoutStore } from '../app/LayoutStore';
import { readConfig } from '../config';
import type { PricingService } from '../pricing/PricingService';
import type { WiringScope } from './scope';

export interface ConfigWiring {
  userConfig: ConfigService;
  layout: LayoutStore;
  githubSession: GitHubSession;
  github: GitHubUsageService;
  /**
   * What the one-time `config.json` import did (`status: 'none'` when there was
   * nothing to import). Carries the old rules language for the alert stream to convert.
   */
  imported: ImportResult;
}

export interface ConfigWiringDeps {
  /** Receives a changed `mallard.pricingManifestUrl` live. */
  pricing: Pick<PricingService, 'setRemoteUrl'>;
  /** The import, injectable for tests. */
  importConfig?: typeof importLegacyConfig;
}

export async function wireConfig(scope: WiringScope, deps: ConfigWiringDeps): Promise<ConfigWiring> {
  const { context, storageDir, started } = scope;
  const { pricing, importConfig = importLegacyConfig } = deps;

  const githubSession = new GitHubSession(context.secrets);
  started.push(() => githubSession.dispose());
  const github = new GitHubUsageService(githubSession);
  const userConfig = new ConfigService();
  started.push(() => userConfig.dispose());

  // Before anything reads the config or the layout: the import writes settings
  // and may seed the layout key.
  const imported = await importConfig({
    storageDir,
    config: userConfig,
    state: context.globalState,
    secrets: context.secrets,
  });

  const layout = new LayoutStore(context.globalState);
  started.push(() => layout.dispose());

  githubSession.configure(userConfig.get().githubBilling);
  context.subscriptions.push(
    watchValue(userConfig.onDidChange, () => userConfig.get().githubBilling, (b) => githubSession.configure(b)),
    watchValue(userConfig.onDidChange, () => readConfig().pricingManifestUrl, (url) => pricing.setRemoteUrl(url)),
  );

  return { userConfig, layout, githubSession, github, imported };
}
