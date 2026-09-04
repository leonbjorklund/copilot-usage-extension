import * as vscode from 'vscode';

import type { CopilotAccountSource } from './copilotAccount';
import { fetchCopilotQuota, type CopilotQuota, type QuotaFetchResult } from './quota';

export type QuotaState =
  | { kind: 'idle' }
  /**
   * No session was available silently; the user has to grant access once.
   * `account` names the Copilot Chat login that access is needed for.
   */
  | { kind: 'needs-consent'; account?: string }
  | { kind: 'quota'; quota: CopilotQuota; account: string }
  /** Signed in, but there is no credit quota to show for this account. */
  | { kind: 'unavailable' };

/**
 * Copilot Chat signs in through this provider unless
 * `github.copilot.advanced.authProvider` points it at GitHub Enterprise Server,
 * which this extension does not support: the quota endpoint lives on
 * api.github.com. GitHub Enterprise Cloud accounts are github.com accounts.
 */
const AUTH_PROVIDER_ID = 'github';
/** Wait for Copilot to stop writing before asking GitHub for new numbers. */
const SETTLE_DELAY_MS = 10_000;
/**
 * Floor between requests. The endpoint costs one of the account's 5,000 hourly
 * REST calls, shared with every other tool using the same token, so a chat
 * burst must not turn into a burst of quota calls.
 */
