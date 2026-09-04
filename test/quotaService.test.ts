import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CopilotQuota, QuotaFetchResult } from '../src/core/quota';

const { fetchCopilotQuota, auth } = vi.hoisted(() => ({
  fetchCopilotQuota: vi.fn(),
  auth: {
    getSession: vi.fn(),
    getAccounts: vi.fn(),
    sessionChangeHandlers: [] as Array<(event: { provider: { id: string } }) => void>,
  },
}));

vi.mock('../src/core/quota', () => ({ fetchCopilotQuota }));

vi.mock('vscode', () => ({
  EventEmitter: class {
    private readonly listeners: Array<() => void> = [];

    readonly event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };

    fire(): void {
      for (const listener of [...this.listeners]) {
        listener();
      }
    }

    dispose(): void {
      this.listeners.length = 0;
    }
  },
  authentication: {
    getSession: auth.getSession,
    getAccounts: auth.getAccounts,
    onDidChangeSessions: (handler: (event: { provider: { id: string } }) => void) => {
      auth.sessionChangeHandlers.push(handler);
      return { dispose: () => undefined };
    },
  },
}));

const { CopilotQuotaService } = await import('../src/core/quotaService');

/** What Copilot Chat's log says, as the watcher would report it. */
const copilot = { login: undefined as string | undefined, changeHandlers: [] as Array<() => void> };

