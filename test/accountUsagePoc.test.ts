import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, appendFile: vi.fn(fs.appendFile), writeFile: vi.fn(fs.writeFile), readFile: vi.fn(fs.readFile) };
});

import { aggregateUsage } from '../src/core/aggregator';
import { TITLE_PRIORITY } from '../src/core/types';
import type { UsageRecord } from '../src/core/types';
import { UsageIndex } from '../src/core/usageIndex';
import { AccountUsagePoc, attributeRequest, parseAccountEvidence } from '../src/dev/accountUsagePoc';

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
  it('retains delayed indexed titles and same-timestamp custom title rewrites', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    await appendFile(f.usage, JSON.stringify({ type: 'llm_request', ts: a.timestamp.getTime(),
      spanId: a.debugRequest!.spanId, dur: a.debugRequest!.durationMs, attrs: {
        debugName: 'panel/editAgent', model: a.model, responseId: a.debugRequest!.responseId,
        inputTokens: 80, outputTokens: 20, copilotUsageNanoAiu: 2_000_000_000,
      } }) + '\n');
    const index = new UsageIndex();
    const options = { config: { dataPath: f.root, maxFileSizeMb: 10, maxScanDepth: 6 }, now: new Date(base + 90_000) };
    const first = await index.rebuild({ roots: [f.root], ...options });
    expect((await f.poc.refresh(first.summary, options.now)).summary.chats[0].title).toBe('chat');
    const titleFile = join(f.root, 'debug-logs', 'chat', 'title-response.jsonl');
    const generatedTitle = (title: string) => JSON.stringify({ type: 'agent_response', ts: base + 20_000,
      attrs: { response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: title }] }]) } }) + '\n';
    await writeFile(titleFile, generatedTitle('Generated title'));
    await utimes(titleFile, new Date(base + 21_000), new Date(base + 21_000));
    const generated = await index.poll(options);
    expect((await f.poc.refresh(generated.summary, options.now)).summary.chats[0].title).toBe('Generated title');
    await appendFile(titleFile, generatedTitle('Later generated title'));
    await utimes(titleFile, new Date(base + 22_000), new Date(base + 22_000));
    const appended = await index.poll(options);
    expect((await f.poc.refresh(appended.summary, options.now)).summary.chats[0].title).toBe('Later generated title');
    // Unrelated appends must not make an older title look newer on a full scan.
    await appendFile(titleFile, '{}\n');
    await utimes(titleFile, new Date(base + 23_000), new Date(base + 23_000));
    const rebuilt = await index.rebuild({ roots: [f.root], ...options });
    expect((await f.poc.refresh(rebuilt.summary, options.now)).summary.chats[0].title).toBe('Later generated title');
    const savedGenerated = await new AccountUsagePoc(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), options.now);
    expect(savedGenerated.summary.chats[0].title).toBe('Later generated title');
    const customFile = join(f.root, 'chatSessions', 'chat.json');
    await mkdir(join(f.root, 'chatSessions'));
    const customTitle = (title: string) => JSON.stringify({ kind: 0, v: { sessionId: 'chat', customTitle: title, creationDate: base } });
    await writeFile(customFile, customTitle('Custom title'));
    await utimes(customFile, new Date(base + 30_000), new Date(base + 30_000));
    const custom = await index.poll(options);
    expect((await f.poc.refresh(custom.summary, options.now)).summary.chats[0].title).toBe('Custom title');
    await writeFile(customFile, customTitle('Renamed chat'));
    await utimes(customFile, new Date(base + 40_000), new Date(base + 40_000));
    const renamed = await index.poll(options);
    expect(renamed.summary.chats[0].title).toBe('Renamed chat');
    const view = await f.poc.refresh(renamed.summary, options.now);
    expect(view.summary.chats[0].title).toBe('Renamed chat');
    expect(view.summary.allTime.tokens).toBe(100);
    expect(view.summary.allTime.githubCopilot.aiCredits).toBe(2);
    const restarted = await new AccountUsagePoc(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), options.now);
    expect(restarted.summary.chats[0].title).toBe('Renamed chat');
  });

  it.each([false, true])('keeps delayed chat titles after restart, restarted before title: %s', async (restartBeforeTitle) => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'panel/editAgent', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 30_000);
    const first = await f.poc.refresh(aggregateUsage([a]), now);
    expect(first.summary.chats[0].title).toBe('chat');
    const observer = restartBeforeTitle ? new AccountUsagePoc(f.storage, f.stream, [f.logRoot]) : f.poc;
    const title = { ...a, title: 'Generated chat title', titlePriority: TITLE_PRIORITY.generated,
      timestamp: new Date(base + 20_000), metadataOnly: true };
    const titled = aggregateUsage([a, title]);
    expect(titled.chats[0].title).toBe('Generated chat title');
    const updated = await observer.refresh(titled, now);
    expect(updated.summary.chats[0].title).toBe('Generated chat title');
    expect(updated.summary.allTime).toEqual(first.summary.allTime);
    const restarted = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), now)).summary.chats[0].title).toBe('Generated chat title');
  });

  it('preserves title priority and saved billing when title sources change', async () => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'panel/editAgent', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const first = await f.poc.refresh(aggregateUsage([a]), now);
    const stages = [
      ['First prompt', TITLE_PRIORITY.prompt, base + 20_000, 'First prompt'],
      ['Earlier prompt', TITLE_PRIORITY.prompt, base + 15_000, 'Earlier prompt'],
      ['Later prompt', TITLE_PRIORITY.prompt, base + 30_000, 'Earlier prompt'],
      ['Generated title', TITLE_PRIORITY.generated, base + 40_000, 'Generated title'],
      ['Custom title', TITLE_PRIORITY.custom, base + 50_000, 'Custom title'],
      ['Later generated title', TITLE_PRIORITY.generated, base + 60_000, 'Custom title'],
      ['Renamed custom title', TITLE_PRIORITY.custom, base + 70_000, 'Renamed custom title'],
      ['Child title', TITLE_PRIORITY.childRun, base + 80_000, 'Renamed custom title'],
    ] as const;
    for (const [title, priority, at, expected] of stages) {
      const metadata = { ...a, title, titlePriority: priority, timestamp: new Date(at), metadataOnly: true };
      const rescanned = { ...a, tokens: { ...a.tokens, total: 999 }, billing: { ...a.billing, aiCredits: 999 } };
      const view = await f.poc.refresh(aggregateUsage([rescanned, metadata]), now);
      expect(view.summary.chats[0].title).toBe(expected);
      expect(view.summary.allTime).toEqual(first.summary.allTime);
    }
    const restarted = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    const saved = await restarted.refresh(aggregateUsage([]), now);
    expect(saved.summary.chats[0].title).toBe('Renamed custom title');
    expect(saved.summary.allTime).toEqual(first.summary.allTime);
  });

  it('ignores stale title revisions across observers and preserves existing journals', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const metadata = { ...a, metadataOnly: true, titlePriority: TITLE_PRIORITY.custom,
      timestamp: new Date(base + 20_000), titleModifiedAt: base + 30_000, title: 'Old title' };
    const stale = aggregateUsage([a, metadata]);
    await f.poc.refresh(stale, now);
    const oldFiles = (await readdir(f.storage)).filter((file) => file.endsWith('.jsonl'));
    const oldJournal = await readFile(join(f.storage, oldFiles[0]), 'utf8');
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    const newer = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    const fresh = aggregateUsage([a, { ...metadata, title: 'New title', titleModifiedAt: base + 40_000 }]);
    expect((await newer.refresh(fresh, now)).summary.chats[0].title).toBe('New title');
    expect(await readFile(join(f.storage, oldFiles[0]), 'utf8')).toBe(oldJournal);
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
    // Put stale entries after all normal observer names to exercise replay order.
    await writeFile(join(f.storage, 'observer-ffffffff.jsonl'), oldJournal);
    vi.mocked(appendFile).mockClear();
    expect((await f.poc.refresh(stale, now)).summary.chats[0].title).toBe('New title');
    expect((await newer.refresh(fresh, now)).summary.chats[0].title).toBe('New title');
    expect(appendFile).not.toHaveBeenCalled();
    const restarted = await new AccountUsagePoc(f.storage, f.stream, [f.logRoot]).refresh(stale, now);
    expect(restarted.summary.chats[0].title).toBe('New title');
    expect(restarted.summary.allTime.tokens).toBe(100);
  });

  it('retains legacy labels against lower-priority sources and accepts a custom rename', async () => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'panel/editAgent', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 30_000);
    await f.poc.refresh(aggregateUsage([a]), now);
    const journalFile = join(f.storage, (await readdir(f.storage)).find((file) => file.endsWith('.jsonl'))!);
    const entries = (await readFile(journalFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const bill = entries.find((entry) => entry.kind === 'bill');
    bill.record.title = 'Saved custom title';
    delete bill.titleTimestamp;
    delete bill.titleModifiedAt;
    await writeFile(journalFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const legacyJournal = await readFile(journalFile, 'utf8');
    const restarted = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([a]), now)).summary.chats[0].title).toBe('Saved custom title');
    for (const titlePriority of [TITLE_PRIORITY.prompt, TITLE_PRIORITY.generated]) {
      const fallback = { ...a, title: 'Surviving lower-priority title', metadataOnly: true,
        titlePriority, timestamp: new Date(base + 20_000) };
      expect((await restarted.refresh(aggregateUsage([a, fallback]), now)).summary.chats[0].title).toBe('Saved custom title');
    }
    const metadata = { ...a, title: 'Updated custom title', metadataOnly: true,
      titlePriority: TITLE_PRIORITY.custom, timestamp: new Date(base + 20_000) };
    expect((await restarted.refresh(aggregateUsage([a, metadata]), now)).summary.chats[0].title).toBe('Updated custom title');
    expect(await readFile(journalFile, 'utf8')).toBe(legacyJournal);
    const saved = await new AccountUsagePoc(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(saved.summary.chats[0].title).toBe('Updated custom title');
    expect(saved.summary.allTime.tokens).toBe(100);
  });

  it.each(['chat', 'Saved generated title'])('recovers legacy title priority for %s', async (savedTitle) => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'panel/editAgent', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 40_000);
    await f.poc.refresh(aggregateUsage([a]), now);
    const journalFile = join(f.storage, (await readdir(f.storage)).find((file) => file.endsWith('.jsonl'))!);
    const entries = (await readFile(journalFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const bill = entries.find((entry) => entry.kind === 'bill');
    bill.record.title = savedTitle;
    delete bill.titleTimestamp;
    delete bill.titleModifiedAt;
    await writeFile(journalFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const legacyJournal = await readFile(journalFile, 'utf8');
    const observer = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    const generated = { ...a, title: 'Saved generated title', titlePriority: TITLE_PRIORITY.generated,
      timestamp: new Date(base + 20_000), metadataOnly: true };
    expect((await observer.refresh(aggregateUsage([a, generated]), now)).summary.chats[0].title).toBe(generated.title);
    const restarted = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    const renamed = { ...generated, title: 'New generated title', timestamp: new Date(base + 30_000) };
    const updated = await restarted.refresh(aggregateUsage([a, renamed]), now);
    expect(updated.summary.chats[0].title).toBe(renamed.title);
    expect(updated.summary.allTime.tokens).toBe(100);
    expect(updated.summary.allTime.githubCopilot.aiCredits).toBe(2);
    expect(await readFile(journalFile, 'utf8')).toBe(legacyJournal);
  });

  it('retries an interrupted title append without losing saved usage', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const now = new Date(base + 30_000);
    await f.poc.refresh(aggregateUsage([a]), now);
    const metadata = { ...a, title: 'Delayed title', titlePriority: TITLE_PRIORITY.generated,
      timestamp: new Date(base + 20_000), metadataOnly: true };
    const summary = aggregateUsage([a, metadata]);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
      await fs.appendFile(file, String(data).slice(0, 20));
      throw new Error('Simulated interrupted title write');
    });
    await expect(f.poc.refresh(summary, now)).rejects.toThrow('Simulated interrupted title write');
    const recovered = await f.poc.refresh(summary, now);
    expect(recovered.summary.chats[0].title).toBe('Delayed title');
    expect(recovered.summary.allTime.tokens).toBe(100);
    const restarted = await new AccountUsagePoc(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(restarted.summary.chats[0].title).toBe('Delayed title');
    expect(restarted.summary.allTime.tokens).toBe(100);
  });

  it('updates retained chat titles after billed logs disappear and observers restart', async () => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'chat', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const first = await f.poc.refresh(aggregateUsage([a]), now);
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    await rm(join(f.root, 'debug-logs'), { recursive: true });
    await mkdir(join(f.root, 'chatSessions'));
    const titleFile = join(f.root, 'chatSessions', 'chat.json');
    await writeFile(titleFile, JSON.stringify({ kind: 0, v: {
      sessionId: 'chat', customTitle: 'Retained chat renamed', creationDate: base,
    } }));
    const observer = new AccountUsagePoc(f.storage, f.stream, [f.logRoot]);
    await observer.refresh(aggregateUsage([]), now);
    const index = new UsageIndex();
    const options = { config: { dataPath: f.root, maxFileSizeMb: 10, maxScanDepth: 6 }, now,
      retainedChatIds: ['chat'] };
    const scanned = await index.rebuild({ roots: [f.root], ...options });
    expect(scanned.summary.allTime.tokens).toBe(0);
    const updated = await observer.refresh(scanned.summary, now, scanned.titleMetadata);
    expect(updated.summary.chats[0].title).toBe('Retained chat renamed');
    expect(updated.summary.allTime).toEqual(first.summary.allTime);
    expect(observer.getRetainedChatIds()).toEqual(['chat']);
    const saved = await new AccountUsagePoc(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(saved.summary.chats[0].title).toBe('Retained chat renamed');
    expect(saved.summary.allTime).toEqual(first.summary.allTime);
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
  });

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

  it('shares observations across extension processes and follows the selected window', async () => {
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
