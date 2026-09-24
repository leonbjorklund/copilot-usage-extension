import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** One `[ChatQuota]` value from Copilot Chat's output log, stamped with the log line's local time. */
export interface Reading {
  at: number;
  /** The monthly allowance in credits. */
  quota: number;
  percentRemaining: number;
  /** Credits spent past the allowance. */
  additionalUsageUsed?: number;
  resetDate?: string;
  unlimited: boolean;
}

/**
 * Per account, oldest first: its earliest reading, or the newest one older than 35 days, then the
 * last reading of each local day.
 */
export type Records = { [login: string]: Reading[] };

/**
 * A reading with the account its window's log named last: `null` when that account is anonymous
 * or unreadable, `undefined` when the log holds no account line before the reading.
 */
export interface Found { login?: string | null; reading: Reading }

/**
 * A window's Copilot Chat log: bytes read, the file's modification time, the latest account line's
 * login, and the time of the latest Trace line.
 */
interface WindowLog { size: number; modified?: number; login?: string | null; traceAt?: number }

/** What has been read so far of one VS Code session's Copilot Chat logs. */
export interface LogState {
  windows: Map<string, WindowLog>;
  /** Every account line seen, from all windows. */
  logins: Array<{ at: number; login: string | null }>;
}

const CHANNEL = 'GitHub Copilot Chat';
const DAYS_KEPT = 35;
// `2026-09-23 10:04:50.301 [trace] [ChatQuota] processQuotaHeaders: {...}`, stamped in local time.
const LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \[\w+\] (?:\[ChatQuota\] process\w+: (.*?)|Got Copilot token for (.*?))\r?$/gm;
const TRACE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \[trace\] /gm;
const STAMP = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})$/;
// GitHub logins, including the underscore of enterprise managed users.
const LOGIN = /^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i;

/** Validates a logged quota payload or a saved reading. */
export function toReading(at: unknown, value: unknown): Reading | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof value !== 'object' || value === null) return;
  const { quota, percentRemaining, additionalUsageUsed, resetDate, unlimited } = value as { [key: string]: unknown };
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota < -1 || typeof unlimited !== 'boolean' ||
    typeof percentRemaining !== 'number' || !(percentRemaining >= 0 && percentRemaining <= 100)) return;
  // Copilot holds the percentage at 0 while spending goes past the allowance.
  const overage = percentRemaining === 0 && typeof additionalUsageUsed === 'number' &&
    Number.isFinite(additionalUsageUsed) && additionalUsageUsed > 0;
  return {
    at, quota, percentRemaining,
    ...(overage ? { additionalUsageUsed } : {}),
    ...(typeof resetDate === 'string' && !Number.isNaN(Date.parse(resetDate)) ? { resetDate } : {}),
    unlimited: unlimited || quota === -1,
  };
}

/**
 * Reads the lines each window's Copilot Chat log gained since the last call. A log that shrank
 * was emptied or rotated, so it is read again from its start.
 */
export async function readLogs(session: string, state: LogState): Promise<Found[]> {
  const found: Found[] = [];
  const names = await readdir(session).catch(() => []);
  for (const name of names.filter((name) => /^window\d+$/.test(name))) {
    const folder = join(session, name, 'exthost', 'GitHub.copilot-chat');
    const file = join(folder, `${CHANNEL}.log`);
    try {
      const { size, mtimeMs } = await stat(file);
      let window = state.windows.get(name);
      if (!window) {
        window = { size: 0 };
        state.windows.set(name, window);
        // Rotated copies hold the window's earlier lines; `.1.log` is the newest of them.
        const rotated = (await readdir(folder))
          .map((entry) => Number(/^GitHub Copilot Chat\.(\d+)\.log$/.exec(entry)?.[1]))
          .filter((index) => index > 0)
          .sort((a, b) => b - a);
        for (const index of rotated) {
          const copy = join(folder, `${CHANNEL}.${index}.log`);
          parse((await readLines(copy, 0, (await stat(copy)).size)).text, window, state, found);
        }
      }
      window.modified = mtimeMs;
      if (size < window.size) window.size = 0;
      if (size > window.size) {
        const { text, end } = await readLines(file, window.size, size);
        parse(text, window, state, found);
        window.size = end;
      }
    } catch {
      // A missing or unreadable log is tried again on the next call.
    }
  }
  return found;
}

