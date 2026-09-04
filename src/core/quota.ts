/**
 * Reads the signed-in user's Copilot AI Credit quota.
 *
 * The endpoint, headers and field reading are taken from the bundled Copilot
 * Chat extension (0.64.1). The endpoint is unofficial, so any surprise in the
 * payload degrades to "no quota".
 */

export const COPILOT_USER_INFO_URL = 'https://api.github.com/copilot_internal/user';
const COPILOT_USER_INFO_API_VERSION = '2025-04-01';
/** A hung read would otherwise hold the row blank and block the next attempt. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface CopilotQuota {
  /** Credits included in the plan for the current period. Infinity when unlimited. */
  entitlement: number;
  /** Credits still available, derived from the reported percentage. Infinity when unlimited. */
  remaining: number;
  /** 0-100. */
  percentRemaining: number;
  unlimited: boolean;
  overageCount: number;
  resetDate?: Date;
}

export type QuotaFetchResult =
  | { kind: 'quota'; quota: CopilotQuota }
  /** Signed in, but the account has no Copilot quota to report. */
  | { kind: 'no-quota' }
  /** The token was rejected; the row falls back to asking for a click. */
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'error' };

export interface FetchQuotaOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The payload reports some numbers as strings, so accept both. */
function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function readDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseCopilotQuota(payload: unknown): CopilotQuota | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const snapshots = payload.quota_snapshots;
  if (!isRecord(snapshots)) {
    return undefined;
  }

  // Copilot Chat reads `premium_models ?? premium_interactions`; both hold AI credits.
  const snapshot = [snapshots.premium_models, snapshots.premium_interactions].find(isRecord);
  if (snapshot === undefined) {
    return undefined;
  }

  const entitlement = readFiniteNumber(snapshot.entitlement);
  if (entitlement === undefined) {
    return undefined;
  }

  const overageCount = readFiniteNumber(snapshot.overage_count) ?? 0;
  const resetDate = readDate(snapshot.reset_date) ?? readDate(payload.quota_reset_date);

  // Copilot Chat reads -1 as unlimited; VS Code's own entitlement service reads
  // the flag. Accept both.
  if (snapshot.unlimited === true || entitlement === -1) {
    return {
      entitlement: Number.POSITIVE_INFINITY,
      remaining: Number.POSITIVE_INFINITY,
      percentRemaining: 100,
      unlimited: true,
      overageCount,
      resetDate,
    };
  }

  const reportedPercent = readFiniteNumber(snapshot.percent_remaining);
  if (reportedPercent === undefined) {
    return undefined;
  }

  const percentRemaining = Math.min(100, Math.max(0, reportedPercent));
  return {
    entitlement,
    remaining: (entitlement * percentRemaining) / 100,
    percentRemaining,
    unlimited: false,
    overageCount,
    resetDate,
  };
}

function isRateLimited(response: Response): boolean {
  return (
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.get('retry-after') !== null
  );
}

function readRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) {
    return undefined;
  }

  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export async function fetchCopilotQuota(options: FetchQuotaOptions): Promise<QuotaFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(COPILOT_USER_INFO_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `token ${options.token}`,
        'X-GitHub-Api-Version': COPILOT_USER_INFO_API_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'error' };
  }

  // GitHub reports an exhausted rate limit as 403 as often as 429, so this has
  // to be settled before 403 is read as a rejected token.
  if (response.status === 429 || (response.status === 403 && isRateLimited(response))) {
    return { kind: 'rate-limited', retryAfterMs: readRetryAfterMs(response) };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: 'unauthorized' };
  }

  if (response.status === 404) {
    // Signed in, but this account has no Copilot subscription.
    return { kind: 'no-quota' };
  }

  if (!response.ok) {
    return { kind: 'error' };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: 'error' };
  }

  const quota = parseCopilotQuota(payload);
  return quota ? { kind: 'quota', quota } : { kind: 'no-quota' };
}

export function formatQuotaLabel(quota: CopilotQuota): string {
  if (quota.unlimited) {
    return 'Unlimited AI Credits';
  }

  const remaining = formatCredits(quota.remaining);
  const entitlement = formatCredits(quota.entitlement);
  return `${remaining} / ${entitlement} | ${Math.round(quota.percentRemaining)}%`;
}

export function formatCredits(value: number): string {
  // Credits are fractional per request but only whole numbers are meaningful here.
  return Math.round(value).toLocaleString('en-US');
}
