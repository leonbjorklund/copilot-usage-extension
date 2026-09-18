import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, appendFile: vi.fn(fs.appendFile), writeFile: vi.fn(fs.writeFile), readFile: vi.fn(fs.readFile),
    open: vi.fn(fs.open), readdir: vi.fn(fs.readdir) };
});

import { aggregateUsage } from '../src/core/aggregator';
import { TITLE_PRIORITY } from '../src/core/types';
import type { UsageRecord, UsageSummary } from '../src/core/types';
import { UsageIndex } from '../src/core/usageIndex';
import { AccountTracking, attributeRequest, parseAccountEvidence } from '../src/core/accountTracking';

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

function record(filePath = '/usage/debug-logs/chat/main.jsonl', at = base + 10_000, id = 'request-1') {
  return { filePath, chatId: 'chat', title: 'A chat', model: 'model', timestamp: new Date(at),
    tokens: { input: 80, output: 20, cachedInput: 10, cacheWriteInput: 0, total: 100, source: 'recorded' },
    billing: { aiCredits: 2, source: 'copilot-debug-log' },
    debugRequest: { responseId: id, spanId: String(at), durationMs: 1_000 } } satisfies UsageRecord;
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
  vi.mocked(open).mockImplementation(fs.open);
  vi.mocked(readdir).mockImplementation(fs.readdir);
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

  it('keeps a request unresolved when only a longer summary of the same model ends with it', () => {
    // A summary that merely covers the billed attempt cannot identify its
    // window: a long unbilled run finishing at the same moment would capture it.
    const row = { ...record(), model: 'claude-sonnet-5' };
    row.debugRequest!.durationMs = 9_879;
    const text = auth('Alice') + line(base + 19_880,
      'ccreq:6f2a1b0c.copilotmd | success | claude-sonnet-5 | 10747ms | [panel/editAgent]');
    expect(attributeRequest(row, base, parseAccountEvidence(text, 'one'), base + 40_000)).toHaveProperty('pending');
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

  it.each(['onDidCopilotTokenChange from getCopilotToken token lost',
    'onDidCopilotTokenChange resetCopilotToken',
    'Logged in as devDeviceId'])(
    'requires fresh successful evidence after %s', marker => {
      const row = record();
      const evidence = parseAccountEvidence(auth('Alice') + line(base, marker) + done(row), 'one');
      expect(attributeRequest(row, base + 5_000, evidence, base + 30_000)).toHaveProperty('excluded');
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

  it('keeps an existing chat after same-account startup reauthentication', () => {
    const row = record();
    const evidence = parseAccountEvidence(auth('Alice')
      + line(base - 5_000, 'Auth state changed (identity change), minting a new CopilotToken...')
      + auth('Alice', base - 4_900) + done(row), 'one');
    expect(attributeRequest(row, base - 9_000, evidence, base + 30_000)).toEqual({ account: 'alice' });
  });

});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilot-account-tracking-'));
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
  const tracking = new AccountTracking(storage, stream, [logRoot]);
  await tracking.refresh(aggregateUsage([], new Date(base)), new Date(base));
  return { root, storage, logRoot, stream, log, usage, tracking };
}

describe('local ledger', () => {
  it('keeps historical usage visible across accounts without saving it as account usage', async () => {
    const f = await fixture();
    const old = { ...record(f.usage, base - 1, 'old'), chatId: 'historical', title: 'Old chat' };
    const current = record(f.usage);
    const now = new Date(base + 30_000);
    await appendFile(f.log, done(current));
    const summary = aggregateUsage([old, current], now);
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    const alice = await f.tracking.refresh(summary, now);
    expect(alice.summary.allTime.tokens).toBe(200);
    expect(alice.summary.allTime.githubCopilot.usd).toBe(0.04);
    expect(alice.summary.chats.find(chat => chat.chatId === 'historical')).toMatchObject(summary.chats.find(chat => chat.chatId === 'historical')!);
    expect(f.tracking.getRetainedChatIds()).not.toContain('historical');
    await appendFile(f.log, auth('Bob', base + 40_000));
    const bob = await f.tracking.refresh(summary, new Date(base + 45_000));
    expect(bob.summary.allTime.tokens).toBe(100);
    expect(bob.summary.chats[0].title).toBe('Old chat');
    expect(bob.diagnostics).toContain('Attributed requests for this account: 0');
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
  });

  it('shows combined saved and unresolved usage until this window identifies its account', async () => {
    const f = await fixture();
    const a = record(f.usage);
    const pending = record(f.usage, base + 20_000, 'pending');
    await appendFile(f.log, done(a));
    const now = new Date(base + 30_000);
    await f.tracking.refresh(aggregateUsage([a, pending], now), now);
    const other = join(f.logRoot, '20260907T110000', 'window2', 'exthost', 'GitHub.copilot-chat');
    await mkdir(other, { recursive: true });
    const observer = new AccountTracking(f.storage, other, [f.logRoot]);
    const unknown = await observer.refresh(aggregateUsage([a, pending], now), now);
    expect(unknown.account).toBeUndefined();
    expect(unknown.problem).toBeUndefined();
    expect(unknown.summary.allTime.tokens).toBe(200);
    expect(unknown.summary.allTime.githubCopilot.usd).toBe(0.04);
    expect((await observer.refresh(aggregateUsage([]), now)).summary.allTime.tokens).toBe(200);
    await writeFile(join(other, 'GitHub Copilot Chat.log'), auth('Alice'));
    const identified = await observer.refresh(aggregateUsage([]), now);
    expect(identified.account).toBe('alice');
    expect(identified.summary.allTime.tokens).toBe(100);
    expect(identified.pending).toBe(1);
  });

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
    expect((await f.tracking.refresh(first.summary, options.now)).summary.chats[0].title).toBe('chat');
    const titleFile = join(f.root, 'debug-logs', 'chat', 'title-response.jsonl');
    const generatedTitle = (title: string) => JSON.stringify({ type: 'agent_response', ts: base + 20_000,
      attrs: { response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: title }] }]) } }) + '\n';
    await writeFile(titleFile, generatedTitle('Generated title'));
    await utimes(titleFile, new Date(base + 21_000), new Date(base + 21_000));
    const generated = await index.poll(options);
    expect((await f.tracking.refresh(generated.summary, options.now)).summary.chats[0].title).toBe('Generated title');
    await appendFile(titleFile, generatedTitle('Later generated title'));
    await utimes(titleFile, new Date(base + 22_000), new Date(base + 22_000));
    const appended = await index.poll(options);
    expect((await f.tracking.refresh(appended.summary, options.now)).summary.chats[0].title).toBe('Later generated title');
    // Unrelated appends must not make an older title look newer on a full scan.
    await appendFile(titleFile, '{}\n');
    await utimes(titleFile, new Date(base + 23_000), new Date(base + 23_000));
    const rebuilt = await index.rebuild({ roots: [f.root], ...options });
    expect((await f.tracking.refresh(rebuilt.summary, options.now)).summary.chats[0].title).toBe('Later generated title');
    const savedGenerated = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), options.now);
    expect(savedGenerated.summary.chats[0].title).toBe('Later generated title');
    const customFile = join(f.root, 'chatSessions', 'chat.json');
    await mkdir(join(f.root, 'chatSessions'));
    const customTitle = (title: string) => JSON.stringify({ kind: 0, v: { sessionId: 'chat', customTitle: title, creationDate: base } });
    await writeFile(customFile, customTitle('Custom title'));
    await utimes(customFile, new Date(base + 30_000), new Date(base + 30_000));
    const custom = await index.poll(options);
    expect((await f.tracking.refresh(custom.summary, options.now)).summary.chats[0].title).toBe('Custom title');
    await writeFile(customFile, customTitle('Renamed chat'));
    await utimes(customFile, new Date(base + 40_000), new Date(base + 40_000));
    const renamed = await index.poll(options);
    expect(renamed.summary.chats[0].title).toBe('Renamed chat');
    const view = await f.tracking.refresh(renamed.summary, options.now);
    expect(view.summary.chats[0].title).toBe('Renamed chat');
    expect(view.summary.allTime.tokens).toBe(100);
    expect(view.summary.allTime.githubCopilot.aiCredits).toBe(2);
    const restarted = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), options.now);
    expect(restarted.summary.chats[0].title).toBe('Renamed chat');
  });

  it.each([false, true])('keeps delayed chat titles after restart, restarted before title: %s', async (restartBeforeTitle) => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'panel/editAgent', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 30_000);
    const first = await f.tracking.refresh(aggregateUsage([a]), now);
    expect(first.summary.chats[0].title).toBe('chat');
    const observer = restartBeforeTitle ? new AccountTracking(f.storage, f.stream, [f.logRoot]) : f.tracking;
    const title = { ...a, title: 'Generated chat title', titlePriority: TITLE_PRIORITY.generated,
      timestamp: new Date(base + 20_000), metadataOnly: true };
    const titled = aggregateUsage([a, title]);
    expect(titled.chats[0].title).toBe('Generated chat title');
    const updated = await observer.refresh(titled, now);
    expect(updated.summary.chats[0].title).toBe('Generated chat title');
    expect(updated.summary.allTime).toEqual(first.summary.allTime);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), now)).summary.chats[0].title).toBe('Generated chat title');
  });

  it('retains timestamp-free custom rename deltas and later snapshots across restart', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const first = await f.tracking.refresh(aggregateUsage([a]), now);
    const folder = join(f.root, 'chatSessions');
    await mkdir(folder);
    const file = join(folder, 'chat.jsonl');
    const snapshot = (title: string) => JSON.stringify({ kind: 0, v: {
      sessionId: 'chat', customTitle: title, creationDate: base,
    } }) + '\n';
    await writeFile(file, snapshot('Original title'));
    await utimes(file, new Date(base + 10_000), new Date(base + 10_000));
    const index = new UsageIndex();
    const options = { config: { dataPath: f.root, maxFileSizeMb: 10, maxScanDepth: 6 }, now, retainedChatIds: ['chat'] };
    const initial = await index.rebuild({ roots: [f.root], ...options });
    expect((await f.tracking.refresh(initial.summary, now, initial.titleMetadata)).summary.chats[0].title).toBe('Original title');

    await appendFile(file, JSON.stringify({ kind: 1, k: ['customTitle'], v: 'Renamed title' }) + '\n');
    await utimes(file, new Date(base + 20_000), new Date(base + 20_000));
    const renamed = await index.poll(options);
    const saved = await f.tracking.refresh(renamed.summary, now, renamed.titleMetadata);
    expect(saved.summary.chats[0].title).toBe('Renamed title');
    expect(saved.summary.allTime).toEqual(first.summary.allTime);
    const rebuilt = await index.rebuild({ roots: [f.root], ...options });
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(rebuilt.summary, now, rebuilt.titleMetadata)).summary.chats[0].title).toBe('Renamed title');

    await appendFile(file, JSON.stringify({ kind: 1, k: ['customTitle'], v: 'Second rename' }) + '\n');
    await utimes(file, new Date(base + 25_000), new Date(base + 25_000));
    const second = await index.poll(options);
    expect((await restarted.refresh(second.summary, now, second.titleMetadata)).summary.chats[0].title).toBe('Second rename');

    // Snapshot compaction retains the chat creation date, not its rename time.
    await writeFile(file, snapshot('Snapshot rename'));
    await utimes(file, new Date(base + 30_000), new Date(base + 30_000));
    const compacted = await index.poll(options);
    expect((await restarted.refresh(compacted.summary, now, compacted.titleMetadata)).summary.chats[0].title).toBe('Snapshot rename');
    const final = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(final.summary.chats[0].title).toBe('Snapshot rename');
    expect(final.summary.allTime).toEqual(first.summary.allTime);
  });

  it('preserves title priority and saved billing when title sources change', async () => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'panel/editAgent', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const first = await f.tracking.refresh(aggregateUsage([a]), now);
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
      const view = await f.tracking.refresh(aggregateUsage([rescanned, metadata]), now);
      expect(view.summary.chats[0].title).toBe(expected);
      expect(view.summary.allTime).toEqual(first.summary.allTime);
    }
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    const saved = await restarted.refresh(aggregateUsage([]), now);
    expect(saved.summary.chats[0].title).toBe('Renamed custom title');
    expect(saved.summary.allTime).toEqual(first.summary.allTime);
  });

  it('ignores stale title revisions and preserves existing journals', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const metadata = { ...a, metadataOnly: true, titlePriority: TITLE_PRIORITY.custom,
      timestamp: new Date(base + 20_000), titleModifiedAt: base + 30_000, title: 'Old title' };
    const stale = aggregateUsage([a, metadata]);
    await f.tracking.refresh(stale, now);
    const oldFiles = (await readdir(f.storage)).filter((file) => file.endsWith('.jsonl'));
    const oldJournal = await readFile(join(f.storage, oldFiles[0]), 'utf8');
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    const newer = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    const fresh = aggregateUsage([a, { ...metadata, title: 'New title', titleModifiedAt: base + 40_000 }]);
    expect((await newer.refresh(fresh, now)).summary.chats[0].title).toBe('New title');
    expect((await readFile(join(f.storage, oldFiles[0]), 'utf8')).startsWith(oldJournal)).toBe(true);
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
    vi.mocked(appendFile).mockClear();
    expect((await f.tracking.refresh(stale, now)).summary.chats[0].title).toBe('New title');
    expect((await newer.refresh(fresh, now)).summary.chats[0].title).toBe('New title');
    expect(appendFile).not.toHaveBeenCalled();
    const restarted = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(stale, now);
    expect(restarted.summary.chats[0].title).toBe('New title');
    expect(restarted.summary.allTime.tokens).toBe(100);
  });

  it('does not rewrite a bill when only the title times move, but saves a changed title', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const custom = { ...a, metadataOnly: true, titlePriority: TITLE_PRIORITY.custom,
      timestamp: new Date(base + 20_000), titleModifiedAt: base + 30_000, title: 'My title' };
    expect((await f.tracking.refresh(aggregateUsage([a, custom]), now)).summary.chats[0].title).toBe('My title');
    const ledger = join(f.storage, 'ledger.jsonl');
    const saved = await readFile(ledger, 'utf8');
    vi.mocked(appendFile).mockClear();
    // Copilot bumps the chat file on every message without changing the title.
    for (const bump of [40_000, 50_000]) {
      const touched = aggregateUsage([a, { ...custom, titleModifiedAt: base + bump }]);
      expect((await f.tracking.refresh(touched, now)).summary.chats[0].title).toBe('My title');
    }
    expect(appendFile).not.toHaveBeenCalled();
    expect(await readFile(ledger, 'utf8')).toBe(saved);
    const renamed = aggregateUsage([a, { ...custom, title: 'Renamed', titleModifiedAt: base + 60_000 }]);
    expect((await f.tracking.refresh(renamed, now)).summary.chats[0].title).toBe('Renamed');
    expect(appendFile).toHaveBeenCalledTimes(1);
    await rm(f.usage);
    const restarted = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(restarted.summary.chats[0].title).toBe('Renamed');
    expect(restarted.summary.allTime.tokens).toBe(100);
  });

  it('retries an interrupted title append without losing saved usage', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const now = new Date(base + 30_000);
    await f.tracking.refresh(aggregateUsage([a]), now);
    const metadata = { ...a, title: 'Delayed title', titlePriority: TITLE_PRIORITY.generated,
      timestamp: new Date(base + 20_000), metadataOnly: true };
    const summary = aggregateUsage([a, metadata]);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
      await fs.appendFile(file, String(data).slice(0, 20));
      throw new Error('Simulated interrupted title write');
    });
    await expect(f.tracking.refresh(summary, now)).rejects.toThrow('Simulated interrupted title write');
    const recovered = await f.tracking.refresh(summary, now);
    expect(recovered.summary.chats[0].title).toBe('Delayed title');
    expect(recovered.summary.allTime.tokens).toBe(100);
    const restarted = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(restarted.summary.chats[0].title).toBe('Delayed title');
    expect(restarted.summary.allTime.tokens).toBe(100);
  });

  it('updates retained chat titles after billed logs disappear and observers restart', async () => {
    const f = await fixture();
    const a = { ...record(f.usage), title: 'chat', titlePriority: TITLE_PRIORITY.generic };
    await appendFile(f.log, done(a));
    const now = new Date(base + 90_000);
    const first = await f.tracking.refresh(aggregateUsage([a]), now);
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    await rm(join(f.root, 'debug-logs'), { recursive: true });
    await mkdir(join(f.root, 'chatSessions'));
    const titleFile = join(f.root, 'chatSessions', 'chat.json');
    await writeFile(titleFile, JSON.stringify({ kind: 0, v: {
      sessionId: 'chat', customTitle: 'Retained chat renamed', creationDate: base,
    } }));
    const observer = new AccountTracking(f.storage, f.stream, [f.logRoot]);
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
    const saved = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(saved.summary.chats[0].title).toBe('Retained chat renamed');
    expect(saved.summary.allTime).toEqual(first.summary.allTime);
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
  });

  it('does not reread unchanged, validated journals on every refresh', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    await f.tracking.refresh(summary, new Date(base + 30_000));
    await f.tracking.refresh(summary, new Date(base + 30_000));
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const reads = vi.fn();
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await fs.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation((...readArgs: Parameters<typeof handle.read>) => {
        reads(args[0]);
        return read(...readArgs);
      });
      return handle;
    });
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    expect(reads).not.toHaveBeenCalled();
  });

  it.each([false, true])('recovers a delayed session start across restart, failed append: %s', async (failAppend) => {
    const f = await fixture();
    await appendFile(f.log, auth('Bob', base + 3_000));
    await writeFile(f.usage, '');
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(0);
    await writeFile(f.usage, JSON.stringify({ type: 'session_start', ts: base + 7_000 }) + '\n');
    if (failAppend) {
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
        await fs.appendFile(file, String(data).slice(0, 20));
        throw new Error('Simulated interrupted header write');
      });
      await expect(f.tracking.refresh(aggregateUsage([]), new Date(base + 30_000))).rejects.toThrow('Simulated interrupted header write');
    }
    const recovered = await f.tracking.refresh(aggregateUsage([]), new Date(base + 30_000));
    expect(recovered.excluded).toBe(0);
    expect(recovered.summary.allTime.tokens).toBe(100);
    await rm(f.usage);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
  });

  it.each([false, true])('counts post-switch requests when a hook precedes the session start, delayed: %s', async (delayed) => {
    const f = await fixture();
    await appendFile(f.log, auth('Bob', base + 3_000));
    const hook = JSON.stringify({ type: 'hook', ts: base + 6_000 }) + '\n';
    const header = JSON.stringify({ type: 'session_start', ts: base + 7_000 }) + '\n';
    await writeFile(f.usage, hook + (delayed ? '' : header));
    const first = record(f.usage);
    const second = record(f.usage, base + 20_000, 'second-request');
    await appendFile(f.log, done(first) + done(second));
    const now = new Date(base + 30_000);
    let view = await f.tracking.refresh(aggregateUsage([first, second], now), now);
    if (delayed) {
      expect(view.summary.today.tokens).toBe(0);
      await appendFile(f.usage, header);
      // Previously saved requests must recover without being rescanned or reset.
      view = await f.tracking.refresh(aggregateUsage([], now), now);
    }
    expect(view.account).toBe('bob');
    expect(view.summary.today.tokens).toBe(200);
    expect(view.excluded).toBe(0);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([], now), now)).summary.today.tokens).toBe(200);
  });

  it('does not use a newer hook to assign an older chat after an account switch', async () => {
    const f = await fixture();
    await appendFile(f.log, auth('Bob', base + 3_000));
    await writeFile(f.usage, JSON.stringify({ type: 'hook', ts: base + 6_000 }) + '\n'
      + JSON.stringify({ type: 'session_start', ts: base + 1_000 }) + '\n');
    const request = record(f.usage);
    await appendFile(f.log, done(request));
    const now = new Date(base + 30_000);
    const view = await f.tracking.refresh(aggregateUsage([request], now), now);
    expect(view.account).toBe('bob');
    expect(view.summary.today.tokens).toBe(0);
    expect(view.excluded).toBe(1);
  });

  it('retries a complete-line snapshot shorter than the file metadata without another log write', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let interrupted = false;
    vi.mocked(open).mockImplementation(async (file, flags, mode) => {
      const handle = await fs.open(file, flags, mode);
      if (!interrupted && String(file).toLowerCase() === f.log.toLowerCase()) {
        interrupted = true;
        // A writer can replace/truncate a file between its stat and read.
        let firstRead = true;
        vi.spyOn(handle, 'read').mockImplementation(async (buffer) => {
          if (!Buffer.isBuffer(buffer)) throw new Error('Expected a buffer-based log read');
          const bytesRead = firstRead ? Buffer.from(auth('Alice')).copy(buffer) : 0;
          firstRead = false;
          return { bytesRead, buffer };
        });
      }
      return handle;
    });
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).pending).toBe(1);
    const caughtUp = await f.tracking.refresh(summary, new Date(base + 30_000));
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
    const first = new AccountTracking(storage, f.stream, [f.logRoot]);
    const second = new AccountTracking(storage, f.stream, [f.logRoot]);
    const firstRefresh = first.refresh(aggregateUsage([]), new Date(base));
    await fileCreated;
    const other = await second.refresh(aggregateUsage([]), new Date(base + 1))
      .then((view) => ({ view }), (error: unknown) => ({ error }));
    finishWrite();
    const view = await firstRefresh;
    expect(other).toHaveProperty('view');
    if ('view' in other) expect(other.view.startedAt).toEqual(view.startedAt);
  });

  it('bounds a log read when the file grows beyond its limit after stat', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let checkedSize = 0;
    let allocatedSize = 0;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await fs.open(...args);
      if (String(args[0]).toLowerCase() === f.log.toLowerCase()) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementation(async () => {
          const info = await stat();
          checkedSize = info.size;
          await fs.truncate(f.log, 32 * 1024 * 1024 + 1);
          return info;
        });
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation((...readArgs: Parameters<typeof handle.read>) => {
          if (!Buffer.isBuffer(readArgs[0])) throw new Error('Expected a buffer-based log read');
          allocatedSize = readArgs[0].length;
          return read(...readArgs);
        });
      }
      return handle;
    });
    const summary = aggregateUsage([a]);
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    expect(checkedSize).toBeGreaterThan(0);
    expect(allocatedSize).toBe(checkedSize);
    expect(allocatedSize).toBeLessThan(1024);
    vi.mocked(open).mockImplementation(fs.open);
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).problem).toContain('Cannot read Copilot log');
  });

  it('stops discovering windows as soon as the folder limit is reached', async () => {
    const f = await fixture();
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const session = join(f.logRoot, '20260907T110000');
    const [window] = await fs.readdir(session, { withFileTypes: true });
    const hosts = await fs.readdir(join(session, window.name), { withFileTypes: true });
    const visited: string[] = [];
    vi.mocked(readdir).mockImplementation(async (path, options) => {
      const name = String(path);
      if (name.toLowerCase() === session.toLowerCase()) {
        return Array.from({ length: 514 }, (_, index) =>
          Object.create(window, { name: { value: `window${index + 1}` } }));
      }
      if (name.toLowerCase().startsWith(join(session, 'window').toLowerCase())) {
        visited.push(name);
        return hosts;
      }
      return fs.readdir(path, options);
    });
    await expect(f.tracking.refresh(aggregateUsage([]))).rejects.toThrow('too many window log folders');
    expect(visited).toHaveLength(513);
  });

  it('preserves complete interrupted-write entries already visible to another observer', async () => {
    const f = await fixture();
    const a = record(f.usage);
    const b = record(f.usage, base + 20_000, 'request-2');
    await appendFile(f.log, done(a) + done(b));
    const now = new Date(base + 40_000);
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
      const lines = String(data).split('\n').filter(Boolean);
      const firstBill = lines.findIndex((line) => JSON.parse(line).kind === 'bill');
      await fs.appendFile(file, lines.slice(0, firstBill + 1).join('\n') + '\n{"kind"');
      throw new Error('Interrupted after a complete bill');
    });
    await expect(f.tracking.refresh(aggregateUsage([a, b]), now)).rejects.toThrow('Interrupted after a complete bill');
    const other = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    const observed = await other.refresh(aggregateUsage([]), now);
    expect(observed.summary.allTime.githubCopilot.aiCredits).toBe(2);

    // The original writer retries after the request logs have disappeared.
    await rm(f.usage);
    const recovered = await f.tracking.refresh(aggregateUsage([]), now);
    expect(recovered.summary.allTime).toEqual(observed.summary.allTime);
    expect((await other.refresh(aggregateUsage([]), now)).summary.allTime).toEqual(observed.summary.allTime);
    const restarted = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([]), now);
    expect(restarted.summary.allTime).toEqual(observed.summary.allTime);
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
  });

  it('forgets unsaved account evidence and retained chats after an append fails', async () => {
    const f = await fixture();
    const row = record(f.usage);
    await appendFile(f.log, auth('Bob', base + 3_000) + done(row));
    const now = new Date(base + 30_000);
    vi.mocked(appendFile).mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(f.tracking.refresh(aggregateUsage([row], now), now)).rejects.toThrow('Disk unavailable');
    await rm(f.log);
    const recovered = await f.tracking.refresh(aggregateUsage([], now), now);
    const restarted = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([], now), now);
    expect(recovered.account).toBe('alice');
    expect(recovered).toEqual(restarted);
    expect(f.tracking.getRetainedChatIds()).toEqual([]);
  });

  it('forgets unsaved summary peers after an append fails', async () => {
    const f = await fixture();
    const row = record(f.usage);
    const other = { ...row, chatId: 'unsaved', debugRequest: { ...row.debugRequest, spanId: 'other' } };
    await appendFile(f.log, line(base + 11_000, 'ccreq:one | success | model | 1000ms | [panel/editAgent]'));
    const now = new Date(base + 30_000);
    vi.mocked(appendFile).mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(f.tracking.refresh(aggregateUsage([row, other], now), now)).rejects.toThrow('Disk unavailable');
    const recovered = await f.tracking.refresh(aggregateUsage([row], now), now);
    expect(recovered.summary.allTime.tokens).toBe(100);
    expect(recovered.pending).toBe(0);
    expect(f.tracking.getRetainedChatIds()).toEqual(['chat']);
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

    await expect(f.tracking.refresh(summary, new Date(base + 30_000))).rejects.toThrow('Simulated interrupted write');
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
  });

  it('follows a managed account login with an underscore instead of retaining the previous account', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const summary = aggregateUsage([a]);
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    await appendFile(f.log, auth('Bob_company', base + 40_000));
    const switched = await f.tracking.refresh(summary, new Date(base + 45_000));
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
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    // Reproduce another window's duplicate entry without resetting the ledger.
    const oldKey = createHash('sha256').update(JSON.stringify([
      resolve(b.filePath), b.timestamp.getTime(), b.debugRequest!.spanId,
      b.debugRequest!.responseId, b.debugRequest!.durationMs, b.model,
    ])).digest('hex');
    await appendFile(join(f.storage, 'ledger.jsonl'), JSON.stringify({ kind: 'bill', key: oldKey, record: b, sessionStart: base + 1_000 }) + '\n');
    const restarted = new AccountTracking(f.storage, f.stream.toLowerCase(), [f.logRoot]);
    expect((await restarted.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
  });

  it('preserves history and retries delayed evidence without dropping or double counting usage', async () => {
    const f = await fixture();
    const old = record(f.usage, base - 1);
    const current = record(f.usage);
    const summary = aggregateUsage([old, current], new Date(base + 30_000));
    const pending = await f.tracking.refresh(summary, new Date(base + 30_000));
    expect(pending.pending).toBe(1);
    expect(pending.problem).toBeUndefined();
    expect(pending.summary.allTime.tokens).toBe(100);
    const completion = done(current);
    await appendFile(f.log, completion.slice(0, -1));
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).pending).toBe(1);
    await appendFile(f.log, '\n');
    const resolved = await f.tracking.refresh(summary, new Date(base + 30_000));
    expect(resolved.problem).toBeUndefined();
    expect(resolved.summary.allTime.tokens).toBe(200);
    expect(resolved.summary.month.githubCopilot.usd).toBe(0.04);
    expect(resolved.summary.topModels[0].sessions).toBe(1);
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(200);
  });

  it('survives restart and log cleanup using saved evidence and usage', async () => {
    const f = await fixture();
    const current = record(f.usage);
    await appendFile(f.log, line(base + 11_001, 'ccreq:abc.copilotmd | success | model | 1001ms | [panel/editAgent]'));
    await f.tracking.refresh(aggregateUsage([current]), new Date(base + 30_000));
    await rm(f.log);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
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
    await f.tracking.refresh(aggregateUsage([saved]), new Date(base + 30_000));
    await rm(f.log);

    const stream = join(f.logRoot, '20260907T130000', 'window1', 'exthost', 'GitHub.copilot-chat');
    await mkdir(stream, { recursive: true });
    const log = join(stream, 'GitHub Copilot Chat.log');
    await writeFile(log, auth('Alice', base + 3_600_000));
    const missed = record(f.usage, base + 60_000, 'missed-request');
    const fresh = record(f.usage, base + 3_610_000, 'fresh-request');
    await appendFile(log, done(fresh));
    const summary = aggregateUsage([saved, missed, fresh]);
    const restarted = new AccountTracking(f.storage, stream, [f.logRoot]);
    const now = new Date(base + 3_630_000);
    const view = await restarted.refresh(summary, now);

    expect(view.problem).toBeUndefined();
    expect(view.pending).toBe(1);
    expect(view.diagnostics).toContain('unresolved requests: 1');
    expect(view.summary.allTime.tokens).toBe(200);
    expect(view.summary.chats.flatMap((chat) => chat.records).map((row) => row.debugRequest?.responseId)).not.toContain('missed-request');
    expect((await new AccountTracking(f.storage, stream, [f.logRoot]).refresh(aggregateUsage([]), now)).problem).toBeUndefined();

    // Evidence restored later can still resolve the request; it was not lost
    // or assigned to whichever account happened to open the new window.
    const recoveredEvidence = parseAccountEvidence(auth('Alice') + done(saved) + done(missed), f.stream);
    await appendFile(join(f.storage, 'ledger.jsonl'),
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
    const second = new AccountTracking(f.storage, other, [f.logRoot]);
    const summary = aggregateUsage([a, b]);
    const [alice, bob] = await Promise.all([
      f.tracking.refresh(summary, new Date(base + 30_000)), second.refresh(summary, new Date(base + 30_000)),
    ]);
    expect(alice.summary.allTime.tokens).toBe(100);
    expect(bob.summary.allTime.tokens).toBe(200);
    await appendFile(f.log, auth('Bob', base + 40_000));
    const switched = await f.tracking.refresh(summary, new Date(base + 45_000));
    expect(switched.account).toBe('bob');
    expect(switched.summary.allTime.tokens).toBe(200);
    expect(switched.summary.allTime.githubCopilot.aiCredits).toBe(5);
    expect(switched.summary.chats).toHaveLength(1);
  });

  it('rechecks summary uniqueness when another billed request arrives', async () => {
    const f = await fixture();
    const a = record(f.usage);
    const b = { ...record(f.usage, a.timestamp.getTime(), 'request-2'),
      debugRequest: { ...a.debugRequest!, responseId: 'request-2', spanId: 'second-span' } };
    const now = new Date(base + 90_000);
    await appendFile(f.log, line(base + 11_000, 'ccreq:summary-1 | success | original-model -> model | 1000ms | [panel/editAgent]'));
    const initial = await f.tracking.refresh(aggregateUsage([a]), now);
    expect(initial.summary.allTime.tokens).toBe(100);
    expect(initial.pending).toBe(0);

    const ambiguous = await f.tracking.refresh(aggregateUsage([a, b]), now);
    expect(ambiguous.summary.allTime.tokens).toBe(0);
    expect(ambiguous.pending).toBe(2);

    await appendFile(f.log, done(a));
    const resolved = await f.tracking.refresh(aggregateUsage([a, b]), now);
    expect(resolved.summary.allTime.tokens).toBe(100);
    expect(resolved.pending).toBe(1);
    expect(resolved.summary.chats[0].records[0].debugRequest?.responseId).toBe(a.debugRequest.responseId);
  });

  it('reads rotated logs and revokes inference when delayed conflicting evidence appears', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await writeFile(join(f.stream, 'GitHub Copilot Chat.1.log'), auth('Alice') + done(a));
    const summary = aggregateUsage([a]);
    expect((await f.tracking.refresh(summary, new Date(base + 30_000))).summary.allTime.tokens).toBe(100);
    await appendFile(f.log, auth('Bob', base + 10_500));
    const revised = await f.tracking.refresh(summary, new Date(base + 35_000));
    expect(revised.excluded).toBe(1);
    expect(revised.summary.allTime.tokens).toBe(0);
  });

  it.each(['"2"', '1e999', 'true', '[2]'])('rejects malformed saved credit amount %s without changing tracking data', async (amount) => {
    const f = await fixture();
    const a = record(f.usage);
    const b = record(f.usage, base + 20_000, 'second-request');
    await appendFile(f.log, done(a) + done(b));
    const now = new Date(base + 30_000);
    expect((await f.tracking.refresh(aggregateUsage([a, b]), now)).summary.allTime.githubCopilot.aiCredits).toBe(4);
    const journalFile = join(f.storage, (await readdir(f.storage)).find((file) => file.endsWith('.jsonl'))!);
    const malformed = (await readFile(journalFile, 'utf8')).replace(/"aiCredits":2/g, `"aiCredits":${amount}`);
    await writeFile(journalFile, malformed);
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);

    await expect(restarted.refresh(aggregateUsage([]), now)).rejects.toThrow('Invalid account tracking request journal');
    await expect(restarted.refresh(aggregateUsage([]), now)).rejects.toThrow('Invalid account tracking request journal');
    expect(await readFile(journalFile, 'utf8')).toBe(malformed);
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
  });

});