/** Reads the whole lines between two byte offsets; `end` is where the next read continues. */
export async function readLines(file: string, from: number, to: number): Promise<{ text: string; end: number }> {
  const buffer = Buffer.alloc(to - from);
  const handle = await open(file, 'r');
  let length = 0;
  try {
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, from + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const last = buffer.subarray(0, length).lastIndexOf(10);
  return { text: buffer.toString('utf8', 0, last + 1), end: from + last + 1 };
}

function localTime(stamp: string): number {
  const [, year, month, day, hour, minute, second, ms] = STAMP.exec(stamp)!;
  return new Date(+year, +month - 1, +day, +hour, +minute, +second, +ms).getTime();
}

function parse(text: string, window: WindowLog, state: LogState, found: Found[]): void {
  let trace: string | undefined;
  for (const [, stamp] of text.matchAll(TRACE)) trace = stamp;
  if (trace) window.traceAt = localTime(trace);
  for (const [, stamp, payload, login] of text.matchAll(LINE)) {
    const at = localTime(stamp);
    if (login !== undefined) {
      // Anonymous access logs the word `devDeviceId`; its usage belongs to no account.
      window.login = LOGIN.test(login) && login.toLowerCase() !== 'devdeviceid' ? login.toLowerCase() : null;
      state.logins.push({ at, login: window.login });
      continue;
    }
    try {
      const reading = toReading(at, JSON.parse(payload));
      if (reading) found.push({ login: window.login, reading });
    } catch {
      // A payload that is not JSON is skipped.
    }
  }
}

/**
 * Names each reading's account: its window's latest account line, else the latest account line
 * of any window before the reading, else the saved account. Readings without one are dropped.
 */
export function assignAccounts(
  found: Found[], logins: LogState['logins'], saved?: string,
): Array<{ login: string; reading: Reading }> {
  const assigned: Array<{ login: string; reading: Reading }> = [];
  for (const { login, reading } of found) {
    let owner = login;
    if (owner === undefined) {
      let latest: LogState['logins'][number] | undefined;
      for (const line of logins) if (line.at <= reading.at && (!latest || line.at >= latest.at)) latest = line;
      owner = latest ? latest.login : saved;
    }
    if (owner) assigned.push({ login: owner, reading });
  }
  return assigned;
}

function localDay(at: number, offset = 0): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
}

/**
 * Keeps each account's earliest reading and the last reading of each local day, for 35 days,
 * plus the newest older reading while newer ones remain, since the oldest day kept counts from it.
 * Readings stamped later than `now` are dropped, since they would stay the latest.
 */
export function addReadings(records: Records, added: Array<{ login: string; reading: Reading }>, now: number): Records {
  const cutoff = localDay(now, -DAYS_KEPT);
  const next: Records = {};
  for (const login of new Set([...Object.keys(records), ...added.map((entry) => entry.login)])) {
    const saved = Object.hasOwn(records, login) ? records[login] : [];
    const readings = [...saved, ...added.filter((entry) => entry.login === login).map((entry) => entry.reading)]
      .filter((reading) => reading.at <= now)
      .sort((a, b) => a.at - b.at)
      .filter((reading, index, sorted) => index === 0 || reading.at !== sorted[index - 1].at);
    const recent = readings.findIndex((reading) => reading.at >= cutoff);
    const all = recent < 0 ? [] : readings.slice(Math.max(0, recent - 1));
    const kept = all.filter((reading, index) =>
      index === 0 || index === all.length - 1 || localDay(reading.at) !== localDay(all[index + 1].at));
    if (kept.length) next[login] = kept;
  }
  return next;
}

/** The account Copilot reported for last. */
export function currentAccount(records: Records): string | undefined {
  let current: string | undefined;
  for (const [login, readings] of Object.entries(records)) {
    if (!current || readings.at(-1)!.at > records[current].at(-1)!.at) current = login;
  }
  return current;
}

/** The share of the allowance used, past 100 once spending goes beyond the allowance. */
function used(reading: Reading): number {
  const overage = reading.quota > 0 ? (reading.additionalUsageUsed ?? 0) / reading.quota * 100 : 0;
  return 100 - reading.percentRemaining + overage;
}

