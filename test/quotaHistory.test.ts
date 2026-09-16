import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dailyUsage, localDayStart, QuotaHistory, type QuotaObservation } from '../src/core/quotaHistory';

const reset = '2026-10-01T00:00:00.000Z';
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const now = at(16, 15);
const observe = (day: number, hour: number, usedPercent: number, extra: Partial<QuotaObservation> = {}): QuotaObservation =>
  ({ account: 'alice', at: at(day, hour), percentRemaining: 100 - usedPercent, resetDate: reset, ...extra });
const slot = (usage: ReturnType<typeof dailyUsage>, day: number) =>
  usage.find((entry) => entry.day === at(day, 0))!;

describe('dailyUsage', () => {
  it('returns the latest days ending today, oldest first', () => {
    const usage = dailyUsage([], now);
    expect(usage).toHaveLength(30);
    expect(usage[0].day).toBe(at(16 - 29, 0));
    expect(usage[29].day).toBe(localDayStart(now));
    expect(usage.every((entry) => entry.used === undefined && entry.incomplete)).toBe(true);
  });
  it('assigns the rise between same-day observations to that day', () => {
    const usage = dailyUsage([observe(15, 9, 20), observe(15, 12, 21.5), observe(15, 18, 23), observe(16, 9, 23), observe(16, 11, 24)], now);
    expect(slot(usage, 15)).toEqual({ day: at(15, 0), used: 3, incomplete: true });
    expect(slot(usage, 16)).toEqual({ day: at(16, 0), used: 1, incomplete: false });
  });
  it('never assigns usage from an unknown interval to the day tracking resumes', () => {
    const usage = dailyUsage([observe(14, 10, 20), observe(14, 11, 22), observe(16, 9, 30), observe(16, 12, 31)], now);
    expect(slot(usage, 14)).toEqual({ day: at(14, 0), used: 2, incomplete: true });
    expect(slot(usage, 15)).toEqual({ day: at(15, 0), incomplete: true });
    expect(slot(usage, 16)).toEqual({ day: at(16, 0), used: 1, incomplete: true });
  });
  it('confirms untracked days as idle when surrounding observations did not move', () => {
    const usage = dailyUsage([observe(13, 10, 20), observe(13, 11, 22), observe(15, 9, 22), observe(15, 12, 23)], now);
    expect(slot(usage, 13)).toEqual({ day: at(13, 0), used: 2, incomplete: true });
    expect(slot(usage, 14)).toEqual({ day: at(14, 0), used: 0, incomplete: false });
    expect(slot(usage, 15)).toEqual({ day: at(15, 0), used: 1, incomplete: true });
    expect(slot(usage, 12)).toEqual({ day: at(12, 0), incomplete: true });
  });
  it('keeps a single observation as a complete zero day when its neighbours agree', () => {
    const usage = dailyUsage([observe(14, 23, 20), observe(15, 12, 20), observe(16, 1, 20)], now);
    expect(slot(usage, 15)).toEqual({ day: at(15, 0), used: 0, incomplete: false });
  });
  it('treats an allowance reset as an unknown edge instead of negative usage', () => {
    // The allowance resets at 2026-09-15 00:00 UTC, which is 02:00 local on the 15th.
    const ending = '2026-09-15T00:00:00.000Z';
    const october = '2026-10-01T00:00:00.000Z';
    const observations = [observe(14, 10, 90, { resetDate: ending }), observe(14, 20, 95, { resetDate: ending }),
      observe(15, 9, 1, { resetDate: october }), observe(15, 12, 3, { resetDate: october }), observe(16, 9, 3, { resetDate: october })];
    const usage = dailyUsage(observations, now);
    expect(slot(usage, 14)).toEqual({ day: at(14, 0), used: 5, incomplete: true });
    expect(slot(usage, 15)).toEqual({ day: at(15, 0), used: 2, incomplete: true });
    expect(slot(usage, 16)).toEqual({ day: at(16, 0), used: 0, incomplete: false });
    const sameDay = dailyUsage([observe(15, 0, 95, { resetDate: ending }), observe(15, 1, 96, { resetDate: ending }),
      observe(15, 12, 1, { resetDate: october }), observe(15, 13, 2.5, { resetDate: october })], now);
    expect(slot(sameDay, 15)).toEqual({ day: at(15, 0), used: 2.5, incomplete: true });
    // A stale lower value with the same reset date is not a reset and is not idle proof either.
    const stale = dailyUsage([observe(14, 10, 20), observe(14, 11, 22), observe(15, 9, 21.9), observe(15, 12, 23)], now);
    expect(slot(stale, 14)).toEqual({ day: at(14, 0), used: 2, incomplete: true });
    expect(slot(stale, 15)).toEqual({ day: at(15, 0), used: 1.1, incomplete: true });
  });
  it('ignores stale lower percentages inside or at the end of a day and future observations', () => {
    const usage = dailyUsage([observe(16, 9, 20), observe(16, 10, 22), observe(16, 11, 21.5), observe(16, 12, 23), observe(16, 16, 40)], now);
    expect(slot(usage, 16)).toEqual({ day: at(16, 0), used: 3, incomplete: true });
    const staleLast = dailyUsage([observe(16, 9, 20), observe(16, 10, 22), observe(16, 11, 21.5)], now);
    expect(slot(staleLast, 16)).toEqual({ day: at(16, 0), used: 2, incomplete: true });
  });
  it('marks yesterday incomplete until a later observation proves it idle afterwards', () => {
    const before = dailyUsage([observe(15, 9, 20), observe(15, 10, 21)], at(15, 23));
    expect(slot(before, 15)).toEqual({ day: at(15, 0), used: 1, incomplete: true });
    const complete = dailyUsage([observe(14, 23, 20), observe(15, 9, 20), observe(15, 10, 21), observe(16, 8, 21)], now);
    expect(slot(complete, 15)).toEqual({ day: at(15, 0), used: 1, incomplete: false });
  });
});

