import { getSpentCredits, type CopilotQuota } from '../core/quota';

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

  const spent = getSpentCredits(quota);
  return Math.round(spent / quota.entitlement * 100);
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

/** Keep small positive costs visible; otherwise round to one decimal. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<0.01$';
  if (usd >= 0.01 && usd < 0.05) return `${usd.toFixed(2)}$`;
  return `${Math.max(0, Math.round(usd * 10)) / 10}$`;
}
