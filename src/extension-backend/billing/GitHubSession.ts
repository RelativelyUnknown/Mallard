import * as vscode from 'vscode';
import type { GitHubBillingConfig } from '../domain/types';
import type { IAuthProvider } from './IBillingProvider';
import { SECRET_KEYS } from '../app/credentials';
import { defaultLogger, Logger } from '../util/logger';

export class GitHubSession implements IAuthProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;
  private readonly _sub: vscode.Disposable;

  private billingConfig: GitHubBillingConfig | undefined;

  constructor(
    private readonly secrets?: vscode.SecretStorage,
    private readonly logger: Logger = defaultLogger,
  ) {
    this._sub = vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github') this._onDidChange.fire();
    });
  }

  /**
   * Update the billing config (`mallard.githubBilling.mode` / `.org`). Called at
   * startup and whenever either setting changes; invalidates the cache so
   * GitHubUsageService refetches for the new org instead of showing the old
   * one's data until the next timer tick.
   */
  configure(cfg: GitHubBillingConfig | undefined): void {
    this.billingConfig = cfg;
    this._onDidChange.fire();
  }

  /**
   * Returns a bearer token. Resolution order:
   * 1. PAT from SecretStorage (set via "Mallard: Set GitHub Personal Access Token")
   * 2. VS Code OAuth session — unless `mallard.githubBilling.mode` is "pat",
   *    which pins auth to the stored PAT and never falls through to OAuth.
   */
  async getToken(
    createIfNone = false,
    _scope?: vscode.WorkspaceFolder,
  ): Promise<{ token: string; username?: string } | undefined> {
    const stored = await this.secrets?.get(SECRET_KEYS.githubPat);
    if (stored) return { token: stored };

    if (this.billingConfig?.mode === 'pat') return undefined;

    const session = await this._getSession(createIfNone);
    if (!session) return undefined;
    return { token: session.accessToken, username: session.account.label };
  }

  async needsPat(): Promise<boolean> {
    if (this.billingConfig?.mode !== 'pat') return false;
    const stored = await this.secrets?.get(SECRET_KEYS.githubPat);
    return !stored;
  }

  /**
   * The org slug from `mallard.githubBilling.org`, a user-level setting (a
   * workspace cannot override it), so the same value applies to every folder.
   */
  getOrg(_scope?: vscode.WorkspaceFolder): string | undefined {
    return this.billingConfig?.org?.trim() || undefined;
  }

  /** Returns the current GitHub OAuth session, or undefined when not signed in. */
  async get(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    if (this.billingConfig?.mode === 'pat') return undefined;
    return this._getSession(createIfNone);
  }

  private async _getSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession('github', ['read:user'], {
        createIfNone,
        silent: !createIfNone,
      });
    } catch (err) {
      // Expected when the user dismisses the sign-in dialog; anything else is
      // still worth a trace instead of vanishing.
      this.logger.debug('github', 'getSession failed or was dismissed', err);
      return undefined;
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._sub.dispose();
  }
}
