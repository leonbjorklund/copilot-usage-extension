/**
 * Reads the signed-in user's Copilot AI Credit quota.
 *
 * Endpoint, headers and payload shape are taken from the bundled Copilot Chat
 * extension (0.64.1), which refreshes quota with exactly this request. The
 * endpoint is unofficial, so every field is read defensively and any surprise
 * degrades to "no quota" rather than an error the user has to care about.
 */

export const COPILOT_USER_INFO_URL = 'https://api.github.com/copilot_internal/user';
const COPILOT_USER_INFO_API_VERSION = '2025-04-01';
/** A hung read would otherwise hold the row blank and block the next attempt. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface CopilotQuota {
  /** Credits included in the plan for the current period. */
  entitlement: number;
  /** Credits still available. Derived when the payload only reports a percentage. */
  remaining: number;
  /** Credits already spent this period. */
  used: number;
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
  /** The token was rejected; the caller should drop it and get a fresh session. */
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'error' };

export interface FetchQuotaOptions {
  token: string;
  editorVersion?: string;
  pluginVersion?: string;
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

/**
 * A snapshot with a zero entitlement is a category the account has no
 * allocation for, so it must not be picked over one that does.
 */
function hasAllocation(snapshot: RecordValue): boolean {
  const entitlement = readFiniteNumber(snapshot.entitlement);
  return entitlement !== undefined && entitlement !== 0;
}

function selectSnapshot(snapshots: RecordValue): RecordValue | undefined {
  // `premium_models` is the newer name; `premium_interactions` is what accounts
  // still return today. Both hold AI credits despite the "premium" wording, so
  // `unlimited` there really does mean unlimited credits.
  const premium = ['premium_models', 'premium_interactions']
    .map((key) => snapshots[key])
    .filter(isRecord)
    .find((snapshot) => snapshot.unlimited === true || hasAllocation(snapshot));
  if (premium) {
    return premium;
  }

  // `chat` stands in only when it reports an allowance of its own. Accounts not
  // billed against it report `entitlement: 0, unlimited: true`, which is not an
  // unlimited credit balance and must not be shown as one.
  const chat = snapshots.chat;
  return isRecord(chat) && hasAllocation(chat) ? chat : undefined;
}

export function parseCopilotQuota(payload: unknown): CopilotQuota | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const snapshots = payload.quota_snapshots;
  if (!isRecord(snapshots)) {
    return undefined;
  }

  const snapshot = selectSnapshot(snapshots);
  if (snapshot === undefined) {
    return undefined;
  }

  const entitlement = readFiniteNumber(snapshot.entitlement);
  const unlimited = snapshot.unlimited === true || entitlement === -1;
  const overageCount = Math.max(0, readFiniteNumber(snapshot.overage_count) ?? 0);
  const resetDate = readDate(snapshot.reset_date) ?? readDate(payload.quota_reset_date);

  if (unlimited) {
    return {
      entitlement: Number.POSITIVE_INFINITY,
      remaining: Number.POSITIVE_INFINITY,
      used: overageCount,
      percentRemaining: 100,
      unlimited: true,
      overageCount,
      resetDate,
    };
  }

  if (entitlement === undefined) {
    return undefined;
  }

  const total = Math.max(0, entitlement);
  // `quota_remaining` is the float in the same unit as the entitlement, so it
  // is preferred; `remaining` is its truncated twin; the percentage is the
  // last resort. `credits_used` is deliberately unused: it disagrees with the
  // entitlement basis by a fraction of a credit.
  const reportedRemaining =
    readFiniteNumber(snapshot.quota_remaining) ?? readFiniteNumber(snapshot.remaining);
  const reportedPercent = readFiniteNumber(snapshot.percent_remaining);
  if (reportedRemaining === undefined && reportedPercent === undefined) {
    // Reporting an entitlement with nothing spent against it would read as
    // "every credit gone", so say nothing instead.
    return undefined;
  }

  const remaining = Math.min(
    Math.max(reportedRemaining ?? (total * (reportedPercent ?? 0)) / 100, 0),
    total,
  );
  // Deriving the percentage keeps it agreeing with the counts beside it, and
  // covers the payloads that report no percentage at all.
  const percentRemaining = total > 0 ? (remaining / total) * 100 : 0;

  return {
    entitlement: total,
    remaining,
    used: total - remaining,
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
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `token ${options.token}`,
    'X-GitHub-Api-Version': COPILOT_USER_INFO_API_VERSION,
  };

  if (options.editorVersion) {
    headers['Editor-Version'] = options.editorVersion;
  }

  if (options.pluginVersion) {
    headers['Editor-Plugin-Version'] = options.pluginVersion;
  }

  let response: Response;
  try {
    response = await doFetch(COPILOT_USER_INFO_URL, {
      method: 'GET',
      headers,
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
