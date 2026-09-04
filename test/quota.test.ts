import { describe, expect, it, vi } from 'vitest';

import {
  COPILOT_USER_INFO_URL,
  fetchCopilotQuota,
  formatQuotaLabel,
  parseCopilotQuota,
} from '../src/core/quota';

/** Shape of a real `copilot_internal/user` response for a Copilot Pro account. */
function proPayload(overrides: Record<string, unknown> = {}) {
  return {
    login: 'octocat',
    copilot_plan: 'individual',
    token_based_billing: true,
    quota_reset_date: '2026-10-01',
    quota_reset_date_utc: '2026-10-01T00:00:00.000Z',
    quota_snapshots: {
      chat: {
        quota_id: 'chat',
        entitlement: 0,
        remaining: 0,
        quota_remaining: 0,
        percent_remaining: 100,
        unlimited: true,
        has_quota: true,
        overage_count: 0,
        overage_permitted: false,
      },
      completions: {
        quota_id: 'completions',
        entitlement: 0,
        unlimited: true,
        percent_remaining: 100,
      },
      premium_interactions: {
        quota_id: 'premium_interactions',
        entitlement: 1500,
        remaining: 1317,
        quota_remaining: 1317.2,
        percent_remaining: 87.8,
        unlimited: false,
        has_quota: true,
        overage_count: 0,
        overage_permitted: true,
        overage_entitlement: 20000,
        credits_used: 182,
        ...overrides,
      },
    },
  };
}