describe('replaced window logs', () => {
  /** A second window with its own Alice sign-in and one billed request. */
  async function twoWindows() {
    const f = await fixture();
    const other = join(f.logRoot, '20260907T110000', 'window2', 'exthost', 'GitHub.copilot-chat');
    await mkdir(other, { recursive: true });
    const otherLog = join(other, 'GitHub Copilot Chat.log');
    const otherUsage = join(f.root, 'debug-logs', 'other', 'main.jsonl');
    await mkdir(join(f.root, 'debug-logs', 'other'), { recursive: true });
    await writeFile(otherUsage, JSON.stringify({ type: 'session_start', ts: base + 25_000 }) + '\n');
    const mine = record(f.usage);
    const theirs = { ...record(otherUsage, base + 30_000, 'other-request'), chatId: 'other-chat', title: 'Other chat' };
    await writeFile(otherLog, auth('Alice') + done(theirs));
    await appendFile(f.log, done(mine));
    const seen = new Date(base + 35_000);
    const both = await f.tracking.refresh(aggregateUsage([mine, theirs], seen), seen);
    expect(both).toMatchObject({ account: 'alice', excluded: 0, pending: 0 });
    expect(both.summary.allTime.tokens).toBe(200);
    return { ...f, other, otherLog, mine, theirs };
  }

  /** A request this window dispatches after its log was replaced. */
  async function afterLoss(root: string, name: string, at: number) {
    const usage = join(root, 'debug-logs', name, 'main.jsonl');
    await mkdir(join(root, 'debug-logs', name), { recursive: true });
    await writeFile(usage, JSON.stringify({ type: 'session_start', ts: at - 2_000 }) + '\n');
    return { ...record(usage, at, `${name}-request`), chatId: `${name}-chat`, title: `${name} chat` };
  }

  it('stops crediting the previous account when a replacement could have erased a switch', async () => {
    const f = await twoWindows();
    const later = await afterLoss(f.root, 'later', base + 50_000);
    // A sign-in as someone else, and everything before it, is erased. Only the
    // completion of the request dispatched afterwards survives.
    await writeFile(f.otherLog, done(later));
    const now = new Date(base + 60_000);
    const summary = aggregateUsage([f.mine, f.theirs, later], now);
    const after = await f.tracking.refresh(summary, now);
    expect(after.account).toBe('alice');
    // Both requests evidenced before the loss keep their account; the one
    // dispatched into the lost span does not join them.
    expect(after.summary.allTime.tokens).toBe(200);
    expect(after.excluded).toBe(1);
    expect(after.summary.chats.map((chat) => chat.chatId)).not.toContain('later-chat');
    // The lost span is recorded, so a restart cannot recover the old account.
    const restarted = await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(summary, now);
    expect(restarted.summary.allTime.tokens).toBe(200);
    expect(restarted.excluded).toBe(1);
  });

  it('still reports lost content after a failed ledger append', async () => {
    const f = await twoWindows();
    const later = await afterLoss(f.root, 'later', base + 50_000);
    await writeFile(f.otherLog, done(later));
    const now = new Date(base + 60_000);
    const summary = aggregateUsage([f.mine, f.theirs, later], now);
    vi.mocked(appendFile).mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(f.tracking.refresh(summary, now)).rejects.toThrow('Disk unavailable');
    // The record of what was already read must survive the rollback.
    const after = await f.tracking.refresh(summary, now);
    expect(after.summary.allTime.tokens).toBe(200);
    expect(after.excluded).toBe(1);
  });

  it('rejects a request dispatched just after reading stopped', async () => {
    const f = await twoWindows();
    // Reading stopped at the other window's last completion, so the marker sits
    // a matching tolerance later. A request dispatched between the two still
    // ran after content could have gone missing.
    const victim = await afterLoss(f.root, 'victim', base + 32_000);
    await writeFile(f.otherLog, done(victim));
    const now = new Date(base + 60_000);
    const after = await f.tracking.refresh(aggregateUsage([f.mine, f.theirs, victim], now), now);
    expect(after.account).toBe('alice');
    expect(after.summary.chats.map((chat) => chat.chatId)).not.toContain('victim-chat');
    expect(after.summary.allTime.tokens).toBe(200);
    expect(after.excluded).toBe(1);
  });

  it('hides the account on the very refresh that finds the loss', async () => {
    const f = await twoWindows();
    // A newer line in this window, read before its log is replaced.
    await appendFile(f.log, line(base + 36_000, 'request done: requestId: [noise] model deployment ID: []'));
    await f.tracking.refresh(aggregateUsage([f.mine, f.theirs], new Date(base + 40_000)), new Date(base + 40_000));
    // Found within a matching tolerance of that line, which is the busy case.
    await writeFile(f.log, line(base + 37_000, 'Opening chat session'));
    const now = new Date(base + 37_500);
    const after = await f.tracking.refresh(aggregateUsage([f.mine, f.theirs], now), now);
    expect(after.account).toBeUndefined();
  });

  it('ignores a rotated backup being overwritten once it was read to the end', async () => {
    const f = await twoWindows();
    // First rotation: the live log moves aside and a fresh one starts.
    const rotated = await readFile(f.otherLog, 'utf8');
    const backup = join(f.other, 'GitHub Copilot Chat.1.log');
    await writeFile(backup, rotated);
    const between = line(base + 40_000, 'After the first rotation');
    await writeFile(f.otherLog, between);
    const once = await f.tracking.refresh(aggregateUsage([f.mine, f.theirs], new Date(base + 45_000)), new Date(base + 45_000));
    expect(once).toMatchObject({ account: 'alice', excluded: 0, pending: 0 });
    // Second rotation with room for one backup only: the backup this window
    // already read to its end is overwritten, which loses nothing unread.
    await writeFile(backup, between);
    await writeFile(f.otherLog, line(base + 50_000, 'After the second rotation'));
    const now = new Date(base + 60_000);
    const twice = await f.tracking.refresh(aggregateUsage([f.mine, f.theirs], now), now);
    expect(twice).toMatchObject({ account: 'alice', excluded: 0, pending: 0 });
    expect(twice.summary.allTime.tokens).toBe(200);
    expect(twice.diagnostics).not.toContain('lost account history');
  });

  it('resumes attribution once a fresh token names the account again', async () => {
    const f = await twoWindows();
    const inSpan = await afterLoss(f.root, 'span', base + 35_000);
    const later = await afterLoss(f.root, 'later', base + 50_000);
    await writeFile(f.otherLog, done(inSpan) + auth('Alice', base + 45_000) + done(later));
    const now = new Date(base + 60_000);
    const after = await f.tracking.refresh(aggregateUsage([f.mine, f.theirs, inSpan, later], now), now);
    expect(after.account).toBe('alice');
    // The request dispatched into the lost span stays uncertain; the one
    // dispatched after the new token is attributed again.
    expect(after.excluded).toBe(1);
    expect(after.summary.allTime.tokens).toBe(300);
    expect(after.summary.chats.map((chat) => chat.chatId).sort()).toEqual(['chat', 'later-chat', 'other-chat']);
  });

  it('keeps other windows attributed when this window loses its own account lines', async () => {
    const f = await twoWindows();
    await writeFile(f.log, line(base + 50_000, 'Opening chat session'));
    const now = new Date(base + 60_000);
    const after = await f.tracking.refresh(aggregateUsage([f.mine, f.theirs], now), now);
    // This window can no longer name its own account, so combined usage shows.
    expect(after.account).toBeUndefined();
    expect(after.summary.allTime.tokens).toBe(200);
    expect(after.diagnostics).toContain('Times a window log lost account history since this window started: 1');
  });
});