function resetAt(reading: Reading): number {
  return reading.resetDate === undefined ? Infinity : Date.parse(reading.resetDate);
}

/** The allowance has reset since the latest reading, and Copilot has not reported again. */
function expired(latest: Reading, now: number): boolean {
  return latest.at < resetAt(latest) && now >= resetAt(latest);
}

/**
 * `later` belongs to a newer allowance period. Copilot invents a reset date a month ahead when the
 * server sends none, so only a passed reset date counts.
 */
function newPeriod(earlier: Reading, later: Reading): boolean {
  return later.resetDate !== earlier.resetDate && later.at >= resetAt(earlier);
}

/**
 * The local day's last reading minus the last one before that day, counting from zero across a
 * reset; `undefined` before the account's first reading.
 */
function usedOn(readings: Reading[], day: number): number | undefined {
  const latest = readings.filter((reading) => reading.at < localDay(day, 1)).at(-1);
  if (!latest) return;
  // Until an account has a reading before the day, the day counts from its first reading.
  const base = readings.filter((reading) => reading.at < day).at(-1) ?? readings[0];
  return Math.max(0, used(latest) - (newPeriod(base, latest) ? 0 : used(base)));
}

/** The latest reading minus the last one before local midnight, counting from zero across a reset. */
export function todayUsed(readings: Reading[], now: number): number {
  const latest = readings.at(-1);
  return !latest || expired(latest, now) ? 0 : usedOn(readings, localDay(now)) ?? 0;
}

/** Each of the last 30 local days, oldest first, with its use; today's matches `todayUsed`. */
export function dailyUsed(readings: Reading[], now: number): Array<{ day: number; used?: number }> {
  const today = localDay(now);
  return Array.from({ length: 30 }, (_, index) => {
    const day = localDay(now, index - 29);
    return { day, used: day === today ? todayUsed(readings, now) : usedOn(readings, day) };
  });
}

export function monthUsed(readings: Reading[], now: number): number {
  const latest = readings.at(-1);
  return !latest || expired(latest, now) ? 0 : used(latest);
}

/**
 * The share used by the reset if the average use so far continues, projected from the reading's
 * own time. Only a reset at the start of the next UTC month marks a known period.
 */
export function monthlyPace(reading: Reading, now: number): number | undefined {
  const observed = new Date(reading.at);
  const start = Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), 1);
  const end = Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1);
  if (resetAt(reading) !== end || reading.at <= start || now >= end) return;
  return used(reading) * (end - start) / (reading.at - start);
}

/** At most one decimal without a trailing zero, and a non-breaking space between thousands. */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 }).replaceAll(',', '\u00a0');
}

/**
 * `3.1% • 76.5/100%`: today's share of the allowance, then the month used. `needsRestart` means
 * this window's Copilot Chat channel is not at Trace, so its chats log no quota until VS Code restarts.
 */
export function statusText(records: Records, now: number, needsRestart = false): string {
  const login = currentAccount(records);
  const readings = login ? records[login] : [];
  const latest = readings.at(-1);
  if (!latest) return needsRestart ? 'Restart to see Credit usage' : 'Waiting for Copilot';
  if (latest.unlimited) return 'Unlimited Copilot quota';
  if (latest.quota <= 0) return 'No Copilot credit allowance';
  const month = monthUsed(readings, now);
  const period = month > 100 ? `100/${formatNumber(month)}%` : `${formatNumber(month)}/100%`;
  return `${formatNumber(todayUsed(readings, now))}% • ${period}`;
}

/** Saved records, with anything malformed dropped. */
export function loadRecords(value: unknown): Records {
  const records: Records = {};
  if (typeof value !== 'object' || value === null) return records;
  for (const [login, list] of Object.entries(value)) {
    if (!LOGIN.test(login)) continue;
    const readings = (Array.isArray(list) ? list : [])
      .map((entry) => toReading((entry as { at?: unknown } | null)?.at, entry))
      .filter((reading): reading is Reading => reading !== undefined)
      .sort((a, b) => a.at - b.at);
    if (readings.length) records[login] = readings;
  }
  return records;
}