describe('parseCopilotQuota', () => {
  it('reads the premium credit snapshot rather than the unlimited chat one', () => {
    const quota = parseCopilotQuota(proPayload());

    expect(quota).toMatchObject({ entitlement: 1500, remaining: 1317.2, unlimited: false });
    expect(quota?.percentRemaining).toBeCloseTo(87.8, 1);
    expect(quota?.used).toBeCloseTo(182.8, 6);
    expect(quota?.resetDate?.toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('ignores an unlimited category the account holds no credits in', () => {
    const payload = proPayload({ entitlement: 0 });

    // `chat` is unlimited with a zero entitlement, which means "not billed
    // against this bucket", not "unlimited AI credits".
    expect(parseCopilotQuota(payload)).toBeUndefined();
  });

  it('still reports an unlimited premium allocation, however it spells the entitlement', () => {
    for (const entitlement of [-1, 0]) {
      const quota = parseCopilotQuota(proPayload({ entitlement, unlimited: true }));
      expect(quota?.unlimited).toBe(true);
    }
  });

  it('prefers premium_models when the account reports the newer key', () => {
    const payload = proPayload();
    (payload.quota_snapshots as Record<string, unknown>).premium_models = {
      entitlement: 7000,
      quota_remaining: 3500,
      percent_remaining: 50,
      unlimited: false,
    };

    expect(parseCopilotQuota(payload)).toMatchObject({ entitlement: 7000, remaining: 3500 });
  });

  it('accepts a string entitlement', () => {
    const quota = parseCopilotQuota(proPayload({ entitlement: '3900' }));

    expect(quota?.entitlement).toBe(3900);
  });

  it('derives the remaining count from the percentage when no count is reported', () => {
    const payload = proPayload();
    const snapshot = (payload.quota_snapshots as Record<string, Record<string, unknown>>)
      .premium_interactions;
    delete snapshot.quota_remaining;
    delete snapshot.remaining;

    expect(parseCopilotQuota(payload)?.remaining).toBeCloseTo(1317, 6);
  });

  it('derives the percentage from the counts, reported or not', () => {
    const payload = proPayload();
    const snapshot = (payload.quota_snapshots as Record<string, Record<string, unknown>>)
      .premium_interactions;
    delete snapshot.percent_remaining;

    const quota = parseCopilotQuota(payload);
    expect(quota?.remaining).toBe(1317.2);
    expect(quota?.percentRemaining).toBeCloseTo(87.813, 3);
    expect(formatQuotaLabel(quota!)).toBe('1,317 / 1,500 | 88%');

    // A reported percentage that disagrees with the counts does not win.
    const skewed = parseCopilotQuota(proPayload({ percent_remaining: 12 }));
    expect(skewed?.percentRemaining).toBeCloseTo(87.813, 3);
  });

  it('reports an unlimited premium allocation that carries no entitlement', () => {
    const quota = parseCopilotQuota({
      quota_snapshots: { premium_interactions: { unlimited: true, percent_remaining: 100 } },
    });

    expect(quota?.unlimited).toBe(true);
  });

  it('reads a bare -1 entitlement as unlimited', () => {
    const payload = proPayload({ entitlement: -1 });
    const snapshot = (payload.quota_snapshots as Record<string, Record<string, unknown>>)
      .premium_interactions;
    delete snapshot.unlimited;

    expect(parseCopilotQuota(payload)?.unlimited).toBe(true);
  });

  it('says nothing when a snapshot reports an entitlement and no counts', () => {
    // Deriving zero here would render as every credit spent, which is worse
    // than showing no row.
    expect(
      parseCopilotQuota({
        quota_snapshots: { premium_interactions: { entitlement: 1500, unlimited: false } },
      }),
    ).toBeUndefined();
  });

  it('reports an unlimited plan without inventing numbers', () => {
    const quota = parseCopilotQuota(proPayload({ unlimited: true, entitlement: -1 }));

    expect(quota?.unlimited).toBe(true);
    expect(formatQuotaLabel(quota!)).toBe('Unlimited AI Credits');
  });

  it('returns nothing when the payload carries no quota', () => {
    expect(parseCopilotQuota({ login: 'octocat' })).toBeUndefined();
    expect(parseCopilotQuota(undefined)).toBeUndefined();
    expect(parseCopilotQuota({ quota_snapshots: {} })).toBeUndefined();
  });

  it('never reports a remaining count outside the entitlement', () => {
    const over = parseCopilotQuota(proPayload({ quota_remaining: 9999, percent_remaining: 999 }));
    expect(over?.remaining).toBe(1500);
    expect(over?.percentRemaining).toBe(100);

    const under = parseCopilotQuota(proPayload({ quota_remaining: -50, percent_remaining: -5 }));
    expect(under?.remaining).toBe(0);
    expect(under?.used).toBe(1500);
  });
});

describe('formatQuotaLabel', () => {
  it('shows remaining, entitlement and percentage', () => {
    const quota = parseCopilotQuota(
      proPayload({ entitlement: 1500, quota_remaining: 537.4, percent_remaining: 35.8 }),
    );

    expect(formatQuotaLabel(quota!)).toBe('537 / 1,500 | 36%');
  });
});

describe('fetchCopilotQuota', () => {
  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    } as unknown as Response;
  }

  it('calls the Copilot user endpoint with a token authorization', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, proPayload()));

    const result = await fetchCopilotQuota({ token: 'gho_test', fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(COPILOT_USER_INFO_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('token gho_test');
    expect((init.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2025-04-01');
    expect(result.kind).toBe('quota');
  });

  it('backs off on a server error instead of erasing the row', async () => {
    const result = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(500, {})) as never,
    });

    // `no-quota` would remove the quota row; only `error` retries later.
    expect(result).toEqual({ kind: 'error' });
  });

  it('gives up on a request that never answers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, proPayload()));

    await fetchCopilotQuota({ token: 't', fetchImpl: fetchImpl as never });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a rejected token separately from a missing subscription', async () => {
    const unauthorized = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(401, {})) as never,
    });
    expect(unauthorized.kind).toBe('unauthorized');

    const notFound = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(404, {})) as never,
    });
    expect(notFound.kind).toBe('no-quota');
  });

  it('surfaces the retry delay when rate limited', async () => {
    const result = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(429, {}, { 'retry-after': '30' })) as never,
    });

    expect(result).toEqual({ kind: 'rate-limited', retryAfterMs: 30_000 });
  });

  it('reads an exhausted rate limit sent as 403 as a rate limit, not a bad token', async () => {
    const exhausted = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(403, {}, { 'x-ratelimit-remaining': '0' })) as never,
    });
    expect(exhausted).toEqual({ kind: 'rate-limited', retryAfterMs: undefined });

    const secondary = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(403, {}, { 'retry-after': '60' })) as never,
    });
    expect(secondary).toEqual({ kind: 'rate-limited', retryAfterMs: 60_000 });

    // A 403 with no rate-limit headers is still a rejected token.
    const forbidden = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(403, {})) as never,
    });
    expect(forbidden).toEqual({ kind: 'unauthorized' });
  });

  it('treats a signed-in account with no snapshots as having no quota', async () => {
    const result = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(200, { can_signup_for_limited: true })) as never,
    });

    expect(result).toEqual({ kind: 'no-quota' });
  });

  it('does not throw when the network fails', async () => {
    const result = await fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as never,
    });

    expect(result).toEqual({ kind: 'error' });
  });
});
