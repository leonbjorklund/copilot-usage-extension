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
    quota_reset_date: '2026-10-01',
    quota_snapshots: {
      chat: { entitlement: 0, percent_remaining: 100, unlimited: true },
      premium_interactions: {
        entitlement: 1500,
        percent_remaining: 87.8,
        unlimited: false,
        overage_count: 0,
        ...overrides,
      },
    },
  };
}

describe('parseCopilotQuota', () => {
  it('reads premium_interactions from the Pro payload', () => {
    const quota = parseCopilotQuota(proPayload());

    expect(quota).toMatchObject({ entitlement: 1500, percentRemaining: 87.8, unlimited: false });
    expect(quota?.remaining).toBeCloseTo(1317, 6);
    expect(quota?.resetDate?.toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('prefers premium_models when present', () => {
    const payload = proPayload();
    (payload.quota_snapshots as Record<string, unknown>).premium_models = {
      entitlement: 7000,
      percent_remaining: 50,
    };

    expect(parseCopilotQuota(payload)).toMatchObject({ entitlement: 7000, remaining: 3500 });
  });

  it('accepts a string entitlement', () => {
    expect(parseCopilotQuota(proPayload({ entitlement: '3900' }))?.entitlement).toBe(3900);
  });

  it('reads a -1 entitlement or the unlimited flag as unlimited', () => {
    for (const overrides of [{ entitlement: -1 }, { entitlement: 0, unlimited: true }]) {
      const quota = parseCopilotQuota(proPayload(overrides));

      expect(quota).toMatchObject({ unlimited: true, entitlement: Infinity, remaining: Infinity });
      expect(formatQuotaLabel(quota!)).toBe('Unlimited AI Credits');
    }
  });

  it('keeps the percentage between 0 and 100', () => {
    expect(parseCopilotQuota(proPayload({ percent_remaining: 999 }))).toMatchObject({
      percentRemaining: 100,
      remaining: 1500,
    });
    expect(parseCopilotQuota(proPayload({ percent_remaining: -5 }))).toMatchObject({
      percentRemaining: 0,
      remaining: 0,
    });
  });

  it('prefers the snapshot reset date and reads the overage', () => {
    const quota = parseCopilotQuota(proPayload({ reset_date: '2026-09-15', overage_count: '12' }));

    expect(quota?.resetDate?.toISOString().slice(0, 10)).toBe('2026-09-15');
    expect(quota?.overageCount).toBe(12);
  });

  it('says nothing when the snapshot reports no percentage', () => {
    expect(parseCopilotQuota(proPayload({ percent_remaining: undefined }))).toBeUndefined();
  });

  it('returns nothing when the payload carries no quota', () => {
    expect(parseCopilotQuota({ login: 'octocat' })).toBeUndefined();
    expect(parseCopilotQuota(undefined)).toBeUndefined();
    expect(parseCopilotQuota({ quota_snapshots: {} })).toBeUndefined();
  });
});

describe('formatQuotaLabel', () => {
  it('shows remaining, entitlement and percentage', () => {
    const quota = parseCopilotQuota(proPayload({ entitlement: 1500, percent_remaining: 35.8 }));

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

  function fetchWith(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
    return fetchCopilotQuota({
      token: 't',
      fetchImpl: (async () => jsonResponse(status, body, headers)) as never,
    });
  }

  it('calls the Copilot user endpoint with the token and API version headers only', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, proPayload()));

    const result = await fetchCopilotQuota({ token: 'gho_test', fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(COPILOT_USER_INFO_URL);
    expect(Object.keys(headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'X-GitHub-Api-Version',
    ]);
    expect(headers.Authorization).toBe('token gho_test');
    expect(headers['X-GitHub-Api-Version']).toBe('2025-04-01');
    expect(result.kind).toBe('quota');
  });

  it('gives up on a request that never answers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, proPayload()));

    await fetchCopilotQuota({ token: 't', fetchImpl: fetchImpl as never });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('backs off on a server error instead of erasing the row', async () => {
    // `no-quota` would remove the quota row; only `error` retries later.
    expect(await fetchWith(500)).toEqual({ kind: 'error' });
  });

  it('reports a rejected token separately from a missing subscription', async () => {
    expect(await fetchWith(401)).toEqual({ kind: 'unauthorized' });
    expect(await fetchWith(404)).toEqual({ kind: 'no-quota' });
  });

  it('surfaces the retry delay when rate limited', async () => {
    const result = await fetchWith(429, {}, { 'retry-after': '30' });

    expect(result).toEqual({ kind: 'rate-limited', retryAfterMs: 30_000 });
  });

  it('reads an exhausted rate limit sent as 403 as a rate limit, not a bad token', async () => {
    const exhausted = await fetchWith(403, {}, { 'x-ratelimit-remaining': '0' });
    expect(exhausted).toEqual({ kind: 'rate-limited', retryAfterMs: undefined });

    const secondary = await fetchWith(403, {}, { 'retry-after': '60' });
    expect(secondary).toEqual({ kind: 'rate-limited', retryAfterMs: 60_000 });

    // A 403 with no rate-limit headers is still a rejected token.
    expect(await fetchWith(403)).toEqual({ kind: 'unauthorized' });
  });

  it('treats a signed-in account with no snapshots as having no quota', async () => {
    expect(await fetchWith(200, { can_signup_for_limited: true })).toEqual({ kind: 'no-quota' });
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
