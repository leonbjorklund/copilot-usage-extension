import { formatUsedPercentage, toDecimal, type CopilotQuota } from '../core/quota';

export const CREDIT_USAGE_EXPLANATION =
  'Used credits are calculated from Copilot\'s reported percentage and overage, then rounded to whole credits for display.';

export function formatQuotaLabel(quota: CopilotQuota, order: 'credits-first' | 'percentage-first' = 'credits-first'): string {
  if (quota.unlimited) return quota.hasQuota ? 'Unlimited Copilot quota' : 'Copilot allowance exhausted';
  if (quota.entitlement === 0) return quota.hasQuota ? 'No Copilot credit allowance' : 'Copilot allowance exhausted';
  const used = formatCredits(quota.entitlement, formatUsedPercentage({ ...quota, overage: 0 }), quota.overage);
  const allowance = formatCredits(quota.entitlement);
  // Past the allowance, the allowance comes first and the larger spend second.
  const [percentage, credits] = quota.overage
    ? [`100% / ${formatUsedPercentage(quota)}%`, `${allowance} / ${used} credits`]
    : [`${formatUsedPercentage(quota)}% / 100%`, `${used} / ${allowance} credits`];
  return order === 'percentage-first' ? `${percentage}  (${credits})` : `${credits} (${percentage})`;
}

/** Round the decimal calculation, without floating-point drift at half-credit boundaries. */
function formatCredits(allowance: number, percentage = '100', overage = 0): string {
  const [units, places] = toDecimal(allowance);
  const [overageUnits, overagePlaces] = toDecimal(overage);
  const [percentWhole, percentFraction = ''] = percentage.split('.');
  const denominator = 100n * 10n ** BigInt(places + percentFraction.length + overagePlaces);
  const numerator = units * BigInt(percentWhole + percentFraction) * 10n ** BigInt(overagePlaces)
    + overageUnits * denominator / 10n ** BigInt(overagePlaces);
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

  return quota.overage ? `100/${formatUsedPercentage(quota)}%` : `${formatUsedPercentage(quota)}/100%`;
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