const MIN_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export class CopilotQuotaService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private state: QuotaState = { kind: 'idle' };
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private inFlightInteractive = false;
  private lastFetchAt = 0;
  private disposed = false;
  private backoffUntil = 0;
  private backoffMs = DEFAULT_BACKOFF_MS;

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly copilotAccount: CopilotAccountSource) {
    this.disposables.push(
      this.changeEmitter,
      // Fires on sign-in, sign-out, and when this extension's preferred account
      // changes. The floor still applies, so a burst of token refreshes is one read.
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id !== AUTH_PROVIDER_ID) {
          return;
        }

        // A new token is the one thing that fixes a rejected one, so it does
        // not wait out that backoff.
        if (this.state.kind === 'needs-consent') {
          this.clearBackoff();
        }

        void this.refreshNow();
      }),
      copilotAccount.onDidChange(() => void this.followCopilotAccount()),
    );
  }

  /** Copilot switched account: re-read at once, after any read already running. */
  private async followCopilotAccount(): Promise<void> {
    await this.inFlight;
    const login = await this.copilotAccount.currentLogin();
    if (this.disposed || login === undefined) {
      return;
    }

    if (this.state.kind === 'quota' && this.state.account === login) {
      return;
    }

    // A switch is rare and the user's own doing, so it skips the floor.
    this.lastFetchAt = 0;
    void this.refreshNow();
  }

  getState(): QuotaState {
    return this.state;
  }

  /** Refresh once Copilot has stopped writing logs, at most once a minute. */
  scheduleRefresh(): void {
    if (this.disposed) {
      return;
    }

    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }

    // Wait out the floor and any backoff here, so the read is not dropped on
    // arrival and the timer does not have to poll.
    const readyAt = Math.max(this.backoffUntil, this.lastFetchAt + MIN_REFRESH_INTERVAL_MS);
    this.settleTimer = setTimeout(
      () => {
        this.settleTimer = undefined;
        void this.refreshNow();
      },
      Math.max(SETTLE_DELAY_MS, readyAt - Date.now()),
    );
  }

  /**
   * @param interactive The user clicked. Allows the consent dialog and the
   * account picker and skips the floor; a background refresh must stay silent.
   */
  async refreshNow(options: { interactive?: boolean } = {}): Promise<void> {
    if (this.disposed) {
      return;
    }

    const interactive = options.interactive === true;
    // A background read cannot raise the consent dialog, so a click waits for it
    // rather than being answered by it. Looping means a second click joins the
    // interactive run the first one started instead of opening its own dialog.
    while (this.inFlight) {
      if (!interactive || this.inFlightInteractive) {
        return this.inFlight;
      }

      await this.inFlight;
    }

    if (this.disposed) {
      return;
    }

    const now = Date.now();
    if (!interactive && (now < this.backoffUntil || now - this.lastFetchAt < MIN_REFRESH_INTERVAL_MS)) {
      // Defer rather than drop, or the row stays stale until the next log write
      // happens to land outside the window.
      this.scheduleRefresh();
      return;
    }

    this.inFlightInteractive = interactive;
    this.inFlight = this.run(interactive)
      // getSession throws while the GitHub provider is still registering at
      // startup, and when the user cancels the dialog. Nothing awaits a
      // background refresh, so this must not become an unhandled rejection.
      .catch(() => this.retryLater())
      .finally(() => {
        this.inFlight = undefined;
        this.inFlightInteractive = false;
      });
    return this.inFlight;
  }

  private async run(interactive: boolean): Promise<void> {
    this.lastFetchAt = Date.now();

    // Follow the account Copilot Chat reports. When it reports none that is
    // signed in here, VS Code falls back to the account this extension was
    // allowed for. The GitHub provider matches scopes as an exact set, so an
    // empty list is the only request that matches Copilot's own session.
    const account = await copilotAccountSignedInHere(this.copilotAccount);
    const target = account ? { account } : {};
    let session = await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], {
      silent: true,
      ...target,
    });
    if (
      interactive &&
      (!session || (!account && (this.state.kind !== 'quota' || (await hasSeveralAccounts()))))
    ) {
      // VS Code asks for consent to Copilot's account. Only when that account
      // is unknown does it show its picker instead, which also offers signing
      // in again; clearing the preference is what brings the picker back.
      session = await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], {
        createIfNone: true,
        ...(account ? target : { clearSessionPreference: true }),
      });
    }

    if (this.disposed) {
      return;
    }

    if (!session) {
      this.setState({ kind: 'needs-consent', account: account?.label });
      return;
    }

    const result = await fetchCopilotQuota({ token: session.accessToken });
    if (!this.disposed) {
      this.applyResult(result, session);
    }
  }

  private applyResult(result: QuotaFetchResult, session: vscode.AuthenticationSession): void {
    switch (result.kind) {
      case 'quota':
        this.clearBackoff();
        this.setState({ kind: 'quota', quota: result.quota, account: session.account.label });
        return;
      case 'no-quota':
        this.clearBackoff();
        this.setState({ kind: 'unavailable' });
        return;
      case 'unauthorized':
        // The token is stale. Keep a row so the state shows. The fix is a fresh
        // sign-in from the Accounts menu, which fires onDidChangeSessions and
        // clears this backoff; re-sending the same token on a timer buys nothing.
        this.setState({ kind: 'needs-consent', account: session.account.label });
        this.enterBackoff();
        return;
      case 'rate-limited':
        this.retryLater(result.retryAfterMs);
        return;
      case 'error':
        this.retryLater();
        return;
    }
  }

  private enterBackoff(retryAfterMs?: number): void {
    this.backoffUntil = Date.now() + (retryAfterMs ?? this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  /**
   * Back off, then retry on its own. With logging off there are no log writes
   * to trigger a read, and the row would otherwise stay missing all session.
   */
  private retryLater(retryAfterMs?: number): void {
    this.enterBackoff(retryAfterMs);
    this.scheduleRefresh();
  }

  private clearBackoff(): void {
    this.backoffUntil = 0;
    this.backoffMs = DEFAULT_BACKOFF_MS;
  }

  private setState(state: QuotaState): void {
    // Unchanged numbers must not redraw the tree once a minute.
    if (JSON.stringify(this.state) === JSON.stringify(state)) {
      return;
    }

    this.state = state;
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

async function hasSeveralAccounts(): Promise<boolean> {
  return (await vscode.authentication.getAccounts(AUTH_PROVIDER_ID)).length > 1;
}

async function copilotAccountSignedInHere(
  source: CopilotAccountSource,
): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
  const login = await source.currentLogin();
  if (login === undefined) {
    return undefined;
  }

  const accounts = await vscode.authentication.getAccounts(AUTH_PROVIDER_ID);
  return accounts.find((account) => account.label === login);
}
