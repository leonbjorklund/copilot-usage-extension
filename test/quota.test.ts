import { describe, expect, it } from 'vitest';
import { formatUsedPercentage, parseCopilotQuota } from '../src/core/quota';

const payload = { quota: 1500, unlimited: false, hasQuota: true, percentRemaining: 63.4,
  additionalUsageUsed: 0, additionalUsageEnabled: false, resetDate: '2026-10-01T00:00:00.000Z' };

describe('Copilot logged quota', () => {
  it('retains server allowance and rounded percentage without reconstructing exact credits', () => {
    const quota = parseCopilotQuota(payload)!;
    expect(quota.entitlement).toBe(1500);
    expect(quota.percentRemaining).toBe(63.4);
    expect(formatUsedPercentage(quota)).toBe('36.6');
    expect(quota).not.toHaveProperty('remaining');
  });
  it('keeps exhausted and unlimited snapshots', () => {
    expect(parseCopilotQuota({ ...payload, quota: 0, percentRemaining: 0, hasQuota: false })?.entitlement).toBe(0);
    expect(parseCopilotQuota({ ...payload, quota: -1, unlimited: true })?.unlimited).toBe(true);
    expect(parseCopilotQuota({ ...payload, quota: -1, unlimited: true, hasQuota: false })?.hasQuota).toBe(false);
  });
  it.each([
    [63.45, '36.55'],
    [99.96, '0.04'],
    [99.99999999999999, '0.00000000000001'],
    [1e-7, '99.9999999'],
    [100, '0'],
  ])('preserves the percentage precision of %s remaining', (percentRemaining, used) => {
    const quota = parseCopilotQuota({ ...payload, percentRemaining })!;
    expect(formatUsedPercentage(quota)).toBe(used);
  });
  it.each([null, [], {}, { ...payload, percentRemaining: 101 }, { ...payload, quota: '1500' },
    { ...payload, resetDate: 'bad' }])('rejects unsupported values %j', value => {
    expect(parseCopilotQuota(value)).toBeUndefined();
  });
});
