import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), readdir: vi.fn(actual.readdir) };
});

import * as fsPromises from 'node:fs/promises';

import { addRequest, emptyTally, loadTally, saveTally, scanDebugLogs, topModels, type Tally } from '../src/models';

const now = new Date(2026, 8, 23, 16).getTime();
const at = (day: number, hour = 12, month = 9) => new Date(2026, month - 1, day, hour).getTime();

/** One `llm_request` debug-log line, as Copilot writes it. */
function request(model: string, credits: number | undefined, ts = at(23, 10), spanId = '000000000000000b'): string {
  return `${JSON.stringify({ ts, dur: 3059, sid: 'chat', type: 'llm_request', name: `chat:${model}`, spanId, status: 'ok',
    attrs: { model, inputTokens: 38420, outputTokens: 58, ...(credits === undefined ? {} : { copilotUsageNanoAiu: credits * 1e9 }) } })}\n`;
}

function uses(tally: Tally): { [model: string]: [number, number] } {
  return Object.fromEntries([...tally.models].map(([model, use]) => [model, [use.nano / 1e9, use.chats.size]]));
}

describe('requests', () => {
  it('counts a costed request of this month once per chat', () => {
    const tally = emptyTally(now);
    expect(addRequest(tally, 'a', request('claude-opus-5', 4))).toBe(true);
    expect(addRequest(tally, 'a', request('claude-opus-5', 4))).toBe(false);
    // Every window numbers its spans from 1, so a repeated span with another start time is another request.
    expect(addRequest(tally, 'a', request('claude-opus-5', 2, at(23, 11)))).toBe(true);
    expect(addRequest(tally, 'b', request('claude-opus-5', 4))).toBe(true);
    expect(addRequest(tally, 'b', request('gpt-6-astra', 1, at(23, 12), '0000000000000001'))).toBe(true);
    // Parallel subagents can start in the same millisecond.
    expect(addRequest(tally, 'b', request('gpt-6-astra', 1, at(23, 12), '0000000000000002'))).toBe(true);
    expect(uses(tally)).toEqual({ 'claude-opus-5': [10, 2], 'gpt-6-astra': [2, 1] });
  });

  it('skips free, failed, other-month and malformed lines', () => {
    const tally = emptyTally(now);
    const lines = [
      request('gpt-4o-mini-2024-07-18', 0), request('claude-opus-5', undefined), request('claude-opus-5', 4, at(31, 23, 8)),
      request('claude-opus-5', 4, at(1, 0, 10)), request('claude-opus-5', 4).slice(0, 80), '',
      request('claude-opus-5', 4).replace('"llm_request"', '"tool_call"'), request('', 4),
      request('claude-opus-5', 4).replace('"spanId":"000000000000000b"', '"spanId":11'),
      request('claude-opus-5', 4).replace(`"ts":${at(23, 10)}`, `"ts":"${at(23, 10)}"`),
      request('claude-opus-5', -4), 'null', '[]',
    ];
    for (const line of lines) expect(addRequest(tally, 'a', line)).toBe(false);
    expect(tally.models.size).toBe(0);
  });
});

