import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CopilotQuota, QuotaFetchResult } from '../src/core/quota';

const { fetchCopilotQuota, auth, config } = vi.hoisted(() => ({
  fetchCopilotQuota: vi.fn(),
  auth: {
    getSession: vi.fn(),
    sessionChangeHandlers: [] as Array<(event: { provider: { id: string } }) => void>,
  },
  config: new Map<string, string>(),
}));

vi.mock('../src/core/quota', () => ({ fetchCopilotQuota }));

vi.mock('vscode', () => ({
  version: '1.136.1',
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
    onDidChangeSessions: (handler: (event: { provider: { id: string } }) => void) => {
      auth.sessionChangeHandlers.push(handler);
      return { dispose: () => undefined };
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string) => config.get(key) }),
  },
}));

const { CopilotQuotaService } = await import('../src/core/quotaService');

const SETTLE_DELAY_MS = 10_000;
const MIN_REFRESH_INTERVAL_MS = 60_000;

function quota(overrides: Partial<CopilotQuota> = {}): CopilotQuota {
  return {
    entitlement: 1500,
    remaining: 1317,
    used: 183,
    percentRemaining: 87.8,
    unlimited: false,
    overageCount: 0,
    ...overrides,
  };
}

function session(label = 'octocat') {
  return { accessToken: 'gho_test', account: { id: 'acct-1', label } };
}

function resolvesTo(result: QuotaFetchResult) {
  fetchCopilotQuota.mockResolvedValue(result);
}

/** Arguments of the most recent `getSession` call. */
function lastGetSessionCall() {
  return auth.getSession.mock.calls.at(-1) as [string, string[], Record<string, unknown>];
}