describe('shared ledger', () => {
  it('appends every observer to one ledger file instead of a journal per process', async () => {
    const f = await fixture();
    const a = record(f.usage);
    const b = record(f.usage, base + 20_000, 'request-2');
    await appendFile(f.log, done(a) + done(b));
    const now = new Date(base + 40_000);
    const second = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    const [first, other] = await Promise.all([
      f.tracking.refresh(aggregateUsage([a]), now), second.refresh(aggregateUsage([b]), now),
    ]);
    // Whichever window appends second already sees the other's bill.
    expect(first.summary.allTime.tokens).toBeGreaterThanOrEqual(100);
    expect(other.summary.allTime.tokens).toBeGreaterThanOrEqual(100);
    expect((await readdir(f.storage)).filter((file) => file.endsWith('.jsonl'))).toEqual(['ledger.jsonl']);
    // The ledger is only ever appended to, never rewritten.
    expect(vi.mocked(writeFile).mock.calls.some(([file]) => String(file).startsWith(f.storage) && String(file).endsWith('.jsonl'))).toBe(false);
    await rm(f.usage);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), now)).summary.allTime.tokens).toBe(200);
    const lines = (await readFile(join(f.storage, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(lines.filter((line) => JSON.parse(line).kind === 'bill')).toHaveLength(2);
  });

  it('does not append an entry another window saved identically during the same refresh', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    const now = new Date(base + 30_000);
    const summary = aggregateUsage([a]);
    const other = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    await other.refresh(aggregateUsage([]), now);
    // The other window saves the same bill after this window has read the
    // ledger but before it appends.
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let raced = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (!raced && String(args[0]).toLowerCase() === f.log.toLowerCase()) {
        raced = true;
        await other.refresh(summary, now);
      }
      return fs.open(...args);
    });
    vi.mocked(appendFile).mockClear();
    expect((await f.tracking.refresh(summary, now)).summary.allTime.tokens).toBe(100);
    expect(raced).toBe(true);
    expect(vi.mocked(appendFile).mock.calls.filter(([file]) => String(file).endsWith('ledger.jsonl'))).toHaveLength(1);
    const lines = (await readFile(join(f.storage, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(lines.filter((line) => JSON.parse(line).kind === 'bill')).toHaveLength(1);
    expect(lines.filter((line) => JSON.parse(line).kind === 'completion')).toHaveLength(1);
    vi.mocked(open).mockImplementation(fs.open);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), now)).summary.allTime.tokens).toBe(100);
  });

  it('skips and counts a torn ledger line but keeps failing on an invalid entry', async () => {
    const f = await fixture();
    const a = record(f.usage);
    const b = record(f.usage, base + 20_000, 'request-2');
    await appendFile(f.log, done(a) + done(b));
    const now = new Date(base + 40_000);
    await f.tracking.refresh(aggregateUsage([a]), now);
    const ledger = join(f.storage, 'ledger.jsonl');
    // A window that died mid-append leaves a fragment; the next append starts a new line.
    await appendFile(ledger, '{"kind":"bill","key":"torn');
    const view = await f.tracking.refresh(aggregateUsage([b]), now);
    expect(view.summary.allTime.tokens).toBe(200);
    expect(view.diagnostics).not.toContain('Skipped unreadable');
    await rm(f.usage);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    const reloaded = await restarted.refresh(aggregateUsage([]), now);
    expect(reloaded.summary.allTime.tokens).toBe(200);
    expect(reloaded.diagnostics).toContain('Skipped unreadable ledger lines: 1');
    expect((await restarted.refresh(aggregateUsage([]), now)).diagnostics).toContain('Skipped unreadable ledger lines: 1');

    const invalid = (await readFile(ledger, 'utf8')) + JSON.stringify({ kind: 'token', stream: 7, at: base }) + '\n';
    await writeFile(ledger, invalid);
    const start = await readFile(join(f.storage, 'start.json'), 'utf8');
    const strict = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    await expect(strict.refresh(aggregateUsage([]), now)).rejects.toThrow('Invalid account tracking evidence journal');
    await expect(strict.refresh(aggregateUsage([]), now)).rejects.toThrow('Invalid account tracking evidence journal');
    expect(await readFile(ledger, 'utf8')).toBe(invalid);
    expect(await readFile(join(f.storage, 'start.json'), 'utf8')).toBe(start);
  });

  it('writes large batches as whole-line groups that each begin on a new line', async () => {
    const f = await fixture();
    const now = new Date(base + 40_000);
    const requests = Array.from({ length: 3_000 }, (_, i) => record(f.usage, base + 10_000 + i, `request-${i}`));
    await appendFile(f.log, requests.map(done).join(''));
    vi.mocked(appendFile).mockClear();
    await f.tracking.refresh(aggregateUsage([]), now);
    const writes = vi.mocked(appendFile).mock.calls.map((call) => String(call[1]));
    expect(writes.reduce((total, text) => total + Buffer.byteLength(text), 0)).toBeGreaterThan(256 * 1024);
    expect(writes.length).toBeGreaterThan(1);
    for (const text of writes) {
      expect(text.startsWith('\n') && text.endsWith('\n')).toBe(true);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024 + 1);
      for (const line of text.split('\n').filter(Boolean)) expect(JSON.parse(line).kind).toBe('completion');
    }
    const lines = (await readFile(join(f.storage, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(lines.filter((line) => JSON.parse(line).kind === 'completion')).toHaveLength(3_000);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([]), now)).diagnostics).not.toContain('Skipped unreadable');
  });

  it('retries a batch whose open ledger was rolled and retired before its write finished', async () => {
    const f = await fixture();
    const row = record(f.usage);
    await appendFile(f.log, done(row));
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(appendFile).mockImplementationOnce(async (file, data) => {
      const path = String(file);
      const before = await fs.readFile(path, 'utf8');
      const writer = await fs.open(path, 'a');
      try {
        const retired = `${path}.retired`;
        await fs.rename(path, retired);
        // Preserve previously saved entries while retirement removes the open file.
        await fs.writeFile(path, before);
        await fs.unlink(retired);
        await fs.appendFile(writer, data);
      } finally {
        await writer.close();
      }
    });
    const now = new Date(base + 30_000);
    expect((await f.tracking.refresh(aggregateUsage([row], now), now)).summary.allTime.tokens).toBe(100);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([], now), now)).summary.allTime.tokens).toBe(100);
  });

});