describe('scanning the debug logs', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const scan = (root: string, tally: Tally, read: Map<string, number>, time: number) =>
    scanDebugLogs(join(root, 'globalStorage'), join(root, 'workspaceStorage'), tally, read, time);

  async function user(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'copilot-credits-'));
    roots.push(root);
    return root;
  }

  async function log(folder: string, chat: string, name: string, text: string): Promise<string> {
    await mkdir(join(folder, chat), { recursive: true });
    await writeFile(join(folder, chat, name), text);
    return join(folder, chat, name);
  }

  const workspace = (root: string, id = 'abc') => join(root, 'workspaceStorage', id, 'GitHub.copilot-chat', 'debug-logs');
  const global = (root: string) => join(root, 'globalStorage', 'github.copilot-chat', 'debug-logs');

  it('reads every folder\'s chats and counts each chat\'s files, subagents included', async () => {
    const root = await user();
    await log(workspace(root), 'a', 'main.jsonl', request('claude-opus-5', 4) + request('gpt-6-astra', 3, at(23, 11)));
    await log(workspace(root), 'a', 'runSubagent-Explore-1.jsonl', request('claude-opus-5', 2, at(23, 12), '0000000000000001'));
    await log(workspace(root), 'a', 'models.json', request('claude-opus-5', 50, at(23, 13)));
    await log(workspace(root, 'def'), 'b', 'main.jsonl', request('claude-opus-5', 1));
    await log(global(root), 'c', 'main.jsonl', request('gemini-3.8-flash', 1));
    await mkdir(join(root, 'workspaceStorage', 'empty'), { recursive: true });
    // Folders without chats, and a file where a chat folder would be, leave the scan complete.
    await writeFile(join(global(root), 'loose.jsonl'), request('claude-opus-5', 50, at(23, 14)));
    const tally = emptyTally(now);
    expect(await scan(root, tally, new Map(), now)).toBe(true);
    expect(uses(tally)).toEqual({ 'claude-opus-5': [7, 2], 'gpt-6-astra': [3, 1], 'gemini-3.8-flash': [1, 1] });
    expect(tally.readAt).toBe(now);
  });

  it('reads only what a log gained, and waits for a line to end', async () => {
    const root = await user();
    const file = await log(workspace(root), 'a', 'main.jsonl', request('claude-opus-5', 4));
    const tally = emptyTally(now);
    const read = new Map<string, number>();
    await scan(root, tally, read, now);
    const length = request('claude-opus-5', 4).length;
    expect(read.get(file)).toBe(length);
    expect(await scan(root, tally, read, now + 1)).toBe(false);
    expect(tally.readAt).toBe(now);
    const next = request('claude-opus-5', 2, at(23, 11));
    await appendFile(file, next.slice(0, 50));
    expect(await scan(root, tally, read, now + 2)).toBe(false);
    expect(read.get(file)).toBe(length);
    await appendFile(file, next.slice(50));
    expect(await scan(root, tally, read, now + 3)).toBe(true);
    expect(read.get(file)).toBe(length + next.length);
    expect(uses(tally)).toEqual({ 'claude-opus-5': [6, 1] });
  });

  it('never counts a chat twice when reading it again after a restart or a trim', async () => {
    const root = await user();
    const file = await log(workspace(root), 'a', 'main.jsonl', request('claude-opus-5', 4) + request('claude-opus-5', 2, at(23, 11)));
    const first = emptyTally(now);
    await scan(root, first, new Map(), now);
    // A restart loads the saved tally and reads the logs from their start.
    const restarted = loadTally(JSON.parse(JSON.stringify(saveTally(first))), now);
    restarted.readAt = 0;
    const read = new Map<string, number>();
    expect(await scan(root, restarted, read, now + 1)).toBe(false);
    // Copilot trims a large log to its newest part, cutting its first line.
    await writeFile(file, request('claude-opus-5', 2, at(23, 11)).slice(20) + request('claude-opus-5', 1, at(23, 12)));
    expect(await scan(root, restarted, read, now + 2)).toBe(true);
    expect(uses(restarted)).toEqual({ 'claude-opus-5': [7, 1] });
  });

  it('keeps what it saw after Copilot deletes a chat', async () => {
    const root = await user();
    await log(workspace(root), 'a', 'main.jsonl', request('claude-opus-5', 4));
    const tally = emptyTally(now);
    await scan(root, tally, new Map(), now);
    await rm(join(workspace(root), 'a'), { recursive: true });
    expect(await scan(root, tally, new Map(), now + 1)).toBe(false);
    expect(uses(tally)).toEqual({ 'claude-opus-5': [4, 1] });
  });

  it('skips files untouched since the last full scan, or since the month began', async () => {
    const root = await user();
    const old = await log(workspace(root), 'a', 'main.jsonl', request('claude-opus-5', 4));
    const earlier = await log(workspace(root), 'b', 'main.jsonl', request('claude-opus-5', 1));
    // File times can trail the clock, so a file stamped just before the last scan is read again.
    const close = await log(workspace(root), 'c', 'main.jsonl', request('gpt-6-astra', 2));
    await utimes(old, new Date(now - 60_000), new Date(now - 60_000));
    await utimes(earlier, new Date(at(31, 12, 8)), new Date(at(31, 12, 8)));
    await utimes(close, new Date(now - 2000), new Date(now - 2000));
    const tally = { ...emptyTally(now), readAt: now - 1000 };
    expect(await scan(root, tally, new Map(), now)).toBe(true);
    expect(uses(tally)).toEqual({ 'gpt-6-astra': [2, 1] });
    tally.readAt = 0;
    expect(await scan(root, tally, new Map(), now)).toBe(true);
    expect(uses(tally)).toEqual({ 'gpt-6-astra': [2, 1], 'claude-opus-5': [4, 1] });
  });

  it('reads a line longer than one read', async () => {
    const root = await user();
    const long = request('claude-opus-5', 4).replace('"inputTokens"', `"inputMessages":"${'x'.repeat(9 * 1024 * 1024)}","inputTokens"`);
    await log(workspace(root), 'a', 'main.jsonl', long + request('claude-opus-5', 2, at(23, 11)));
    const tally = emptyTally(now);
    await scan(root, tally, new Map(), now);
    expect(uses(tally)).toEqual({ 'claude-opus-5': [6, 1] });
  });

  it('starts a new tally in a new month', async () => {
    const root = await user();
    await log(workspace(root), 'a', 'main.jsonl', request('claude-opus-5', 4, at(30, 12)));
    const tally = emptyTally(at(30, 13));
    const read = new Map<string, number>();
    await scan(root, tally, read, at(30, 13));
    expect(uses(tally)).toEqual({ 'claude-opus-5': [4, 1] });
    expect(await scan(root, tally, read, at(1, 10, 10))).toBe(true);
    expect(tally.month).toBe('2026-10');
    expect(uses(tally)).toEqual({});
  });

  it.each(['log', 'chat folder'])('leaves the scan incomplete when a %s cannot be read, so a restart reads it again', async (kind) => {
    const root = await user();
    await log(workspace(root), 'a', 'main.jsonl', request('claude-opus-5', 4));
    const failing = await log(workspace(root), 'b', 'main.jsonl', request('gpt-6-astra', 2));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const error = Object.assign(new Error('busy'), { code: 'EBUSY' });
    if (kind === 'log') {
      vi.mocked(fsPromises.stat).mockImplementation(async (path, options) => {
        if (String(path) === failing) throw error;
        return actual.stat(path, options);
      });
    } else {
      vi.mocked(fsPromises.readdir).mockImplementation((async (path: string) => {
        if (String(path) === join(workspace(root), 'b')) throw error;
        return actual.readdir(path);
      }) as typeof actual.readdir);
    }
    const tally = emptyTally(now);
    try {
      expect(await scan(root, tally, new Map(), now)).toBe(true);
    } finally {
      vi.mocked(fsPromises.stat).mockImplementation(actual.stat);
      vi.mocked(fsPromises.readdir).mockImplementation(actual.readdir);
    }
    expect(uses(tally)).toEqual({ 'claude-opus-5': [4, 1] });
    expect(tally.readAt).toBe(0);
    expect(await scan(root, tally, new Map(), now + 1)).toBe(true);
    expect(uses(tally)).toEqual({ 'claude-opus-5': [4, 1], 'gpt-6-astra': [2, 1] });
    expect(tally.readAt).toBe(now + 1);
  });
});

