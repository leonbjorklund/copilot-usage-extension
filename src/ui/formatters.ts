import type { CopilotQuota } from '../core/quota';

/** Only show a percentage when the snapshot belongs to this calendar billing month. */
export function formatPeriodPercentage(quota: CopilotQuota | undefined, now = new Date()): string | undefined {
  const percentage = getPeriodSpentPercentage(quota, now);
  return percentage === undefined ? undefined : `${percentage}/100%`;
}

/** Rounded account spending for a valid current UTC billing month. */
export function getPeriodSpentPercentage(quota: CopilotQuota | undefined, now = new Date()): number | undefined {
  if (!quota || quota.unlimited || !Number.isFinite(quota.entitlement) || quota.entitlement <= 0) {
    return undefined;
  }

  const expectedReset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  if (quota.resetDate?.getTime() !== expectedReset || !Number.isFinite(quota.remaining) || !Number.isFinite(quota.overageCount)) {
    return undefined;
  }

  const spent = Math.max(0, quota.entitlement - quota.remaining) + Math.max(0, quota.overageCount);
  return Math.round(spent / quota.entitlement * 100);
}

/** Totals keep cents; the compact model/session rows use formatUsd. */
export function formatTotalUsd(usd: number): string {
  return `${Math.max(0, Math.round(usd * 100)) / 100}$`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 100_000) / 10}M`;
  }

  if (tokens >= 1_000) {
    const thousands = Math.round(tokens / 1_000);
    return thousands >= 1_000 ? `${Math.round(thousands / 100) / 10}M` : `${thousands}k`;
  }

  return `${Math.round(tokens)}`;
}

export function formatUsd(usd: number): string {
  const cents = Math.round(usd * 100);
  if (cents <= 0) {
    return "0$";
  }

  return cents < 100 ? `${(cents / 100).toFixed(2)}$` : `${Math.round(usd * 10) / 10}$`;
}
