import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One server-reported allowance percentage, as logged by Copilot at `at`. */
export interface QuotaObservation {
  account: string;
  at: number;
  percentRemaining: number;
  resetDate?: string;
}

/**
 * Allowance consumed during one local calendar day. `used` is undefined when
 * nothing can be assigned to the day. `incomplete` means usage from an
 * unobserved interval inside or next to this day may be missing from `used`.
 */
export interface DailyUsage {
  day: number;
  used?: number;
  incomplete: boolean;
}

const MAX_READ_BYTES = 8 * 1024 * 1024;

export function localDayStart(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function addDays(day: number, count: number): number {
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count).getTime();
}

function used(observation: QuotaObservation): number {
  return 100 - observation.percentRemaining;
}

/**
 * The later observation is in the same allowance period until the earlier
 * one's reset date passes. Without a reset date, only a percentage that has
 * not dropped can belong to the same period.
 */
function samePeriod(earlier: QuotaObservation, later: QuotaObservation): boolean {
  const reset = earlier.resetDate === undefined ? NaN : Date.parse(earlier.resetDate);
  return Number.isNaN(reset) ? used(later) >= used(earlier) : later.at < reset;
}

/** Only an unchanged percentage proves the interval between two observations was idle. */
function idleBetween(earlier: QuotaObservation, later: QuotaObservation): boolean {
  return samePeriod(earlier, later) && later.percentRemaining === earlier.percentRemaining;
}

/**
 * Usage between two observations belongs to a day only when both fall on that
 * day. A day is complete when the neighbouring observations prove the day's
 * unobserved edges were idle. An allowance reset hides what happened around
 * it, so a day touching a reset stays incomplete instead of becoming negative
 * usage.
 */
export function dailyUsage(observations: QuotaObservation[], now: number, days = 30): DailyUsage[] {
  const sorted = [...observations].filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at);
  const today = localDayStart(now);
  const result: DailyUsage[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = addDays(today, -offset);
    const end = addDays(day, 1);
    const own = sorted.filter((entry) => entry.at >= day && entry.at < end);
    const previous = sorted.filter((entry) => entry.at < day).at(-1);
    const next = sorted.find((entry) => entry.at >= end);
    if (own.length === 0) {
      const idle = previous !== undefined && next !== undefined && idleBetween(previous, next);
      result.push(idle ? { day, used: 0, incomplete: false } : { day, incomplete: true });
      continue;
    }
    // A stale lower value can arrive after the real one, so each period counts its peak.
    let total = 0;
    let first = own[0];
    let peak = used(first);
    let resetInside = false;
    for (let index = 1; index < own.length; index++) {
      const entry = own[index];
      if (samePeriod(first, entry)) {
        peak = Math.max(peak, used(entry));
      } else {
        total += peak - used(first);
        first = entry;
        peak = used(entry);
        resetInside = true;
      }
    }
    total += peak - used(first);
    const startComplete = previous !== undefined && idleBetween(previous, own[0]);
    const endComplete = day === today || (next !== undefined && idleBetween(own[own.length - 1], next));
    // Server percentages carry a few decimals; drop binary floating-point drift.
    result.push({ day, used: Number(total.toFixed(6)), incomplete: !startComplete || !endComplete || resetInside });
  }
  return result;
}

/**
 * Shared append-only journal of allowance percentages. Every window appends
 * whole lines to the same file, so nothing is ever rewritten or reset. A
 * percentage is saved when it differs from the account's latest one or starts
 * a new local day, so idle repeats collapse while a value that returns after a
 * stale lower one still corrects the day's last observation.
 */
export class QuotaHistory {
  private readonly known = new Map<string, QuotaObservation[]>();
  private readonly keys = new Set<string>();
  /** Byte offset of the last complete line already loaded. */
  private loaded = 0;
  /** Last journal failure; the graph keeps showing what was read before it. */
  problem: string | undefined;

  constructor(private readonly file: string, private readonly maxReadBytes = MAX_READ_BYTES) {}

  get(account: string): QuotaObservation[] {
    return this.known.get(account.toLowerCase()) ?? [];
  }

  /** Never throws: a journal failure must not hide the quota itself. */
  async record(observations: QuotaObservation[]): Promise<void> {
    const additions: QuotaObservation[] = [];
    try {
      await this.load();
      for (const observation of [...observations].sort((a, b) => a.at - b.at)) {
        const entry = { ...observation, account: observation.account.toLowerCase() };
        if (this.remember(entry)) additions.push(entry);
      }
      if (additions.length > 0) {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, additions.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
      }
      this.problem = undefined;
    } catch (error) {
      // Forget what was not saved so the next log parse can retry the append.
      for (const entry of additions) this.forget(entry);
      this.problem = `Daily usage history: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private remember(entry: QuotaObservation): boolean {
    const key = `${entry.account}|${entry.at}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    const list = this.known.get(entry.account) ?? [];
    const latest = list.at(-1);
    if (latest && localDayStart(latest.at) === localDayStart(entry.at) &&
      latest.percentRemaining === entry.percentRemaining && latest.resetDate === entry.resetDate) return false;
    // Other windows' lines can arrive late; keep the list in time order so `latest` stays the newest.
    let index = list.length;
    while (index > 0 && list[index - 1].at > entry.at) index--;
    list.splice(index, 0, entry);
    this.known.set(entry.account, list);
    return true;
  }

  private forget(entry: QuotaObservation): void {
    this.keys.delete(`${entry.account}|${entry.at}`);
    const list = this.known.get(entry.account) ?? [];
    this.known.set(entry.account, list.filter((known) => known !== entry));
  }

  /**
   * Resumes after the last complete line. The file only grows, so a bounded
   * read of its newest bytes always covers the graph's window; a larger jump
   * skips the partial line it lands in.
   */
  private async load(): Promise<void> {
    let handle;
    try {
      handle = await open(this.file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (info.size < this.loaded) this.loaded = 0;
      if (info.size === this.loaded) return;
      const start = Math.max(this.loaded, info.size - this.maxReadBytes);
      const buffer = Buffer.alloc(info.size - start);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const complete = buffer.subarray(0, read).lastIndexOf(10) + 1;
      const lines = buffer.toString('utf8', 0, complete).split('\n');
      if (start > this.loaded) lines.shift();
      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) this.remember(entry);
      }
      // Another window may still be appending; a partial tail is reread later.
      this.loaded = start + complete;
    } finally {
      await handle.close();
    }
  }
}

/** Malformed lines are skipped, never repaired or removed. */
function parseLine(line: string): QuotaObservation | undefined {
  if (!line.trim()) return;
  try {
    const value = JSON.parse(line) as Partial<QuotaObservation>;
    if (typeof value.account !== 'string' || !value.account || typeof value.at !== 'number' || !Number.isFinite(value.at) ||
      typeof value.percentRemaining !== 'number' || !Number.isFinite(value.percentRemaining) ||
      (value.resetDate !== undefined && typeof value.resetDate !== 'string')) return;
    return { account: value.account, at: value.at, percentRemaining: value.percentRemaining,
      ...(value.resetDate !== undefined ? { resetDate: value.resetDate } : {}) };
  } catch { return; }
}