describe('saved tally', () => {
  it('loads what was saved, dropping anything malformed or from another month', () => {
    const tally = emptyTally(now);
    addRequest(tally, 'a', request('claude-opus-5', 4));
    addRequest(tally, '__proto__', request('constructor', 1));
    tally.readAt = now;
    const saved = JSON.parse(JSON.stringify(saveTally(tally)));
    const loaded = loadTally(saved, now);
    expect(loaded).toEqual(tally);
    expect(addRequest(loaded, 'a', request('claude-opus-5', 4))).toBe(false);
    expect(loadTally(saved, at(1, 12, 10))).toEqual(emptyTally(at(1, 12, 10)));
    for (const value of [undefined, null, 'text', 5, { month: 5 }]) expect(loadTally(value, now)).toEqual(emptyTally(now));
    expect(uses(loadTally({ month: '2026-09', models: {
      a: { nano: 1e9, chats: ['x', 5] }, b: { nano: -1, chats: [] }, c: null, d: { nano: 1e9, chats: 'x' },
    } }, now))).toEqual({ a: [1, 1], d: [1, 0] });
  });
});

describe('top models', () => {
  it('lists the 3 models with the most credits, their chats and share', () => {
    const tally = emptyTally(now);
    const spend: Array<[string, string, number]> = [['a', 'opus', 60], ['b', 'opus', 20], ['a', 'astra', 12.6], ['c', 'luna', 1.4],
      ['d', 'luna', 1], ['e', 'luna', 2], ['c', 'grok', 3]];
    for (const [index, [chat, model, credits]] of spend.entries()) addRequest(tally, chat, request(model, credits, at(23, 10 + index)));
    expect(topModels(tally)).toEqual([
      { model: 'opus', chats: 2, share: 80 }, { model: 'astra', chats: 1, share: expect.closeTo(12.6) },
      { model: 'luna', chats: 3, share: expect.closeTo(4.4) },
    ]);
  });

  it('lists nothing before any request', () => {
    expect(topModels(emptyTally(now))).toEqual([]);
  });
});
