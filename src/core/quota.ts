/** Server values emitted by Copilot's ChatQuota service. No credentials or HTTP requests. */
export interface CopilotQuota {
  entitlement: number;
  percentRemaining: number;
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
  return {
    entitlement: value.quota,
    percentRemaining: value.percentRemaining,
    unlimited: value.unlimited || value.quota === -1,
    hasQuota: value.hasQuota,
    resetDate,
  };
}

/** Subtract decimal units so binary floating-point does not add or discard digits. */
export function formatUsedPercentage(quota: CopilotQuota): string {
  const [coefficient, exponent = '0'] = quota.percentRemaining.toString().split('e');
  const [integer, fraction = ''] = coefficient.split('.');
  const places = Math.max(0, fraction.length - Number(exponent));
  const scale = 10n ** BigInt(places);
  const remaining = BigInt(integer + fraction) * 10n ** BigInt(places + Number(exponent) - fraction.length);
  const used = 100n * scale - remaining;
  const decimals = (used % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return (used / scale).toLocaleString('en-US') + (decimals ? `.${decimals}` : '');
}
