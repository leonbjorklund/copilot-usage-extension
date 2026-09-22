/** Server values emitted by Copilot's ChatQuota service. No credentials or HTTP requests. */
export interface CopilotQuota {
  entitlement: number;
  percentRemaining: number;
  /** Credits spent past the allowance, kept only while `percentRemaining` is 0. */
  overage?: number;
  unlimited: boolean;
  hasQuota: boolean;
  resetDate?: Date;
}

export function parseCopilotQuota(payload: unknown): CopilotQuota | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const value = payload as Record<string, unknown>;
  if (typeof value.quota !== 'number' || !Number.isFinite(value.quota) || value.quota < -1 ||
    typeof value.hasQuota !== 'boolean' || typeof value.unlimited !== 'boolean' || typeof value.percentRemaining !== 'number' ||
    !Number.isFinite(value.percentRemaining) || value.percentRemaining < 0 || value.percentRemaining > 100) return;
  const resetDate = typeof value.resetDate === 'string' ? new Date(value.resetDate) : undefined;
  if (resetDate && !Number.isFinite(resetDate.getTime())) return;
  // Copilot holds the percentage at 0 during overage. A malformed overage must not hide the percentage.
  const overage = value.additionalUsageUsed;
  const hasOverage = value.percentRemaining === 0 && typeof overage === 'number' && Number.isFinite(overage) && overage > 0;
  return {
    entitlement: value.quota,
    percentRemaining: value.percentRemaining,
    ...(hasOverage ? { overage } : {}),
    unlimited: value.unlimited || value.quota === -1,
    hasQuota: value.hasQuota,
    resetDate,
  };
}

/**
 * Subtract decimal units so binary floating-point does not add or discard digits.
 * Overage is a derived ratio, so it adds one decimal place, rounded half up.
 */
export function formatUsedPercentage(quota: CopilotQuota): string {
  const [remaining, remainingPlaces] = toDecimal(quota.percentRemaining);
  const [overage, overagePlaces] = toDecimal(quota.overage ?? 0);
  const [allowance, allowancePlaces] = toDecimal(Math.max(0, quota.entitlement));
  const numerator = 1000n * overage * 10n ** BigInt(allowancePlaces);
  const denominator = allowance * 10n ** BigInt(overagePlaces);
  const tenths = denominator > 0n ? (numerator + denominator / 2n) / denominator : 0n;
  const places = Math.max(tenths ? 1 : 0, remainingPlaces);
  const scale = 10n ** BigInt(places);
  const used = 100n * scale - remaining * 10n ** BigInt(places - remainingPlaces) + tenths * scale / 10n;
  const decimals = (used % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return (used / scale).toString() + (decimals ? `.${decimals}` : '');
}

/** Split a number into integer digits and decimal places, as written. */
export function toDecimal(value: number): [bigint, number] {
  const [coefficient, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const places = Math.max(0, fraction.length - Number(exponent));
  return [BigInt(whole + fraction) * 10n ** BigInt(places + Number(exponent) - fraction.length), places];
}