describe('ledger rollover and freeze', () => {
  const DAY = 86_400_000;
  const savedKey = (row: UsageRecord) => createHash('sha256').update(JSON.stringify([
    resolve(row.filePath), row.timestamp.getTime(), row.debugRequest!.spanId, row.debugRequest!.responseId,
    row.debugRequest!.durationMs, row.model])).digest('hex');
  const files = async (storage: string) => (await readdir(storage)).filter((name) => name.endsWith('.jsonl'));
  const snapshotLines = async (storage: string) => {
    const [name] = (await files(storage)).filter((file) => file.startsWith('snapshot-'));
    return (await readFile(join(storage, name), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };

  async function frozenFixture() {
    const f = await fixture();
    const a = record(f.usage);
    const b = record(f.usage, base + 20_000, 'request-2');
    await appendFile(f.log, done(a) + done(b));
    const soon = new Date(base + 30_000);
    expect((await f.tracking.refresh(aggregateUsage([a, b], soon), soon)).summary.allTime.tokens).toBe(200);
    const later = new Date(base + 8 * DAY);
    const settled = new Date(later.getTime() + 11 * 60_000);
    return { ...f, a, b, later, settled };
  }

  it('rolls the ledger aside, then freezes old requests into per-day rollups without their evidence', async () => {
    const f = await frozenFixture();
    // Old requests in the live ledger: it is renamed aside, never rewritten, and waits for in-flight appends.
    const rolled = await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    expect(rolled.summary.allTime.tokens).toBe(200);
    let names = await files(f.storage);
    expect(names.some((name) => /^ledger-\d+-[\da-f-]+\.jsonl$/.test(name))).toBe(true);
    expect(names).not.toContain('ledger.jsonl');
    expect(names.some((name) => name.startsWith('snapshot-'))).toBe(false);
    const frozen = await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    expect(frozen.summary.allTime.tokens).toBe(200);
    expect(frozen.diagnostics).toContain('Attributed requests for this account: 2');
    expect(vi.mocked(writeFile).mock.calls.some(([file]) => String(file).startsWith(f.storage) && String(file).endsWith('.jsonl'))).toBe(false);
    const lines = await snapshotLines(f.storage);
    expect(lines[0]).toMatchObject({ kind: 'snapshot', version: 2, absorbed: [{ name: expect.stringMatching(/^ledger-/), bytes: expect.any(Number) }] });
    expect(lines.filter((line) => line.kind === 'rollup')).toEqual([expect.objectContaining({ requests: 2, day: '2026-09-07', decision: { account: 'alice' } })]);
    expect(lines.filter((line) => ['bill', 'completion', 'request-summary'].includes(line.kind))).toHaveLength(0);
    expect(lines.filter((line) => line.kind === 'token')).toHaveLength(1);
    // The next refresh retires the absorbed file and serves the rollup.
    const after = await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    expect(after.summary.allTime.tokens).toBe(200);
    expect(after.summary.allTime.githubCopilot.aiCredits).toBe(4);
    expect(after.summary.chats).toHaveLength(1);
    expect(after.summary.chats[0].records).toHaveLength(1);
    expect(after.diagnostics).toContain('Attributed requests for this account: 2');
    names = await files(f.storage);
    expect(names.filter((name) => name.startsWith('snapshot-'))).toHaveLength(1);
    expect(names.some((name) => name.startsWith('ledger'))).toBe(false);
    // A new window needs only the snapshot, including the auth history it kept.
    await rm(f.log);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    const view = await restarted.refresh(aggregateUsage([], f.settled), f.settled);
    expect(view.account).toBe('alice');
    expect(view.summary.allTime.tokens).toBe(200);
    expect(restarted.getRetainedChatIds()).toEqual(['chat']);
    // Another account's window hides the frozen usage.
    await writeFile(f.log, auth('Bob', f.settled.getTime()));
    const bob = await restarted.refresh(aggregateUsage([]), new Date(f.settled.getTime() + 5_000));
    expect(bob.account).toBe('bob');
    expect(bob.summary.allTime.tokens).toBe(0);
    expect(bob.diagnostics).toContain('Attributed requests for this account: 0');
  });

  it('never appends a request older than the freeze window, not even for a rename', async () => {
    const f = await fixture();
    const a = record(f.usage);
    await appendFile(f.log, done(a));
    await f.tracking.refresh(aggregateUsage([a]), new Date(base + 30_000));
    const later = new Date(base + 8 * DAY);
    vi.mocked(appendFile).mockClear();
    const renamed = { ...a, metadataOnly: true, titlePriority: TITLE_PRIORITY.custom,
      timestamp: new Date(base + 20_000), titleModifiedAt: base + 40_000, title: 'Renamed' };
    const view = await f.tracking.refresh(aggregateUsage([a, renamed], later), later);
    expect(view.summary.chats[0].title).toBe('Renamed');
    expect(view.summary.allTime.tokens).toBe(100);
    // A request first seen this late may already sit inside a rollup, so it is not saved.
    const missed = record(f.usage, base + 50_000, 'missed');
    await appendFile(f.log, done(missed));
    const ignored = await f.tracking.refresh(aggregateUsage([a, missed], later), later);
    expect(ignored.summary.allTime.tokens).toBe(100);
    expect(ignored.pending).toBe(0);
    expect(vi.mocked(appendFile).mock.calls.filter(([file]) => String(file).startsWith(f.storage))).toHaveLength(0);
  });

  it('rebuilds other windows from the snapshot, retires absorbed files, and salvages late appends', async () => {
    const f = await frozenFixture();
    const other = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    expect((await other.refresh(aggregateUsage([], f.later), f.later)).summary.allTime.tokens).toBe(200);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    // A window whose append was in flight during the roll lands a whole line, then dies mid-write.
    const [rolledName] = (await files(f.storage)).filter((name) => name.startsWith('ledger-'));
    const late = record(f.usage, f.settled.getTime() - 10_000, 'late');
    await appendFile(f.log, done(late));
    const lateLine = JSON.stringify({ kind: 'bill', key: savedKey(late), record: late, sessionStart: base + 1_000 });
    await appendFile(join(f.storage, rolledName), `\n${lateLine}\n{"kind":"bill","key":"torn`);
    const view = await other.refresh(aggregateUsage([], f.settled), f.settled);
    expect(view.summary.allTime.tokens).toBe(300);
    expect(view.summary.chats[0].records).toHaveLength(2);
    expect(await files(f.storage)).not.toContain(rolledName);
    expect(await readFile(join(f.storage, 'ledger.jsonl'), 'utf8')).toContain(lateLine);
    expect((await f.tracking.refresh(aggregateUsage([], f.settled), f.settled)).summary.allTime.tokens).toBe(300);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([], f.settled), f.settled)).summary.allTime.tokens).toBe(300);
  });

  it('retains request evidence for the full seven-day window', async () => {
    const f = await fixture();
    const row = record(f.usage);
    await appendFile(f.log, done(row));
    const now = new Date(base + 6 * DAY);
    const view = await f.tracking.refresh(aggregateUsage([row], now), now);
    expect(view.summary.allTime.tokens).toBe(100);
    expect(view.diagnostics).toContain('Attributed requests for this account: 1');
    expect(await files(f.storage)).toEqual(['ledger.jsonl']);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([], now), now)).summary.allTime.tokens).toBe(100);
  });

  it('keeps one snapshot when two windows freeze the same rolled ledger', async () => {
    const f = await frozenFixture();
    const other = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    await other.refresh(aggregateUsage([], f.later), f.later);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let raced = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (!raced && /snapshot-.*\.tmp$/.test(String(args[0]))) {
        raced = true;
        // The other window has not seen a snapshot yet, so it freezes too.
        await other.refresh(aggregateUsage([], f.settled), f.settled);
      }
      return fs.open(...args);
    });
    expect((await f.tracking.refresh(aggregateUsage([], f.settled), f.settled)).summary.allTime.tokens).toBe(200);
    expect(raced).toBe(true);
    vi.mocked(open).mockImplementation(fs.open);
    expect((await files(f.storage)).filter((name) => name.startsWith('snapshot-'))).toHaveLength(1);
    const later = new Date(f.settled.getTime() + 2_000);
    for (const window of [f.tracking, other]) {
      expect((await window.refresh(aggregateUsage([], later), later)).summary.allTime.tokens).toBe(200);
    }
    const names = await files(f.storage);
    expect(names.filter((name) => name.startsWith('snapshot-'))).toHaveLength(1);
    expect(names.some((name) => name.startsWith('ledger'))).toBe(false);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([], later), later)).summary.allTime.tokens).toBe(200);
  });

  it('deduplicates a frozen request while preserving a distinct late old request', async () => {
    const f = await frozenFixture();
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    const [rolledName] = (await files(f.storage)).filter((name) => name.startsWith('ledger-'));
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    const late = record(f.usage, base + 25_000, 'late-old');
    const lateEntries = [f.a, late].flatMap((row) => [
      { kind: 'bill', key: savedKey(row), record: row, sessionStart: base + 1_000 },
      ...parseAccountEvidence(done(row), f.stream),
    ]);
    await appendFile(join(f.storage, rolledName), lateEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    for (let poll = 0; poll < 3; poll++) {
      const now = new Date(f.settled.getTime() + poll * 11 * 60_000);
      const view = await restarted.refresh(aggregateUsage([], now), now);
      expect(view.summary.allTime.tokens).toBe(300);
      expect(view.diagnostics).toContain('Attributed requests for this account: 3');
    }
    const now = new Date(f.settled.getTime() + 33 * 60_000);
    expect((await new AccountTracking(f.storage, f.stream, [f.logRoot]).refresh(aggregateUsage([], now), now)).summary.allTime.tokens).toBe(300);
  });

  it('does not replace a newer complete snapshot with a paused stale publisher', async () => {
    const f = await frozenFixture();
    const other = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    const [rolledName] = (await files(f.storage)).filter((name) => name.startsWith('ledger-'));
    const late = record(f.usage, base + 25_000, 'late-old');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let raced = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (!raced && /snapshot-.*\.tmp$/.test(String(args[0]))) {
        raced = true;
        const entries = [{ kind: 'bill', key: savedKey(late), record: late, sessionStart: base + 1_000 },
          ...parseAccountEvidence(done(late), f.stream)];
        await fs.appendFile(join(f.storage, rolledName), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        for (let poll = 0; poll < 2; poll++) {
          expect((await other.refresh(aggregateUsage([], f.settled), f.settled)).summary.allTime.tokens).toBe(300);
        }
        expect(await files(f.storage)).not.toContain(rolledName);
      }
      return fs.open(...args);
    });
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    expect(raced).toBe(true);
    vi.mocked(open).mockImplementation(fs.open);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await restarted.refresh(aggregateUsage([], f.settled), f.settled)).summary.allTime.tokens).toBe(300);
    expect((await files(f.storage)).filter((name) => name.startsWith('snapshot-'))).toHaveLength(1);
  });

  it('keeps a frozen chat following renames without touching its totals', async () => {
    const f = await frozenFixture();
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    const now = new Date(f.settled.getTime() + 2_000);
    const renamed = { ...f.a, metadataOnly: true, titlePriority: TITLE_PRIORITY.custom,
      timestamp: new Date(base + 20_000), titleModifiedAt: now.getTime(), title: 'Frozen rename' };
    vi.mocked(appendFile).mockClear();
    const view = await f.tracking.refresh(aggregateUsage([], now), now, [renamed]);
    expect(view.summary.chats[0].title).toBe('Frozen rename');
    expect(view.summary.allTime.tokens).toBe(200);
    expect(appendFile).toHaveBeenCalledTimes(1);
    const lines = (await readFile(join(f.storage, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(lines).toEqual([expect.objectContaining({ kind: 'rollup', requests: 2 })]);
    // Copilot bumping the chat file without a new label writes nothing more.
    const bumped = await f.tracking.refresh(aggregateUsage([], now), now, [{ ...renamed, titleModifiedAt: now.getTime() + 1 }]);
    expect(bumped.summary.chats[0].title).toBe('Frozen rename');
    expect(appendFile).toHaveBeenCalledTimes(1);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    const saved = await restarted.refresh(aggregateUsage([], now), now);
    expect(saved.summary.chats[0].title).toBe('Frozen rename');
    expect(saved.summary.allTime.tokens).toBe(200);
    expect(saved.summary.allTime.githubCopilot.aiCredits).toBe(4);
  });

  it('batches snapshot bills aging out between polls without changing their totals', async () => {
    const f = await frozenFixture();
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    const [name] = (await files(f.storage)).filter((file) => file.startsWith('snapshot-'));
    const path = join(f.storage, name);
    const lines = await snapshotLines(f.storage);
    for (let index = 0; index < 3; index++) {
      const row = record(f.usage, f.settled.getTime() - 7 * DAY + 1_000 + index * 2_000, `aging-${index}`);
      lines.push({ kind: 'bill', key: savedKey(row), record: row, sessionStart: base + 1_000 },
        ...parseAccountEvidence(done(row), f.stream));
    }
    lines[0].lines = lines.length - 1;
    const saved = lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path, saved);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    for (const elapsed of [0, 2_000, 4_000, 6_000]) {
      const now = new Date(f.settled.getTime() + elapsed);
      expect((await restarted.refresh(aggregateUsage([], now), now)).summary.allTime.tokens).toBe(500);
      expect(await files(f.storage)).toEqual([name]);
      expect(await readFile(path, 'utf8')).toBe(saved);
    }
    const batchedAt = new Date(f.settled.getTime() + 10 * 60_000);
    expect((await restarted.refresh(aggregateUsage([], batchedAt), batchedAt)).summary.allTime.tokens).toBe(500);
    expect((await files(f.storage)).filter((file) => file.startsWith('snapshot-'))).toHaveLength(2);
    const nextWindow = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    expect((await nextWindow.refresh(aggregateUsage([], batchedAt), batchedAt)).summary.allTime.tokens).toBe(500);
    expect((await snapshotLines(f.storage)).filter((entry) => entry.kind === 'bill')).toHaveLength(0);
  });

  it('merges frozen and live usage the same way one aggregate would', async () => {
    const f = await frozenFixture();
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    const now = new Date(f.settled.getTime() + 60_000);
    const continued = record(f.usage, now.getTime() - 30_000, 'continued');
    const otherUsage = join(f.root, 'debug-logs', 'other', 'main.jsonl');
    await mkdir(join(f.root, 'debug-logs', 'other'));
    await writeFile(otherUsage, JSON.stringify({ type: 'session_start', ts: base + 1_000 }) + '\n');
    const fresh = { ...record(otherUsage, now.getTime() - 20_000, 'fresh'), chatId: 'other', title: 'Other chat', model: 'other-model',
      tokens: { input: 200, output: 100, cachedInput: 0, cacheWriteInput: 0, total: 300, source: 'recorded' as const },
      billing: { aiCredits: 5, source: 'copilot-debug-log' as const } };
    await appendFile(f.log, done(continued) + done(fresh));
    const view = await f.tracking.refresh(aggregateUsage([continued, fresh], now), now);
    const rollup: UsageRecord = { chatId: 'chat', title: 'A chat', model: 'model', timestamp: f.b.timestamp, filePath: f.usage,
      tokens: { input: 160, output: 40, cachedInput: 20, cacheWriteInput: 0, total: 200, source: 'recorded' },
      billing: { aiCredits: 4, source: 'copilot-debug-log' } };
    const expected = aggregateUsage([rollup, continued, fresh], now);
    const shape = (summary: UsageSummary) => ({
      today: summary.today, week: summary.week, month: summary.month, allTime: summary.allTime, topModels: summary.topModels,
      chats: summary.chats.map((chat) => ({ chatId: chat.chatId, title: chat.title, tokens: chat.tokens, cost: chat.githubCopilot,
        at: chat.timestamp.getTime(), records: chat.records.length })),
      highest: summary.highestSessionToday?.chatId, priciest: summary.mostExpensiveSessionToday?.chatId,
    });
    expect(shape(view.summary)).toEqual(shape(expected));
    // The frozen Monday usage is outside this week but remains in this month.
    expect(view.summary.week.tokens).toBe(400);
    expect(view.summary.month.tokens).toBe(600);
    expect(view.summary.today.tokens).toBe(400);
    expect(view.summary.topModels.map((model) => model.model)).toEqual(['model', 'other-model']);
  });

  it.each(['malformed', 'truncated', 'missing line', 'empty', 'blank lines', 'headerless'] as const)(
    'rejects a %s snapshot on every refresh without retiring its source ledger', async (damage) => {
      const f = await frozenFixture();
      await f.tracking.refresh(aggregateUsage([], f.later), f.later);
      await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
      const names = await files(f.storage);
      const source = join(f.storage, names.find((name) => name.startsWith('ledger-'))!);
      const sourceBytes = await readFile(source);
      const path = join(f.storage, names.find((name) => name.startsWith('snapshot-'))!);
      const original = await readFile(path, 'utf8');
      const lines = original.split('\n').filter(Boolean);
      const corrupt = damage === 'empty' ? '' : damage === 'blank lines' ? '\n'.repeat(70_000)
        : damage === 'missing line' ? lines.slice(0, -1).join('\n') + '\n'
        : damage === 'headerless' ? '\n'.repeat(70_000) + lines.slice(1).join('\n') + '\n'
        : damage === 'truncated' ? original.slice(0, -3)
        : lines.map((line) => line.includes('"kind":"rollup"') ? '{"kind":"rollup",' : line).join('\n') + '\n';
      await writeFile(path, corrupt);
      const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(restarted.refresh(aggregateUsage([], f.settled), f.settled)).rejects.toThrow('Invalid account tracking snapshot');
        expect(await readFile(source)).toEqual(sourceBytes);
        expect(await readFile(path, 'utf8')).toBe(corrupt);
      }
    },
  );

  it.each(['start.json', 'ledger.jsonl', '../outside.jsonl', 'snapshot-1-abc.jsonl'])(
    'rejects snapshot permission to retire %s', async (name) => {
      const f = await frozenFixture();
      await f.tracking.refresh(aggregateUsage([], f.later), f.later);
      await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
      const snapshot = (await files(f.storage)).find((file) => file.startsWith('snapshot-'))!;
      const path = join(f.storage, snapshot);
      const lines = await snapshotLines(f.storage);
      lines[0].absorbed.push({ name, bytes: 0 });
      await writeFile(path, lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const start = await readFile(join(f.storage, 'start.json'));
      const names = await readdir(f.storage);
      const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(restarted.refresh(aggregateUsage([], f.settled), f.settled)).rejects.toThrow('Invalid account tracking snapshot');
        expect(await readdir(f.storage)).toEqual(names);
        expect(await readFile(join(f.storage, 'start.json'))).toEqual(start);
      }
    },
  );

  it('keeps failing on a corrupt rollup without touching the snapshot', async () => {
    const f = await frozenFixture();
    await f.tracking.refresh(aggregateUsage([], f.later), f.later);
    await f.tracking.refresh(aggregateUsage([], f.settled), f.settled);
    const [name] = (await files(f.storage)).filter((file) => file.startsWith('snapshot-'));
    const path = join(f.storage, name);
    const corrupt = (await readFile(path, 'utf8')).replace('"aiCredits":4', '"aiCredits":"4"');
    expect(corrupt).toContain('"aiCredits":"4"');
    await writeFile(path, corrupt);
    const restarted = new AccountTracking(f.storage, f.stream, [f.logRoot]);
    await expect(restarted.refresh(aggregateUsage([], f.settled), f.settled)).rejects.toThrow('Invalid account tracking request journal');
    await expect(restarted.refresh(aggregateUsage([], f.settled), f.settled)).rejects.toThrow('Invalid account tracking request journal');
    expect(await readFile(path, 'utf8')).toBe(corrupt);
  });
});
