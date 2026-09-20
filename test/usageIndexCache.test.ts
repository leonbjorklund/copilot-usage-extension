import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) };
});

import * as parser from '../src/core/parser';
import { UsageIndex } from '../src/core/usageIndex';
import { MAX_USAGE_INDEX_CACHE_BYTES } from '../src/core/usageIndexCache';

const directories: string[] = [];
const now = new Date('2026-05-28T12:00:00Z');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-index-cache-'));
  directories.push(directory);
  const root = join(directory, 'source');
  const cache = join(directory, 'cache');
  await mkdir(root);
  const options = { roots: [root], config: { dataPath: root, maxFileSizeMb: 10, maxScanDepth: 6 }, now };
  return { directory, root, cache, options };
}

function usage(id: string, tokens: number) {
  return {
    type: 'llm_request', sid: id, ts: Date.parse('2026-05-28T08:00:00Z'), spanId: `span-${id}`, dur: 10,
    attrs: { debugName: id, model: 'gpt-test', responseId: `response-${id}`, inputTokens: tokens, outputTokens: 0, copilotUsageNanoAiu: tokens * 1_000_000 },
  };
}

function line(id: string, tokens: number) { return `${JSON.stringify(usage(id, tokens))}\n`; }
async function cacheFile(cache: string) { return join(cache, (await readdir(cache)).find((file) => file.endsWith('.cache'))!); }