describe('QuotaHistory', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function journal(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'quota-history-'));
    roots.push(root);
    return join(root, 'nested', 'quota-history.jsonl');
  }

  it('collapses idle repeats but keeps a new day, a stale drop, and the value that returns after it', async () => {
    const file = await journal();
    const history = new QuotaHistory(file);
    await history.record([observe(15, 23, 20), observe(16, 9, 20), observe(16, 10, 20), observe(16, 11, 21),
      { account: 'Bob', at: at(16, 9), percentRemaining: 50 }]);
    await history.record([observe(16, 9, 20), observe(16, 12, 21), observe(16, 13, 22)]);
    await history.record([observe(16, 14, 21.5), observe(16, 15, 22)]);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(7);
    expect(history.get('ALICE').map((entry) => entry.at)).toEqual([at(15, 23), at(16, 9), at(16, 11), at(16, 13), at(16, 14), at(16, 15)]);
    expect(history.get('bob')).toEqual([{ account: 'bob', at: at(16, 9), percentRemaining: 50 }]);
  });
  it('merges lines appended by other windows and skips malformed lines without touching the file', async () => {
    const file = await journal();
    const history = new QuotaHistory(file);
    await history.record([observe(15, 9, 20)]);
    const other = new QuotaHistory(file);
    await other.record([observe(15, 12, 21)]);
    await appendFile(file, 'not json\n{"account":"alice","at":"soon","percentRemaining":1}\n');
    await history.record([]);
    expect(history.get('alice').map((entry) => 100 - entry.percentRemaining)).toEqual([20, 21]);
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(4);
    // A stale value in one window, then the other window's earlier correct value: the value returning later is still saved.
    await history.record([observe(15, 14, 20.5)]);
    await other.record([observe(15, 13, 22)]);
    await history.record([observe(15, 14, 22, { at: at(15, 14, 30) })]);
    expect(history.get('alice').map((entry) => 100 - entry.percentRemaining)).toEqual([20, 21, 22, 20.5, 22]);
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(7);
  });
  it('reads a journal that already exists before the first record', async () => {
    const file = await journal();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(observe(15, 9, 20)) + '\n');
    const history = new QuotaHistory(file);
    await history.record([observe(16, 9, 21)]);
    expect(history.get('alice').map((entry) => entry.at)).toEqual([at(15, 9), at(16, 9)]);
  });
});

