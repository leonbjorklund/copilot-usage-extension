import * as vscode from 'vscode';

import { fetchCopilotQuota, type CopilotQuota, type QuotaFetchResult } from './quota';

export type QuotaState =
  | { kind: 'idle' }
  /** No session was available silently; the user has to grant access once. */
  | { kind: 'needs-consent' }
  | { kind: 'quota'; quota: CopilotQuota; account: string }
  /** Signed in, but there is no credit quota to show for this account. */
  | { kind: 'unavailable' };

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
  /** GitHub rejected the cached token, so the next gesture must mint a new one. */
  private tokenRejected = false;

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly pluginVersion = '') {
    this.disposables.push(
      this.changeEmitter,
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id !== authProviderId()) {
          return;
        }

        // The event says only that something moved, so re-resolve. A new
        // token is worth retrying immediately; a rate limit or a network
        // failure is not, and the floor still applies either way.
        if (this.tokenRejected) {
          this.tokenRejected = false;
          this.clearBackoff();
        }

        void this.refreshNow();
      }),
    );
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

    // Waiting out the floor here rather than firing early keeps the read from
    // being dropped on arrival, which would leave the row stale until the next
    // log write happened to land outside the window.
    const readyAt = Math.max(this.backoffUntil, this.lastFetchAt + MIN_REFRESH_INTERVAL_MS);
    const delay = Math.max(SETTLE_DELAY_MS, readyAt - Date.now());

    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      void this.refreshNow();
    }, delay);
  }

  /**
   * @param interactive Allow the one-time access prompt. Only ever pass true
   * from a user gesture; a background refresh must stay silent.
   */
  async refreshNow(options: { interactive?: boolean } = {}): Promise<void> {
    if (this.disposed) {
      return;
    }

    const interactive = options.interactive === true;
    // A background read cannot raise the consent dialog, so a click waits for it
    // rather than being answered by it. Looping means the second click joins the
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

    // Only a user gesture may jump the queue; every automatic caller waits.
    const now = Date.now();
    if (!interactive && (now < this.backoffUntil || now - this.lastFetchAt < MIN_REFRESH_INTERVAL_MS)) {
      // Try again once the wait is over, or the numbers stay stale until the
      // next log write happens to land outside the window.
      this.scheduleRefresh();
      return;
    }

    // Nothing awaits a background refresh, so a failure here must not surface
    // as an unhandled rejection in the extension host.
    this.inFlightInteractive = interactive;
    this.inFlight = this.run(interactive)
      .catch(() => this.enterBackoff())
      .finally(() => {
        this.inFlight = undefined;
        this.inFlightInteractive = false;
      });
    return this.inFlight;
  }

  private async run(interactive: boolean): Promise<void> {
    this.lastFetchAt = Date.now();

    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await getGitHubSession(interactive, this.tokenRejected);
    } catch {
      // The GitHub provider can still be registering at startup. Leave the row
      // as it is and retry later rather than telling the user to grant access
      // they have already granted.
      this.enterBackoff();
      return;
    }

    if (!session) {
      this.setState({ kind: 'needs-consent' });
      return;
    }

    const result = await fetchCopilotQuota({
      token: session.accessToken,
      editorVersion: `vscode/${vscode.version}`,
      pluginVersion: this.pluginVersion ? `copilot-token-cost/${this.pluginVersion}` : undefined,
    });

    this.applyResult(result, session);
  }

  private applyResult(result: QuotaFetchResult, session: vscode.AuthenticationSession): void {
    switch (result.kind) {
      case 'quota':
        this.tokenRejected = false;
        this.clearBackoff();
        this.setState({
          kind: 'quota',
          quota: result.quota,
          account: session.account.label,
        });
        return;
      case 'no-quota':
        this.tokenRejected = false;
        this.clearBackoff();
        this.setState({ kind: 'unavailable' });
        return;
      case 'unauthorized':
        // The cached token is stale, and only a user gesture can mint a new
        // one. Keep a row in the tree so re-granting is one click away instead
        // of the quota silently disappearing.
        this.tokenRejected = true;
        this.setState({ kind: 'needs-consent' });
        this.enterBackoff();
        return;
      case 'rate-limited':
        this.enterBackoff(result.retryAfterMs);
        return;
      case 'error':
        this.enterBackoff();
        return;
    }
  }

  private enterBackoff(retryAfterMs?: number): void {
    const delay = retryAfterMs ?? this.backoffMs;
    this.backoffUntil = Date.now() + delay;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private clearBackoff(): void {
    this.backoffUntil = 0;
    this.backoffMs = DEFAULT_BACKOFF_MS;
  }

  private setState(state: QuotaState): void {
    // Unchanged numbers must not redraw the tree once a minute. Comparing every
    // field means no addition to the row can slip past unnoticed.
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

function authProviderId(): string {
  const configured = vscode.workspace
    .getConfiguration()
    .get<string>('github.copilot.advanced.authProvider');
  if (configured === 'github-enterprise' || configured === 'github') {
    return configured;
  }

  const enterpriseUri = vscode.workspace.getConfiguration().get<string>('github-enterprise.uri');
  return enterpriseUri && enterpriseUri.trim().length > 0 ? 'github-enterprise' : 'github';
}

async function getGitHubSession(
  interactive: boolean,
  tokenRejected: boolean,
): Promise<vscode.AuthenticationSession | undefined> {
  const providerId = authProviderId();
  // The GitHub provider matches scopes as an exact set, so an empty list is
  // the only request that matches whatever session Copilot already established.
  const session = await vscode.authentication.getSession(providerId, [], { silent: true });
  if (!interactive || (session && !tokenRejected)) {
    return session;
  }

  // Only reached from a user gesture. With no session this is a consent
  // dialog for the one Copilot already holds; after GitHub rejected that
  // token, replacing it is the only way back and needs a real sign-in.
  return await vscode.authentication.getSession(
    providerId,
    [],
    tokenRejected ? { forceNewSession: true } : { createIfNone: true },
  );
}
