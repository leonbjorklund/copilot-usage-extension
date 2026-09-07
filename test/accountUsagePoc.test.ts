import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, appendFile: vi.fn(fs.appendFile), writeFile: vi.fn(fs.writeFile), readFile: vi.fn(fs.readFile) };
});

import { aggregateUsage } from '../src/core/aggregator';
import type { UsageRecord } from '../src/core/types';
import { AccountUsagePoc, attributeRequest, parseAccountEvidence, trackedUsageQuota } from '../src/dev/accountUsagePoc';

const base = new Date(2026, 8, 7, 12).getTime();
const roots: string[] = [];

function line(at: number, message: string): string {
  const d = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} [info] ${message}\n`;
}

function auth(account: string, at = base - 10_000): string {
  return line(at, `Logged in as ${account}`) + line(at + 100, `Got Copilot token for ${account}`);
}

function record(filePath = '/usage/debug-logs/chat/main.jsonl', at = base + 10_000, id = 'request-1'): UsageRecord {
  return { filePath, chatId: 'chat', title: 'A chat', model: 'model', timestamp: new Date(at),
    tokens: { input: 80, output: 20, cachedInput: 10, cacheWriteInput: 0, total: 100, source: 'recorded' },
    billing: { aiCredits: 2, source: 'copilot-debug-log' },
    debugRequest: { responseId: id, spanId: String(at), durationMs: 1_000 } };
}

function done(row: UsageRecord): string {
  return line(row.timestamp.getTime() + row.debugRequest!.durationMs,
    `request done: requestId: [${row.debugRequest!.responseId}] model deployment ID: []`);
}

afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(appendFile).mockImplementation(fs.appendFile);
  vi.mocked(writeFile).mockImplementation(fs.writeFile);
  vi.mocked(readFile).mockImplementation(fs.readFile);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('request attribution', () => {
  it.skipIf(process.platform !== 'win32')('treats Windows drive-letter casing as one window', () => {
    const row = record();
    const text = auth('Alice') + done(row);
    const evidence = [...parseAccountEvidence(text, 'C:\\logs\\window1'), ...parseAccountEvidence(text, 'c:\\logs\\window1')];
    expect(attributeRequest(row, base, evidence, base + 30_000)).toEqual({ account: 'alice' });
  });

  it('matches the successful request summary when the transport emits no request-done line', () => {
    const row = { ...record(), model: 'mai-code-1.1-flash' };
    row.debugRequest!.durationMs = 6167;
    const text = auth('Alice') + line(base + 16_168,
      'ccreq:0b641048.copilotmd | success | mai-code-1.1-flash | 6168ms | [panel/editAgent]');
    expect(attributeRequest(row, base, parseAccountEvidence(text, 'one'), base + 30_000)).toEqual({ account: 'alice' });
  });

  it('uses each originating window, not the selected account or shared request ID', () => {
    const a = record();
    const b = record(a.filePath, base + 20_000);
    const evidence = [...parseAccountEvidence(auth('Alice') + done(a), 'one'), ...parseAccountEvidence(auth('Bob') + done(b), 'two')];
    expect(attributeRequest(a, base, evidence, base + 30_000)).toEqual({ account: 'alice' });
    expect(attributeRequest(b, base, evidence, base + 30_000)).toEqual({ account: 'bob' });
  });

  it('rejects ambiguous or mismatched successful summaries', () => {
    const a = record();
    const summary = line(base + 11_000, 'ccreq:abc.copilotmd | success | model | 1000ms | [panel/editAgent]');
    const evidence = parseAccountEvidence(auth('Alice') + summary, 'one');
    const other = parseAccountEvidence(auth('Bob') + summary, 'two');
    expect(attributeRequest(a, base, [...evidence, ...other], base + 30_000)).toHaveProperty('pending');
    const b = { ...a, debugRequest: { ...a.debugRequest!, spanId: 'other-span' } };
    expect(attributeRequest(a, base, evidence, base + 30_000, [a, b])).toHaveProperty('pending');
    expect(attributeRequest({ ...a, model: 'other-model' }, base, evidence, base + 30_000)).toHaveProperty('pending');
    expect(attributeRequest(record(a.filePath, base + 10_100), base, evidence, base + 30_000)).toHaveProperty('pending');
    const failed = parseAccountEvidence(auth('Alice') + summary.replace('success', 'failed'), 'one');
    expect(attributeRequest(a, base, failed, base + 30_000)).toHaveProperty('pending');
  });

  it('waits for delayed, missing, and cross-window ambiguous completions', () => {
    const a = record();
    const evidence = parseAccountEvidence(auth('Alice') + done(a), 'one');
    expect(attributeRequest(a, base, evidence, base + 11_000)).toHaveProperty('pending');
    expect(attributeRequest(a, base, [], base + 30_000)).toHaveProperty('pending');
    expect(attributeRequest(a, base, [...evidence, ...parseAccountEvidence(auth('Bob') + done(a), 'two')], base + 30_000)).toHaveProperty('pending');
  });

  it('does not turn an attempted or failed sign-in into account ownership', () => {
    const a = record();
    const evidence = parseAccountEvidence(line(base, 'Logged in as Alice') + done(a), 'one');
    expect(attributeRequest(a, base, evidence, base + 30_000)).toHaveProperty('pending');
    const failed = parseAccountEvidence(auth('Alice') + line(base, 'GitHub login failed') + done(a), 'one');
    expect(attributeRequest(a, base, failed, base + 30_000)).toHaveProperty('excluded');
  });

  it('excludes in-flight switches and continued chats, including switches back', () => {
    const a = record();
    const switching = parseAccountEvidence(auth('Alice') + auth('Bob', base + 10_500) + done(a), 'one');
    expect(attributeRequest(a, base, switching, base + 30_000)).toHaveProperty('excluded');
    const continued = parseAccountEvidence(auth('Alice') + auth('Bob', base + 3_000) + done(a), 'one');
    expect(attributeRequest(a, base, continued, base + 30_000)).toHaveProperty('excluded');
    expect(attributeRequest(a, base + 7_000, continued, base + 30_000)).toEqual({ account: 'bob' });
    const back = parseAccountEvidence(auth('Alice') + auth('Bob', base + 3_000) + auth('Alice', base + 6_000) + done(a), 'one');
    expect(attributeRequest(a, base, back, base + 30_000)).toHaveProperty('excluded');
  });

  it('accepts routine token renewal without treating it as a switch', () => {
    const a = record();
    const evidence = parseAccountEvidence(auth('Alice') + auth('Alice', base + 10_100) + done(a), 'one');
    expect(attributeRequest(a, base, evidence, base + 30_000)).toEqual({ account: 'alice' });
  });

  it('separates live capacity from tracked period spending', () => {
    const summary = aggregateUsage([record()], new Date(base + 30_000));
    const quota = { entitlement: 100, remaining: 1, percentRemaining: 1, overageCount: 0, unlimited: false };
    expect(trackedUsageQuota(quota, summary)).toMatchObject({ entitlement: 100, remaining: 98, percentRemaining: 98 });
    expect(quota.remaining).toBe(1);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilot-account-poc-'));
  roots.push(root);
  const storage = join(root, 'ledger');
  const logRoot = join(root, 'logs');
  const stream = join(logRoot, '20260907T110000', 'window1', 'exthost', 'GitHub.copilot-chat');
  await mkdir(stream, { recursive: true });
  const log = join(stream, 'GitHub Copilot Chat.log');
  await writeFile(log, auth('Alice'));
  const usage = join(root, 'debug-logs', 'chat', 'main.jsonl');
  await mkdir(join(root, 'debug-logs', 'chat'), { recursive: true });
  await writeFile(usage, JSON.stringify({ type: 'session_start', ts: base + 1_000 }) + '\n');
  const poc = new AccountUsagePoc(storage, stream, [logRoot]);
  await poc.refresh(aggregateUsage([], new Date(base)), new Date(base));
  return { root, storage, logRoot, stream, log, usage, poc };
}

describe('local POC ledger', () => {
  it('does not reread unchanged, validated journals on every refresh', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    await f.poc.refresh(summary, new Date(base + 30_000));
    await f.poc.refresh(summary, new Date(base + 30_000));
    vi.mocked(readFile).mockClear();
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    expect(vi.mocked(readFile).mock.calls.filter(([file]) => String(file).endsWith('.jsonl'))).toHaveLength(0);
  });

  it.each([false, true])('recovers a delayed session start across restart, failed append: %s', async (failAppend) => {
    const f = await fixture();
    await appendFile(f.log, auth('Bob', base + 3_000));
    await writeFile(f.usage, '');
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(0);
    await writeFile(f.usage, JSON.stringify({ type: 'session_start', ts: base + 7_000 }) + '\n');
    if (failAppend) {
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
        await fs.appendFile(file, String(data).slice(0, 20));
        throw new Error('Simulated interrupted header write');
      });
      await expect(f.poc.refresh(aggregateUsage([]), new Date(base + 30_000))).rejects.toThrow('Simulated interrupted header write');
    }
    const recovered = await f.poc.refresh(aggregateUsage([]), new Date(base + 30_000));
    expect(recovered.excluded).toBe(0);
    expect(recovered.summary.allTime.tokens).toBe(100);
    await rm(f.usage);
    const restarted = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
  });

  it('retries a complete-line snapshot shorter than the file metadata without another log write', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let interrupted = false;
    vi.mocked(readFile).mockImplementation(async (file, options) => {
      if (!interrupted && String(file).toLowerCase() === f.log.toLowerCase()) {
        interrupted = true;
        // A writer can replace/truncate a file between its stat and read.
        return Buffer.from(auth('Alice'));
      }
      return fs.readFile(file, options);
    });
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).pending).toBe(1);
    const caughtUp = await f.poc.refresh(summary, new Date(base + 30_000));
    expect(caughtUp.pending).toBe(0);
    expect(caughtUp.summary.allTime.tokens).toBe(100);
  });

  it('starts simultaneous observers without reading a half-written tracking start', async () => {
    const f = await fixture();
    const storage = join(f.root, 'fresh-ledger');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let created!: () => void;
    let finishWrite!: () => void;
    const fileCreated = new Promise<void>((resolve) => { created = resolve; });
    const canFinish = new Promise<void>((resolve) => { finishWrite = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (file, data) => {
      await fs.writeFile(file, '', { flag: 'wx' });
      created();
      await canFinish;
      await fs.writeFile(file, data);
    });
    const first = new AccountUsagePoc(storage, f.stream, [f.logRoot]);
    const second = new AccountUsagePoc(storage, f.stream, [f.logRoot]);
    const firstRefresh = first.refresh(aggregateUsage([]), new Date(base));
    await fileCreated;
    const other = await second.refresh(aggregateUsage([]), new Date(base + 1))
      .then((view) => ({ view }), (error: unknown) => ({ error }));
    finishWrite();
    const view = await firstRefresh;
    expect(other).toHaveProperty('view');
    if ('view' in other) expect(other.view.startedAt).toEqual(view.startedAt);
  });

  it('recovers after a failed partial journal append without losing or duplicating usage', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
      await fs.appendFile(file, String(data).slice(0, 20));
      throw new Error('Simulated interrupted write');
    });

    await expect(f.poc.refresh(summary, new Date(base + 30_000))).rejects.toThrow('Simulated interrupted write');
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    const restarted = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
  });

  it('follows a managed account login with an underscore instead of retaining the previous account', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    await appendFile(f.log, auth('Bob_company', base + 40_000));
    const switched = await f.poc.refresh(summary, new Date(base + 45_000));
    expect(switched.account).toBe('bob_company');
    expect(switched.summary.allTime.tokens).toBe(0);
    expect(switched.problem).toBeUndefined();
  });
  it.skipIf(process.platform !== 'win32')('deduplicates saved billed requests whose file path casing differs', async () => {
    const f = await fixture();
    const a = record(f.usage);
    const b = { ...a, filePath: f.usage.toLowerCase() };
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a, b]);
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    // Reproduce the old observer's duplicate entry without resetting its ledger.
    const oldKey = createHash('sha256').update(JSON.stringify([
      resolve(b.filePath), b.timestamp.getTime(), b.debugRequest!.spanId,
      b.debugRequest!.responseId, b.debugRequest!.durationMs, b.model,
    ])).digest('hex');
    await writeFile(join(f.storage, 'observer-abcdef.jsonl'), JSON.stringify({ kind: 'bill', key: oldKey, record: b, sessionStart: base + 1_000 }) + '\n');
    const restarted = new AccountUsagePoc(f.storage, f.stream.toLowerCase(), [f.logRoot]);
    expect((await restarted.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
  });

  it('starts fresh and retries delayed evidence without dropping or double counting usage', async () => {
    const f = await fixture();
    const old = record(f.usage, base - 1);
    const current = record(f.usage);
    const summary = aggregateUsage([old, current], new Date(base + 30_000));
    const pending = await f.poc.refresh(summary, new Date(base + 30_000));
    expect(pending.pending).toBe(1);
    expect(pending.problem).toBeUndefined();
    expect(pending.summary.allTime.tokens).toBe(0);
    const completion = done(current);
    await appendFile(f.log, completion.slice(0, -1));
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).pending).toBe(1);
    await appendFile(f.log, '\n');
    const resolved = await f.poc.refresh(summary, new Date(base + 30_000));
    expect(resolved.problem).toBeUndefined();
    expect(resolved.summary.allTime.tokens).toBe(100);
    expect(resolved.summary.month.githubCopilot.usd).toBe(0.02);
    expect(resolved.summary.topModels[0].sessions).toBe(1);
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
  });

  it('survives restart and log cleanup using saved evidence and usage', async () => {
    const f = await fixture();
    const current = record(f.usage);
    await appendFile(f.log, line(base + 11_001, 'ccreq:abc.copilotmd | success | model | 1001ms | [panel/editAgent]'));
    await f.poc.refresh(aggregateUsage([current]), new Date(base + 30_000));
    await rm(f.log);
    const restarted = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    const view = await restarted.refresh(aggregateUsage([]), new Date(base + 60_000));
    expect(view.startedAt.getTime()).toBe(base);
    expect(view.summary.allTime.tokens).toBe(100);
    expect(view.pending).toBe(0);
    const saved = (await readdir(f.storage)).filter((p) => p.endsWith('.jsonl'));
    const text = (await Promise.all(saved.map((p) => readFile(join(f.storage, p), 'utf8')))).join('');
    expect(text).not.toContain('accessToken');
    expect(text).not.toContain('inputMessages');
  });

  it('keeps catch-up requests with missing old logs in diagnostics without permanent waiting', async () => {
    const f = await fixture();
    const saved = record(f.usage);
    await appendFile(f.log, done(saved));
    await f.poc.refresh(aggregateUsage([saved]), new Date(base + 30_000));
    await rm(f.log);

    const stream = join(f.logRoot, '20260907T130000', 'window1', 'exthost', 'GitHub.copilot-chat');
    await mkdir(stream, { recursive: true });
    const log = join(stream, 'GitHub Copilot Chat.log');
    await writeFile(log, auth('Alice', base + 3_600_000));
    const missed = record(f.usage, base + 60_000, 'missed-request');
    const fresh = record(f.usage, base + 3_610_000, 'fresh-request');
    await appendFile(log, done(fresh));
    const summary = aggregateUsage([saved, missed, fresh]);
    const restarted = new AccountUsagePoc(f.storage, stream, [f.logRoot]);
    const now = new Date(base + 3_630_000);
    const view = await restarted.refresh(summary, now);

    expect(view.problem).toBeUndefined();
    expect(view.pending).toBe(1);
    expect(view.diagnostics).toContain('unresolved requests: 1');
    expect(view.summary.allTime.tokens).toBe(200);
    expect(view.summary.chats.flatMap((chat) => chat.records).map((row) => row.debugRequest?.responseId)).not.toContain('missed-request');
    expect((await new AccountUsagePoc(f.storage, stream, [f.logRoot]).refresh(aggregateUsage([]), now)).problem).toBeUndefined();

    // Evidence restored later can still resolve the request; it was not lost
    // or assigned to whichever account happened to open the new window.
    const recoveredEvidence = parseAccountEvidence(auth('Alice') + done(saved) + done(missed), f.stream);
    await writeFile(join(f.storage, 'observer-abcdef.jsonl'),
      recoveredEvidence.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const recovered = await restarted.refresh(summary, now);
    expect(recovered.pending).toBe(0);
    expect(recovered.summary.allTime.tokens).toBe(300);
  });

  it('shares observations across preview processes and follows the selected window', async () => {
    const f = await fixture();
    const other = join(f.logRoot, '20260907T110000', 'window2', 'exthost', 'GitHub.copilot-chat');
    await mkdir(other, { recursive: true });
    const a = record(f.usage);
    const b = { ...record(f.usage, base + 20_000), tokens: { ...a.tokens, total: 200 }, billing: { ...a.billing!, aiCredits: 5 } };
    await appendFile(f.log, done(a));
    await writeFile(join(other, 'GitHub Copilot Chat.log'), auth('Bob') + done(b));
    const second = new AccountUsagePoc(f.storage, other, [f.logRoot]);
    const summary = aggregateUsage([a, b]);
    const [alice, bob] = await Promise.all([
      f.poc.refresh(summary, new Date(base + 30_000)), second.refresh(summary, new Date(base + 30_000)),
    ]);
    expect(alice.summary.allTime.tokens).toBe(100);
    expect(bob.summary.allTime.tokens).toBe(200);
    await appendFile(f.log, auth('Bob', base + 40_000));
    const switched = await f.poc.refresh(summary, new Date(base + 45_000));
    expect(switched.account).toBe('bob');
    expect(switched.summary.allTime.tokens).toBe(200);
    expect(switched.summary.allTime.githubCopilot.aiCredits).toBe(5);
    expect(switched.summary.chats).toHaveLength(1);
  });

  it('reads rotated logs and revokes inference when delayed conflicting evidence appears', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await writeFile(join(f.stream, 'GitHub Copilot Chat.1.log'), auth('Alice') + done(a));
    const summary = aggregateUsage([a]);
    expect((await f.poc.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    await appendFile(f.log, auth('Bob', base + 10_500));
    const revised = await f.poc.refresh(summary, new Date(base + 35_000));
    expect(revised.excluded).toBe(1);
    expect(revised.summary.allTime.tokens).toBe(0);
  });

  it('keeps failing on corrupt persisted evidence and never resets the start date', async () => {
    const f = await fixture();
    await writeFile(join(f.storage, 'observer-abcdef.jsonl'), '{broken}\n');
    await expect(f.poc.refresh(aggregateUsage([]))).rejects.toThrow();
    await expect(f.poc.refresh(aggregateUsage([]))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(f.storage, 'start.json'), 'utf8')).startedAt).toBe(base);
  });
});