function createService() {
  return new CopilotQuotaService({
    onDidChange: (handler: () => void) => {
      copilot.changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    currentLogin: async () => copilot.login,
    dispose: () => undefined,
  });
}

function copilotSwitchedTo(login: string) {
  copilot.login = login;
  for (const handler of copilot.changeHandlers) {
    handler();
  }
}

const SETTLE_DELAY_MS = 10_000;
const MIN_REFRESH_INTERVAL_MS = 60_000;
const PICKER = { createIfNone: true, clearSessionPreference: true };

function quota(overrides: Partial<CopilotQuota> = {}): CopilotQuota {
  return {
    entitlement: 1500,
    remaining: 1317,
    percentRemaining: 87.8,
    unlimited: false,
    overageCount: 0,
    ...overrides,
  };
}

function account(label = 'octocat') {
  return { id: `acct-${label}`, label };
}

function session(label = 'octocat') {
  return { accessToken: 'gho_test', account: account(label) };
}

function resolvesTo(result: QuotaFetchResult) {
  fetchCopilotQuota.mockResolvedValue(result);
}

/** Arguments of the most recent `getSession` call. */
function lastGetSessionCall() {
  return auth.getSession.mock.calls.at(-1) as [string, string[], Record<string, unknown>];
}

function fireSessionChange(providerId: string) {
  for (const handler of auth.sessionChangeHandlers) {
    handler({ provider: { id: providerId } });
  }
}

describe('CopilotQuotaService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchCopilotQuota.mockReset();
    auth.getSession.mockReset();
    auth.getAccounts.mockReset();
    auth.sessionChangeHandlers.length = 0;
    copilot.login = undefined;
    copilot.changeHandlers.length = 0;
    auth.getSession.mockResolvedValue(session());
    auth.getAccounts.mockResolvedValue([account()]);
    resolvesTo({ kind: 'quota', quota: quota() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the quota with a silent session and publishes it', async () => {
    const service = createService();
    const changes = vi.fn();
    service.onDidChange(changes);

    await service.refreshNow();

    const [providerId, scopes, options] = lastGetSessionCall();
    expect(providerId).toBe('github');
    expect(scopes).toEqual([]);
    expect(options).toEqual({ silent: true });
    expect(auth.getSession).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({ kind: 'quota', quota: quota(), account: 'octocat' });
    expect(changes).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('never asks to create a session on a background refresh', async () => {
    auth.getSession.mockResolvedValue(undefined);
    const service = createService();

    await service.refreshNow();

    expect(auth.getSession).toHaveBeenCalledTimes(1);
    expect(lastGetSessionCall()[2]).toEqual({ silent: true });
    expect(fetchCopilotQuota).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ kind: 'needs-consent' });
    service.dispose();
  });

  it('falls back to the consent prompt only for a user gesture', async () => {
    auth.getSession.mockResolvedValueOnce(undefined).mockResolvedValueOnce(session());
    const service = createService();

    await service.refreshNow({ interactive: true });

    expect(auth.getSession).toHaveBeenCalledTimes(2);
    expect(auth.getSession.mock.calls[0][2]).toEqual({ silent: true });
    expect(auth.getSession.mock.calls[1][2]).toEqual(PICKER);
    expect(service.getState()).toMatchObject({ kind: 'quota' });
    service.dispose();
  });

  it('lets a click choose the account when more than one is signed in', async () => {
    const service = createService();
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ account: 'octocat' });

    // Copilot may have been switched to the other account; only the user can
    // tell this row to follow, and clearing the preference is what makes VS
    // Code show its account picker again.
    auth.getAccounts.mockResolvedValue([account('octocat'), account('hubot')]);
    auth.getSession.mockResolvedValueOnce(session('octocat')).mockResolvedValueOnce(session('hubot'));
    await service.refreshNow({ interactive: true });

    expect(lastGetSessionCall()[2]).toEqual(PICKER);
    expect(service.getState()).toMatchObject({ account: 'hubot' });

    // With one account there is nothing to pick, so a click is a plain re-read.
    auth.getAccounts.mockResolvedValue([account('hubot')]);
    auth.getSession.mockResolvedValue(session('hubot'));
    await service.refreshNow({ interactive: true });

    expect(lastGetSessionCall()[2]).toEqual({ silent: true });
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it('follows the account Copilot Chat reports', async () => {
    copilot.login = 'hubot';
    auth.getAccounts.mockResolvedValue([account('octocat'), account('hubot')]);
    auth.getSession.mockResolvedValue(session('hubot'));
    const service = createService();

    await service.refreshNow();

    expect(lastGetSessionCall()[2]).toEqual({ silent: true, account: account('hubot') });
    expect(service.getState()).toMatchObject({ account: 'hubot' });
    service.dispose();
  });

  it('re-reads at once when Copilot switches account', async () => {
    auth.getAccounts.mockResolvedValue([account('octocat'), account('hubot')]);
    copilot.login = 'octocat';
    const service = createService();
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ account: 'octocat' });

    auth.getSession.mockResolvedValue(session('hubot'));
    copilotSwitchedTo('hubot');
    await vi.advanceTimersByTimeAsync(0);

    // A switch is rare and the user's own doing, so it skips the floor.
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    expect(lastGetSessionCall()[2]).toEqual({ silent: true, account: account('hubot') });
    expect(service.getState()).toMatchObject({ account: 'hubot' });

    // Copilot logging the same account again is not a switch.
    copilotSwitchedTo('hubot');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('applies a switch that lands while a read is running', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined;
    auth.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    );
    auth.getAccounts.mockResolvedValue([account('octocat'), account('hubot')]);
    copilot.login = 'octocat';
    const service = createService();
    const first = service.refreshNow();

    auth.getSession.mockResolvedValue(session('hubot'));
    copilotSwitchedTo('hubot');
    releaseFirst(session('octocat'));
    await first;
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    expect(lastGetSessionCall()[2]).toEqual({ silent: true, account: account('hubot') });
    expect(service.getState()).toMatchObject({ account: 'hubot' });
    service.dispose();
  });

  it('falls back to the allowed account when Copilot reports one not signed in here', async () => {
    copilot.login = 'ghost';
    const service = createService();

    await service.refreshNow();

    expect(lastGetSessionCall()[2]).toEqual({ silent: true });
    expect(service.getState()).toMatchObject({ account: 'octocat' });
    service.dispose();
  });

  it('names the account Copilot uses on the consent row', async () => {
    copilot.login = 'hubot';
    auth.getAccounts.mockResolvedValue([account('octocat'), account('hubot')]);
    auth.getSession.mockResolvedValue(undefined);
    const service = createService();

    await service.refreshNow();

    expect(service.getState()).toEqual({ kind: 'needs-consent', account: 'hubot' });
    service.dispose();
  });

  it('asks for access to the account Copilot uses on a click, without the picker', async () => {
    copilot.login = 'hubot';
    auth.getAccounts.mockResolvedValue([account('octocat'), account('hubot')]);
    auth.getSession.mockResolvedValueOnce(undefined).mockResolvedValueOnce(session('hubot'));
    const service = createService();

    await service.refreshNow({ interactive: true });

    expect(lastGetSessionCall()[2]).toEqual({ createIfNone: true, account: account('hubot') });
    expect(service.getState()).toMatchObject({ account: 'hubot' });
    service.dispose();
  });

  it('holds background refreshes to one a minute but lets a gesture through', async () => {
    const service = createService();

    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS - 1);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    await service.refreshNow({ interactive: true });
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it('backs off further after each failure instead of retrying every minute', async () => {
    resolvesTo({ kind: 'error' });
    const service = createService();

    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    // The first backoff is the same minute as the plain floor, so this retries.
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);

    // The second failure doubles the wait, so a minute is no longer enough.
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it('backs off after a rejected token without retrying it on a timer', async () => {
    resolvesTo({ kind: 'unauthorized' });
    const service = createService();

    await service.refreshNow();
    // Only a fresh sign-in fixes a rejected token, so no retry is scheduled.
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('clears the backoff once a read succeeds', async () => {
    resolvesTo({ kind: 'error' });
    const service = createService();
    await service.refreshNow();
    // A click ignores the wait, so the second failure doubles the backoff past
    // the floor while the clock has not moved.
    await service.refreshNow({ interactive: true });

    resolvesTo({ kind: 'quota', quota: quota() });
    await service.refreshNow({ interactive: true });
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(3);

    // Without the reset the two-minute backoff would still be blocking here.
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(4);
    service.dispose();
  });

  it('honours the retry delay the endpoint reports when rate limited', async () => {
    resolvesTo({ kind: 'rate-limited', retryAfterMs: 5 * 60_000 });
    const service = createService();

    await service.refreshNow();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('keeps a clickable row when the cached token is rejected', async () => {
    resolvesTo({ kind: 'unauthorized' });
    const service = createService();

    await service.refreshNow();

    expect(service.getState()).toEqual({ kind: 'needs-consent', account: 'octocat' });
    service.dispose();
  });

  it('offers the account picker on a click after a rejected token when no Copilot login is known', async () => {
    resolvesTo({ kind: 'unauthorized' });
    const service = createService();
    await service.refreshNow();

    // A silent session still exists; it is the token behind it that GitHub
    // refused. The picker is where the user can sign in again.
    resolvesTo({ kind: 'quota', quota: quota() });
    await service.refreshNow({ interactive: true });

    expect(lastGetSessionCall()[2]).toEqual(PICKER);
    expect(service.getState()).toMatchObject({ kind: 'quota' });

    // Once a read succeeds a click with one account is a plain re-read.
    await service.refreshNow({ interactive: true });
    expect(lastGetSessionCall()[2]).toEqual({ silent: true });
    service.dispose();
  });

  it('redraws when only the overage or reset date moves', async () => {
    const service = createService();
    const changes = vi.fn();
    service.onDidChange(changes);

    resolvesTo({ kind: 'quota', quota: quota({ remaining: 0, percentRemaining: 0 }) });
    await service.refreshNow();
    expect(changes).toHaveBeenCalledTimes(1);

    resolvesTo({
      kind: 'quota',
      quota: quota({ remaining: 0, percentRemaining: 0, overageCount: 12 }),
    });
    await service.refreshNow({ interactive: true });
    expect(changes).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('does not leak a rejection when a background refresh throws', async () => {
    auth.getSession.mockRejectedValue(new Error('provider exploded'));
    const service = createService();

    await expect(service.refreshNow()).resolves.toBeUndefined();
    service.dispose();
  });

  it('reports an account without credits as unavailable', async () => {
    resolvesTo({ kind: 'no-quota' });
    const service = createService();

    await service.refreshNow();

    expect(service.getState()).toEqual({ kind: 'unavailable' });
    service.dispose();
  });

  it('refetches when the GitHub account changes, ignoring other providers', async () => {
    const service = createService();
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);

    fireSessionChange('microsoft');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    auth.getSession.mockResolvedValue(session('hubot'));
    fireSessionChange('github');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    expect(service.getState()).toMatchObject({ account: 'hubot' });

    // A burst of token-refresh events must not become a burst of requests, so
    // the reread waits out the floor rather than skipping it.
    fireSessionChange('github');
    fireSessionChange('github');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it('keeps an active rate-limit backoff when the account changes', async () => {
    resolvesTo({ kind: 'rate-limited', retryAfterMs: 5 * MIN_REFRESH_INTERVAL_MS });
    const service = createService();
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    for (let event = 0; event < 4; event += 1) {
      fireSessionChange('github');
      await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);
    }

    // GitHub asked for five minutes of silence, so four events inside that
    // window must not put a single extra request on the wire.
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('waits for log writes to settle and collapses a burst into one read', async () => {
    const service = createService();

    service.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1);
    expect(fetchCopilotQuota).not.toHaveBeenCalled();

    // A later write restarts the settle window rather than adding a request.
    service.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1);
    expect(fetchCopilotQuota).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('does not redraw the tree when the numbers have not moved', async () => {
    const service = createService();
    const changes = vi.fn();
    service.onDidChange(changes);

    await service.refreshNow();
    expect(changes).toHaveBeenCalledTimes(1);

    await service.refreshNow({ interactive: true });
    expect(changes).toHaveBeenCalledTimes(1);

    resolvesTo({ kind: 'quota', quota: quota({ remaining: 1200 }) });
    await service.refreshNow({ interactive: true });
    expect(changes).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('waits out the rate floor instead of dropping the read on arrival', async () => {
    const service = createService();
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    // A chat 15 seconds later settles inside the floor, so the read has to be
    // held rather than discarded or the row stays stale all session.
    vi.advanceTimersByTime(15_000);
    service.scheduleRefresh();

    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('leaves the row alone when the auth provider is not ready yet', async () => {
    auth.getSession.mockRejectedValue(new Error('no provider registered'));
    const service = createService();

    await service.refreshNow();

    // Claiming consent is needed would be a lie; the user already granted it.
    expect(service.getState()).toEqual({ kind: 'idle' });

    // The failure backs off, then the row recovers with no help from a log
    // write or a click, which with logging off would never come.
    auth.getSession.mockResolvedValue(session());
    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS - 1);
    expect(fetchCopilotQuota).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(service.getState()).toMatchObject({ kind: 'quota' });
    expect(vi.getTimerCount()).toBe(0);
    service.dispose();
  });

  it('retries on its own once the backoff has passed', async () => {
    resolvesTo({ kind: 'error' });
    const service = createService();
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    resolvesTo({ kind: 'quota', quota: quota() });
    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS - 1);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    expect(service.getState()).toMatchObject({ kind: 'quota' });
    // A success schedules nothing; only log writes and clicks read again.
    expect(vi.getTimerCount()).toBe(0);
    service.dispose();
  });

  it('lets a new sign-in through a rejected-token backoff', async () => {
    resolvesTo({ kind: 'unauthorized' });
    const service = createService();
    await service.refreshNow();
    // A log write a minute later re-sends it once, which doubles the backoff
    // to two minutes.
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);

    // Signing in again from the Accounts menu is the fix for a rejected
    // token, so it waits out the floor only.
    resolvesTo({ kind: 'quota', quota: quota() });
    fireSessionChange('github');
    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);

    expect(fetchCopilotQuota).toHaveBeenCalledTimes(3);
    expect(service.getState()).toMatchObject({ kind: 'quota' });
    service.dispose();
  });

  it('coalesces two background refreshes into one read', async () => {
    const service = createService();

    await Promise.all([service.refreshNow(), service.refreshNow()]);

    expect(auth.getSession).toHaveBeenCalledTimes(1);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('resolves when the user cancels the picker', async () => {
    auth.getSession
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('User did not consent to login.'));
    const service = createService();

    await expect(service.refreshNow({ interactive: true })).resolves.toBeUndefined();

    expect(fetchCopilotQuota).not.toHaveBeenCalled();
    service.dispose();
  });

  it('does not let a background read answer the user click', async () => {
    let releaseBackground: (value: unknown) => void = () => undefined;
    auth.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseBackground = resolve;
      }),
    );
    const service = createService();

    const background = service.refreshNow();
    const clicked = service.refreshNow({ interactive: true });

    auth.getSession.mockResolvedValue(undefined);
    releaseBackground(undefined);
    await background;
    await clicked;

    // The click reached its own attempt, which is the one allowed to prompt.
    expect(auth.getSession).toHaveBeenCalledTimes(3);
    expect(auth.getSession.mock.calls[2][2]).toEqual(PICKER);
    service.dispose();
  });

  it('raises one consent prompt when the row is double-clicked', async () => {
    auth.getSession.mockResolvedValue(undefined);
    const service = createService();

    await Promise.all([
      service.refreshNow({ interactive: true }),
      service.refreshNow({ interactive: true }),
    ]);

    const prompts = auth.getSession.mock.calls.filter(
      (call) => (call[2] as Record<string, unknown>).createIfNone === true,
    );
    expect(prompts).toHaveLength(1);
    service.dispose();
  });

  it('raises one consent prompt when a click lands during a background read', async () => {
    let releaseBackground: (value: unknown) => void = () => undefined;
    auth.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseBackground = resolve;
      }),
    );
    const service = createService();

    const background = service.refreshNow();
    const firstClick = service.refreshNow({ interactive: true });
    const secondClick = service.refreshNow({ interactive: true });

    auth.getSession.mockResolvedValue(undefined);
    releaseBackground(undefined);
    await Promise.all([background, firstClick, secondClick]);

    const prompts = auth.getSession.mock.calls.filter(
      (call) => (call[2] as Record<string, unknown>).createIfNone === true,
    );
    expect(prompts).toHaveLength(1);
    service.dispose();
  });

  it('sends the token and nothing else', async () => {
    const service = createService();

    await service.refreshNow();

    expect(fetchCopilotQuota).toHaveBeenCalledWith({ token: 'gho_test' });
    service.dispose();
  });

  it('drops a pending settle timer when disposed', async () => {
    const service = createService();

    service.scheduleRefresh();
    service.dispose();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
    expect(fetchCopilotQuota).not.toHaveBeenCalled();
  });

  it('reaches the network no more once disposed', async () => {
    const service = createService();
    service.dispose();

    service.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
    await service.refreshNow({ interactive: true });

    expect(fetchCopilotQuota).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('does not reach the network when disposed while the session resolves', async () => {
    let releaseSession: (value: unknown) => void = () => undefined;
    auth.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSession = resolve;
      }),
    );
    const service = createService();

    const refresh = service.refreshNow();
    service.dispose();
    releaseSession(session());
    await refresh;

    expect(fetchCopilotQuota).not.toHaveBeenCalled();
  });
});