describe('CopilotQuotaService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchCopilotQuota.mockReset();
    auth.getSession.mockReset();
    auth.sessionChangeHandlers.length = 0;
    config.clear();
    auth.getSession.mockResolvedValue(session());
    resolvesTo({ kind: 'quota', quota: quota() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the quota with a silent session and publishes it', async () => {
    const service = new CopilotQuotaService('0.0.4');
    const changes = vi.fn();
    service.onDidChange(changes);

    await service.refreshNow();

    const [providerId, scopes, options] = lastGetSessionCall();
    expect(providerId).toBe('github');
    expect(scopes).toEqual([]);
    expect(options).toEqual({ silent: true });
    expect(auth.getSession).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({
      kind: 'quota',
      quota: quota(),
      account: 'octocat',
    });
    expect(changes).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('never asks to create a session on a background refresh', async () => {
    auth.getSession.mockResolvedValue(undefined);
    const service = new CopilotQuotaService();

    await service.refreshNow();

    expect(auth.getSession).toHaveBeenCalledTimes(1);
    expect(lastGetSessionCall()[2]).toEqual({ silent: true });
    expect(fetchCopilotQuota).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ kind: 'needs-consent' });
    service.dispose();
  });

  it('falls back to the consent prompt only for a user gesture', async () => {
    auth.getSession.mockResolvedValueOnce(undefined).mockResolvedValueOnce(session());
    const service = new CopilotQuotaService();

    await service.refreshNow({ interactive: true });

    expect(auth.getSession).toHaveBeenCalledTimes(2);
    expect(auth.getSession.mock.calls[0][2]).toEqual({ silent: true });
    expect(auth.getSession.mock.calls[1][2]).toEqual({ createIfNone: true });
    expect(service.getState()).toMatchObject({ kind: 'quota' });
    service.dispose();
  });

  it('uses the enterprise provider when the workspace configures one', async () => {
    config.set('github-enterprise.uri', 'https://ghe.example.com');
    const service = new CopilotQuotaService();

    await service.refreshNow();

    expect(lastGetSessionCall()[0]).toBe('github-enterprise');
    service.dispose();
  });

  it('holds background refreshes to one a minute but lets a gesture through', async () => {
    const service = new CopilotQuotaService();

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
    const service = new CopilotQuotaService();

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

  it('clears the backoff once a read succeeds', async () => {
    resolvesTo({ kind: 'error' });
    const service = new CopilotQuotaService();
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
    const service = new CopilotQuotaService();

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
    const service = new CopilotQuotaService();

    await service.refreshNow();

    expect(service.getState()).toEqual({ kind: 'needs-consent' });
    service.dispose();
  });

  it('replaces a rejected token when the user clicks the row', async () => {
    resolvesTo({ kind: 'unauthorized' });
    const service = new CopilotQuotaService();
    await service.refreshNow();

    // A silent session still exists; it is the token behind it that GitHub
    // refused, so re-consenting to the same one would fail the same way.
    resolvesTo({ kind: 'quota', quota: quota() });
    await service.refreshNow({ interactive: true });

    expect(lastGetSessionCall()[2]).toEqual({ forceNewSession: true });
    expect(service.getState()).toMatchObject({ kind: 'quota' });

    // Once a read succeeds the sign-in is not demanded again.
    await service.refreshNow({ interactive: true });
    expect(lastGetSessionCall()[2]).toEqual({ silent: true });
    service.dispose();
  });

  it('redraws when only the overage or reset date moves', async () => {
    const service = new CopilotQuotaService();
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
    const service = new CopilotQuotaService();

    await expect(service.refreshNow()).resolves.toBeUndefined();
    service.dispose();
  });

  it('reports an account without credits as unavailable', async () => {
    resolvesTo({ kind: 'no-quota' });
    const service = new CopilotQuotaService();

    await service.refreshNow();

    expect(service.getState()).toEqual({ kind: 'unavailable' });
    service.dispose();
  });

  it('refetches when the GitHub account changes, ignoring other providers', async () => {
    const service = new CopilotQuotaService();
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    for (const handler of auth.sessionChangeHandlers) {
      handler({ provider: { id: 'microsoft' } });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    auth.getSession.mockResolvedValue(session('hubot'));
    for (const handler of auth.sessionChangeHandlers) {
      handler({ provider: { id: 'github' } });
    }
    await vi.advanceTimersByTimeAsync(0);

    // A burst of token-refresh events must not become a burst of requests, so
    // the reread waits out the floor rather than skipping it.
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(2);
    expect(service.getState()).toMatchObject({ account: 'hubot' });
    service.dispose();
  });

  it('keeps an active rate-limit backoff when the account changes', async () => {
    resolvesTo({ kind: 'rate-limited', retryAfterMs: 5 * MIN_REFRESH_INTERVAL_MS });
    const service = new CopilotQuotaService();
    await service.refreshNow();
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);

    for (let event = 0; event < 4; event += 1) {
      for (const handler of auth.sessionChangeHandlers) {
        handler({ provider: { id: 'github' } });
      }
      await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);
    }

    // GitHub asked for five minutes of silence, so four events inside that
    // window must not put a single extra request on the wire.
    expect(fetchCopilotQuota).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('waits for log writes to settle and collapses a burst into one read', async () => {
    const service = new CopilotQuotaService();

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
    const service = new CopilotQuotaService();
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
    const service = new CopilotQuotaService();
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
    const service = new CopilotQuotaService();

    await service.refreshNow();

    // Claiming consent is needed would be a lie; the user already granted it.
    expect(service.getState()).toEqual({ kind: 'idle' });

    // The failure backs off, so an immediate log write does not retry it.
    auth.getSession.mockResolvedValue(session());
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS - 1);
    await service.refreshNow();
    expect(fetchCopilotQuota).not.toHaveBeenCalled();

    // Once the wait is over the row recovers on its own.
    vi.advanceTimersByTime(1);
    await service.refreshNow();
    expect(service.getState()).toMatchObject({ kind: 'quota' });
    service.dispose();
  });

  it('does not let a background read answer the user click', async () => {
    let releaseBackground: (value: unknown) => void = () => undefined;
    auth.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseBackground = resolve;
      }),
    );
    const service = new CopilotQuotaService();

    const background = service.refreshNow();
    const clicked = service.refreshNow({ interactive: true });

    auth.getSession.mockResolvedValue(undefined);
    releaseBackground(undefined);
    await background;
    await clicked;

    // The click reached its own attempt, which is the one allowed to prompt.
    expect(auth.getSession).toHaveBeenCalledTimes(3);
    expect(auth.getSession.mock.calls[2][2]).toEqual({ createIfNone: true });
    service.dispose();
  });

  it('raises one consent prompt when the row is double-clicked', async () => {
    auth.getSession.mockResolvedValue(undefined);
    const service = new CopilotQuotaService();

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

  it('sends the token and version strings and nothing about the account', async () => {
    const service = new CopilotQuotaService('0.0.4');

    await service.refreshNow();

    expect(fetchCopilotQuota).toHaveBeenCalledWith({
      token: 'gho_test',
      editorVersion: 'vscode/1.136.1',
      pluginVersion: 'copilot-token-cost/0.0.4',
    });
    service.dispose();
  });

  it('raises one consent prompt when a click lands during a background read', async () => {
    let releaseBackground: (value: unknown) => void = () => undefined;
    auth.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseBackground = resolve;
      }),
    );
    const service = new CopilotQuotaService();

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

  it('drops a pending settle timer when disposed', async () => {
    const service = new CopilotQuotaService();

    service.scheduleRefresh();
    service.dispose();
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

    expect(fetchCopilotQuota).not.toHaveBeenCalled();
  });

  it('reaches the network no more once disposed', async () => {
    const service = new CopilotQuotaService();
    service.dispose();

    service.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
    await service.refreshNow({ interactive: true });

    expect(fetchCopilotQuota).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });
});
