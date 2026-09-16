import { formatUsedPercentage, type CopilotQuota } from '../core/quota';

export const CREDIT_USAGE_EXPLANATION =
  'Used credits are calculated from Copilot\'s reported percentage and rounded to whole credits for display.';

export function formatQuotaLabel(quota: CopilotQuota, order: 'credits-first' | 'percentage-first' = 'credits-first'): string {
  if (quota.unlimited) return quota.hasQuota ? 'Unlimited Copilot quota' : 'Copilot allowance exhausted';
  if (quota.entitlement === 0) return quota.hasQuota ? 'No Copilot credit allowance' : 'Copilot allowance exhausted';
  const usedPercentage = formatUsedPercentage(quota);
  const percentage = `${usedPercentage}% / 100%`;
  const credits = `${formatCredits(quota.entitlement, usedPercentage)} / ${formatCredits(quota.entitlement)} credits`;
  return order === 'percentage-first' ? `${percentage}  (${credits})` : `${credits} (${percentage})`;
}

/** Round the decimal calculation, without floating-point drift at half-credit boundaries. */
function formatCredits(allowance: number, percentage = '100'): string {
  const [coefficient, exponent = '0'] = allowance.toString().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const places = Math.max(0, fraction.length - Number(exponent));
  const units = BigInt(whole + fraction) * 10n ** BigInt(places + Number(exponent) - fraction.length);
  const [percentWhole, percentFraction = ''] = percentage.split('.');
  const numerator = units * BigInt(percentWhole + percentFraction);
  const denominator = 100n * 10n ** BigInt(places + percentFraction.length);
  if (numerator > 0 && numerator < denominator) return '<1';
  return ((numerator + denominator / 2n) / denominator).toLocaleString('en-US').replaceAll(',', '\u00a0');
}

/** Extrapolate the reported usage at its log timestamp, never at a later read time. */
export function calculateProjectedPercentage(quota: CopilotQuota, observedAt: number, now: number): number | undefined {
  if (!formatPeriodPercentage(quota) || !Number.isFinite(observedAt) || !Number.isFinite(now) || observedAt > now) return;
  const observed = new Date(observedAt);
  const start = Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), 1);
  const end = Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || quota.resetDate?.getTime() !== end ||
    observedAt <= start || now >= end) return;
  const projected = Number(formatUsedPercentage(quota)) * (end - start) / (observedAt - start);
  return Number.isFinite(projected) ? projected : undefined;
}

export function formatQuotaPace(quota: CopilotQuota, observedAt: number, now: number): string | undefined {
  if (quota.unlimited || quota.entitlement <= 0) return;
  const projected = calculateProjectedPercentage(quota, observedAt, now);
  if (projected === undefined) return 'Pace unavailable';
  const observed = new Date(observedAt);
  const daysInMonth = new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 0)).getUTCDate();
  const daily = projected / daysInMonth;
  const dailyText = daily > 0 && daily < 0.01 ? '<0.01'
    : daily.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });
  const monthlyText = projected.toLocaleString('en-US', { maximumFractionDigits: 1, useGrouping: false });
  return `${dailyText}% / day · ${monthlyText}% monthly pace`;
}

export function formatPeriodPercentage(quota: CopilotQuota | undefined): string | undefined {
  if (!quota || quota.unlimited || !Number.isFinite(quota.entitlement) || quota.entitlement <= 0 ||
    !Number.isFinite(quota.percentRemaining)) {
    return undefined;
  }

  return `${formatUsedPercentage(quota)}/100%`;
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