describe('dailyUsage edge cases from review', () => {
  it('keeps a day incomplete when the allowance resets inside it, even with idle neighbours', () => {
    const ending = '2026-09-15T00:00:00.000Z';
    const october = '2026-10-01T00:00:00.000Z';
    const usage = dailyUsage([observe(14, 23, 61, { resetDate: ending }), observe(15, 1, 61, { resetDate: ending }),
      observe(15, 3, 0, { resetDate: october }), observe(15, 10, 2, { resetDate: october }), observe(16, 8, 2, { resetDate: october })], now);
    expect(slot(usage, 15)).toEqual({ day: at(15, 0), used: 2, incomplete: true });
  });
  it('treats a percentage drop as a reset when the reset date is unknown', () => {
    const usage = dailyUsage([observe(14, 23, 5, { resetDate: undefined }), observe(15, 1, 5, { resetDate: undefined }),
      observe(15, 3, 0, { resetDate: undefined }), observe(15, 10, 2, { resetDate: undefined }), observe(16, 8, 2, { resetDate: undefined })], now);
    expect(slot(usage, 15)).toEqual({ day: at(15, 0), used: 2, incomplete: true });
    expect(slot(usage, 14)).toEqual({ day: at(14, 0), used: 0, incomplete: true });
    expect(slot(usage, 16)).toEqual({ day: at(16, 0), used: 0, incomplete: false });
  });
});

describe('QuotaHistory bounded reads', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  it('reads only the newest bytes of an oversized journal and still appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-history-'));
    roots.push(root);
    const file = join(root, 'quota-history.jsonl');
    const lines = Array.from({ length: 40 }, (_, index) => JSON.stringify(observe(1 + Math.floor(index / 4), index % 4 + 8, index)));
    await writeFile(file, lines.join('\n') + '\n');
    const history = new QuotaHistory(file, 400);
    await history.record([observe(16, 9, 50)]);
    expect(history.problem).toBeUndefined();
    const kept = history.get('alice');
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.length).toBeLessThan(6);
    expect(kept.at(-1)).toMatchObject({ percentRemaining: 50 });
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(41);
  });
  it('resumes after the last complete line and picks up a partial tail once it is finished', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-history-'));
    roots.push(root);
    const file = join(root, 'quota-history.jsonl');
    const history = new QuotaHistory(file);
    await history.record([observe(15, 9, 20)]);
    const partial = JSON.stringify(observe(15, 12, 21));
    await appendFile(file, partial.slice(0, 10));
    await history.record([]);
    expect(history.get('alice')).toHaveLength(1);
    await appendFile(file, partial.slice(10) + '\n');
    await history.record([]);
    expect(history.get('alice').map((entry) => entry.percentRemaining)).toEqual([80, 79]);
  });
  it('reports an unreadable journal without throwing and clears the problem once readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-history-'));
    roots.push(root);
    const file = join(root, 'quota-history.jsonl');
    await mkdir(file);
    const history = new QuotaHistory(file);
    await history.record([observe(15, 9, 20)]);
    expect(history.problem).toMatch(/^Daily usage history: /);
    expect(history.get('alice')).toHaveLength(0);
    await rm(file, { recursive: true });
    await history.record([observe(15, 9, 20)]);
    expect(history.problem).toBeUndefined();
    expect(history.get('alice')).toHaveLength(1);
  });
});