afterEach(async () => {
  vi.restoreAllMocks();
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementation(fs.open);
  vi.mocked(rename).mockImplementation(fs.rename);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('persistent UsageIndex cache', () => {
  it('restores records and title dates, recomputes calendar totals, and never rereads unchanged source content', async () => {
    const { root, cache, options } = await fixture();
    const billed = join(root, 'debug-logs', 'billed');
    await mkdir(billed, { recursive: true });
    await writeFile(join(billed, 'main.jsonl'), line('billed', 7));
    await writeFile(join(root, 'other.json'), JSON.stringify(usage('other', 5)));
    await writeFile(join(root, 'empty.json'), '{}');
    await writeFile(join(billed, 'title-response.json'), JSON.stringify({
      type: 'agent_response', ts: Date.parse('2026-05-28T08:00:01Z'),
      attrs: { response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Saved title' }] }]) },
    }));
    const first = new UsageIndex();
    const expected = await first.rebuild(options);
    await first.save(cache);
    const parse = vi.spyOn(parser, 'parseUsageFile');
    const restored = new UsageIndex();
    expect(await restored.restore(options, cache)).toEqual(expected);
    expect(restored.getWatchFolders()).toEqual(first.getWatchFolders());
    vi.mocked(open).mockClear();
    expect(await restored.poll(options)).toEqual(expected);
    expect(parse).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    const nextDay = await restored.poll({ ...options, now: new Date('2026-05-29T12:00:00Z') });
    expect(nextDay.summary.today.tokens).toBe(0);
    expect(nextDay.summary.allTime.tokens).toBe(12);
    expect(nextDay.summary.chats.every((chat) => chat.timestamp instanceof Date)).toBe(true);
    expect(nextDay.summary.chats.find((chat) => chat.chatId === 'billed')?.titleTimestamp).toBeInstanceOf(Date);
    expect(nextDay.titleMetadata?.[0].timestamp).toBeInstanceOf(Date);
    expect(nextDay.titleMetadata?.[0].titleModifiedAt).toBeGreaterThan(0);
  });

  it('verifies the old prefix and appends after restart without reparsing old requests', async () => {
    const { root, cache, options } = await fixture();
    const source = join(root, 'usage.jsonl');
    await writeFile(source, line('first', 7));
    const first = new UsageIndex();
    await first.rebuild(options);
    await first.save(cache);
    const restored = new UsageIndex();
    await restored.restore(options, cache);
    const parse = vi.spyOn(parser, 'parseUsageFile');
    await appendFile(source, line('second', 5));
    expect((await restored.poll(options)).summary.allTime.tokens).toBe(12);
    expect(parse).not.toHaveBeenCalled();
    await restored.save(cache);
    const again = new UsageIndex();
    expect((await again.restore(options, cache))?.summary.allTime.tokens).toBe(12);
    await appendFile(source, line('third', 3));
    expect((await again.poll(options)).summary.allTime.tokens).toBe(15);
    expect(parse).not.toHaveBeenCalled();
  });

  it('restores only currently retained title metadata and discovers newly retained titles during reconciliation', async () => {
    const { root, cache, options } = await fixture();
    const folder = join(root, 'chatSessions');
    await mkdir(folder);
    for (const id of ['old-chat', 'next-chat']) {
      await writeFile(join(folder, `${id}.json`), JSON.stringify({
        kind: 0, v: { sessionId: id, customTitle: `Title ${id}`, creationDate: now.getTime() },
      }));
    }
    const first = new UsageIndex();
    const original = await first.rebuild({ ...options, retainedChatIds: ['old-chat'] });
    expect(original.titleMetadata?.map((record) => record.chatId)).toEqual(['old-chat']);
    await first.save(cache);
    const restored = new UsageIndex();
    const result = await restored.restore({ ...options, retainedChatIds: ['next-chat'] }, cache);
    expect(result?.titleMetadata).toEqual([]);
    expect(result?.summary.allTime.tokens).toBe(0);
    const refreshed = await restored.poll(options);
    expect(refreshed.titleMetadata?.map((record) => record.chatId)).toEqual(['next-chat']);
    expect(refreshed.titleMetadata?.[0].timestamp).toBeInstanceOf(Date);
    expect(refreshed.titleMetadata?.[0].titlePriority).toBe(5);
    expect(refreshed.summary.allTime.tokens).toBe(0);
  });

  it('rejects rewritten prefixes even when a larger rewrite preserves the cached byte boundary', async () => {
    const { root, cache, options } = await fixture();
    const source = join(root, 'usage.jsonl');
    await writeFile(source, line('first', 7));
    const first = new UsageIndex();
    await first.rebuild(options);
    await first.save(cache);
    const restored = new UsageIndex();
    await restored.restore(options, cache);
    await writeFile(source, line('first', 9) + line('second', 5));
    expect((await restored.poll(options)).summary.allTime.tokens).toBe(14);
  });

  it('reconciles same-size JSON and JSONL rewrites, truncated and deleted files, and new files', async () => {
    const { root, cache, options } = await fixture();
    const json = join(root, 'usage.json');
    const jsonl = join(root, 'usage.jsonl');
    const truncated = join(root, 'truncated.jsonl');
    const deleted = join(root, 'deleted.json');
    await writeFile(json, JSON.stringify(usage('json', 7)));
    await writeFile(jsonl, line('jsonl', 7));
    await writeFile(truncated, line('kept', 3) + line('lost', 5));
    await writeFile(deleted, JSON.stringify(usage('deleted', 4)));
    await utimes(json, now, now);
    await utimes(jsonl, now, now);
    const first = new UsageIndex();
    await first.rebuild(options);
    await first.save(cache);
    await writeFile(json, JSON.stringify(usage('json', 9)));
    await writeFile(jsonl, line('jsonl', 9));
    await utimes(json, new Date(now.getTime() + 1000), new Date(now.getTime() + 1000));
    await utimes(jsonl, new Date(now.getTime() + 1000), new Date(now.getTime() + 1000));
    await truncate(truncated, Buffer.byteLength(line('kept', 3)));
    await rm(deleted);
    await writeFile(join(root, 'new.json'), JSON.stringify(usage('new', 2)));
    const restored = new UsageIndex();
    expect((await restored.restore(options, cache))?.summary.allTime.tokens).toBe(26);
    const fresh = await new UsageIndex().rebuild(options);
    const reconciled = await restored.poll(options);
    expect(reconciled.summary.allTime.tokens).toEqual(fresh.summary.allTime.tokens);
    expect(reconciled.summary.allTime.githubCopilot.aiCredits).toBeCloseTo(fresh.summary.allTime.githubCopilot.aiCredits, 12);
    expect(reconciled.summary.allTime.githubCopilot.usd).toBeCloseTo(fresh.summary.allTime.githubCopilot.usd, 12);
    expect(reconciled.diagnostics).toEqual(fresh.diagnostics);
    expect(reconciled.summary.chats.sort((a, b) => a.chatId.localeCompare(b.chatId)))
      .toEqual(fresh.summary.chats.sort((a, b) => a.chatId.localeCompare(b.chatId)));
    expect(fresh.summary.allTime.tokens).toBe(23);
  });

  it('persists consumed offsets for incomplete appended lines across another restart', async () => {
    const { root, cache, options } = await fixture();
    const source = join(root, 'usage.jsonl');
    await writeFile(source, line('first', 7));
    const first = new UsageIndex();
    await first.rebuild(options);
    await appendFile(source, JSON.stringify(usage('second', 5)));
    expect((await first.poll(options)).summary.allTime.tokens).toBe(7);
    await first.save(cache);
    const restored = new UsageIndex();
    expect((await restored.restore(options, cache))?.summary.allTime.tokens).toBe(7);
    await appendFile(source, '\n');
    expect((await restored.poll(options)).summary.allTime.tokens).toBe(12);
  });

  it('retries nonappendable JSONL rather than trusting its restored revision', async () => {
    const { root, cache, options } = await fixture();
    await writeFile(join(root, 'usage.jsonl'), JSON.stringify(usage('first', 7)));
    const first = new UsageIndex();
    await first.rebuild(options);
    await first.save(cache);
    const restored = new UsageIndex();
    await restored.restore(options, cache);
    const parse = vi.spyOn(parser, 'parseUsageFile');
    expect((await restored.poll(options)).summary.allTime.tokens).toBe(7);
    expect(parse).toHaveBeenCalledOnce();
  });

  it('avoids writing unchanged polls and persists both watcher changes and explicit rebuilds', async () => {
    const { root, cache, options } = await fixture();
    const source = join(root, 'usage.json');
    await writeFile(source, JSON.stringify(usage('first', 7)));
    await writeFile(join(root, 'marker-free.jsonl'), '{}\n');
    const first = new UsageIndex();
    await first.rebuild(options);
    await first.save(cache);
    vi.mocked(rename).mockClear();
    await first.poll(options);
    await first.save(cache);
    await first.save(cache);
    expect(rename).not.toHaveBeenCalled();
    await writeFile(source, JSON.stringify(usage('next', 9)));
    await first.applyChanges({ ...options, pathsToDelete: [], pathsToUpdate: [source] });
    await first.save(cache);
    expect(rename).toHaveBeenCalledOnce();
    expect((await new UsageIndex().restore(options, cache))?.summary.allTime.tokens).toBe(9);
    await first.rebuild(options);
    await first.save(cache);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('returns a miss for missing, truncated, oversized and incompatible caches', async () => {
    const { root, cache, options } = await fixture();
    expect(await new UsageIndex().restore(options, cache)).toBeUndefined();
    await writeFile(join(root, 'usage.json'), JSON.stringify(usage('first', 7)));
    const index = new UsageIndex();
    await index.rebuild(options);
    await index.save(cache);
    const path = await cacheFile(cache);
    const valid = await readFile(path, 'utf8');
    for (const content of ['{', JSON.stringify({ ...JSON.parse(valid), version: 99 }), JSON.stringify({ ...JSON.parse(valid), scope: {} })]) {
      await writeFile(path, content);
      expect(await new UsageIndex().restore(options, cache)).toBeUndefined();
    }
    await truncate(path, MAX_USAGE_INDEX_CACHE_BYTES + 1);
    expect(await new UsageIndex().restore(options, cache)).toBeUndefined();
  });

  it.each(['date', 'tokens', 'billing', 'digest', 'offset', 'path', 'key', 'recordPath', 'watchFolder', 'duplicate', 'diagnostics'])(
    'rejects invalid cached %s without partially restoring records', async (invalid) => {
      const { root, cache, directory, options } = await fixture();
      await writeFile(join(root, 'usage.jsonl'), line('first', 7));
      const index = new UsageIndex();
      await index.rebuild(options);
      await index.save(cache);
      const path = await cacheFile(cache);
      const value = JSON.parse(await readFile(path, 'utf8'));
      const file = value.files[0];
      if (invalid === 'date') file.records[0].timestamp = 'not a date';
      if (invalid === 'tokens') file.records[0].tokens.total = -1;
      if (invalid === 'billing') file.records[0].billing.aiCredits = '7';
      if (invalid === 'digest') file.jsonlPrefixDigest = 'broken';
      if (invalid === 'offset') file.jsonlOffsetBytes = file.sizeBytes + 1;
      if (invalid === 'path') file.filePath = join(directory, 'outside.jsonl');
      if (invalid === 'key') file.key = join(root, 'another.jsonl');
      if (invalid === 'recordPath') file.records[0].filePath = join(directory, 'outside.jsonl');
      if (invalid === 'watchFolder') value.watchFolders = [directory];
      if (invalid === 'duplicate') value.files.push(file);
      if (invalid === 'diagnostics') value.diagnostics.scannedFiles = null;
      await writeFile(path, JSON.stringify(value));
      const restored = new UsageIndex();
      expect(await restored.restore(options, cache)).toBeUndefined();
      expect(restored.getWatchFolders()).toEqual([]);
      expect((await restored.rebuild(options)).summary.allTime.tokens).toBe(7);
    },
  );

  it('isolates roots and scan settings, including concurrent writers', async () => {
    const first = await fixture();
    const second = await fixture();
    await writeFile(join(first.root, 'usage.json'), JSON.stringify(usage('first', 7)));
    await writeFile(join(second.root, 'usage.json'), JSON.stringify(usage('second', 5)));
    const a = new UsageIndex();
    const b = new UsageIndex();
    await a.rebuild(first.options);
    await b.rebuild(second.options);
    await Promise.all([a.save(first.cache), b.save(first.cache)]);
    expect((await readdir(first.cache)).filter((file) => file.endsWith('.cache'))).toHaveLength(2);
    expect((await new UsageIndex().restore(first.options, first.cache))?.summary.allTime.tokens).toBe(7);
    expect((await new UsageIndex().restore(second.options, first.cache))?.summary.allTime.tokens).toBe(5);
    for (const config of [
      { ...first.options.config, maxScanDepth: 2 },
      { ...first.options.config, maxFileSizeMb: 1 },
      { ...first.options.config, dataPath: '' },
    ]) expect(await new UsageIndex().restore({ ...first.options, config }, first.cache)).toBeUndefined();
  });

  it('keeps the previous complete snapshot on publication failure and retries the changed revision', async () => {
    const { root, cache, options } = await fixture();
    const source = join(root, 'usage.jsonl');
    await writeFile(source, line('first', 7));
    const index = new UsageIndex();
    await index.rebuild(options);
    await index.save(cache);
    await appendFile(source, line('next', 5));
    await index.poll(options);
    vi.mocked(rename).mockRejectedValueOnce(new Error('EPERM'));
    await expect(index.save(cache)).rejects.toThrow('EPERM');
    expect(await readdir(cache)).toHaveLength(1);
    expect((await new UsageIndex().restore(options, cache))?.summary.allTime.tokens).toBe(7);
    await index.save(cache);
    expect((await new UsageIndex().restore(options, cache))?.summary.allTime.tokens).toBe(12);
  });

  it('publishes a whole valid snapshot when two windows save the same scope concurrently', async () => {
    const { root, cache, options } = await fixture();
    const source = join(root, 'usage.jsonl');
    await writeFile(source, line('first', 7));
    const first = new UsageIndex();
    await first.rebuild(options);
    await appendFile(source, line('next', 5));
    const second = new UsageIndex();
    await second.rebuild(options);
    await Promise.all([first.save(cache), second.save(cache)]);
    expect(await readdir(cache)).toHaveLength(1);
    const restored = new UsageIndex();
    const result = await restored.restore(options, cache);
    expect([7, 12]).toContain(result?.summary.allTime.tokens);
    expect((await restored.poll(options)).summary.allTime.tokens).toBe(12);
  });

  it('does not scan its own saved cache under an overlapping custom data root', async () => {
    const { root, options } = await fixture();
    await writeFile(join(root, 'usage.json'), JSON.stringify(usage('first', 7)));
    const index = new UsageIndex();
    await index.rebuild(options);
    await index.save(root);
    expect((await index.poll(options)).diagnostics.files).toBe(1);
    await index.save(root);
    vi.mocked(rename).mockClear();
    expect((await index.poll(options)).summary.allTime.tokens).toBe(7);
    await index.save(root);
    expect(rename).not.toHaveBeenCalled();
  });
});
