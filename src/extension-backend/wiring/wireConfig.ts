/**
 * Wires user configuration and the things configured from it: the hand-editable
 * config.json store, the dashboard layout, and the GitHub billing session (its
 * `githubBilling` block is delivered at startup and kept live on every config
 * change — previously configure() was never called, so the whole user-level PAT
 * path was dead).
 */
import { GitHubSession } from '../billing/GitHubSession';
import { GitHubUsageService } from '../billing/GitHubUsageService';
import { LayoutStore } from '../app/LayoutStore';
import { UserConfigStore } from '../app/UserConfigStore';
import type { WiringScope } from './scope';

export interface ConfigWiring {
  userConfig: UserConfigStore;
  layout: LayoutStore;
  githubSession: GitHubSession;
  github: GitHubUsageService;
}

export function wireConfig(scope: WiringScope): ConfigWiring {
  const { context, storageDir, started } = scope;

  const githubSession = new GitHubSession(context.secrets);
  started.push(() => githubSession.dispose());
  const github = new GitHubUsageService(githubSession);
  const userConfig = new UserConfigStore(storageDir);
  started.push(() => userConfig.dispose());
  const layout = new LayoutStore(userConfig, context.globalState);
  started.push(() => layout.dispose());

  githubSession.configure(userConfig.get().githubBilling);
  context.subscriptions.push(
    userConfig.onDidChange((c) => githubSession.configure(c.githubBilling)),
  );

  return { userConfig, layout, githubSession, github };
}
