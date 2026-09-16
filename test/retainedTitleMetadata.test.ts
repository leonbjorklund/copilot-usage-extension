import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as parser from '../src/core/parser';
import { UsageIndex } from '../src/core/usageIndex';

const roots: string[] = [];
const now = new Date('2026-09-07T12:00:00Z');

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'copilot-retained-titles-'));
  roots.push(root);
  const folder = join(root, 'chatSessions');
  await mkdir(folder);
  const file = join(folder, 'saved-chat.json');
  await writeFile(file, customTitle('Saved title'));
  await utimes(file, now, now);
  const options = { now, config: { dataPath: root, maxFileSizeMb: 10, maxScanDepth: 6 } };
  return { root, folder, file, options };
}

function customTitle(title: string, chatId = 'saved-chat') {
  return JSON.stringify({ kind: 0, v: { sessionId: chatId, customTitle: title, creationDate: now.getTime() } });
}

describe('retained chat title metadata', () => {
  it('discovers saved chat titles without inventing usage or reading untracked titles', async () => {
    const f = await fixture();
    await writeFile(join(f.folder, 'untracked-chat.json'), customTitle('Untracked title', 'untracked-chat'));
    const parse = vi.spyOn(parser, 'parseUsageFile');
    const result = await new UsageIndex().rebuild({ roots: [f.root], ...f.options, retainedChatIds: ['saved-chat'] });

    expect(result.summary.chats).toEqual([]);
    expect(result.summary.allTime.tokens).toBe(0);
    expect(result.summary.allTime.githubCopilot.aiCredits).toBe(0);
    expect(result.titleMetadata).toEqual([expect.objectContaining({
      chatId: 'saved-chat', title: 'Saved title', metadataOnly: true,
    })]);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(f.file, { mode: 'metadata' });
  });

  it('polls newly retained chats, caches unchanged JSON, and discovers delayed renames', async () => {
    const f = await fixture();
    const index = new UsageIndex();
    await index.rebuild({ roots: [f.root], ...f.options });
    const saved = await index.poll({ ...f.options, retainedChatIds: ['saved-chat'] });
    expect(saved.titleMetadata?.[0].title).toBe('Saved title');
    const parse = vi.spyOn(parser, 'parseUsageFile');
    expect(await index.poll(f.options)).toEqual(saved);
    expect(parse).not.toHaveBeenCalled();

    await writeFile(f.file, customTitle('Later title'));
    const modified = new Date(now.getTime() + 1000);
    await utimes(f.file, modified, modified);
    const renamed = await index.poll(f.options);
    expect(renamed.titleMetadata?.[0]).toMatchObject({ title: 'Later title', titleModifiedAt: modified.getTime() });
    expect(renamed.summary.chats).toEqual([]);
    expect(renamed.summary.allTime.tokens).toBe(0);
  });

  it('discovers newly retained chats during incremental refresh and prunes removed IDs', async () => {
    const f = await fixture();
    const index = new UsageIndex();
    await index.rebuild({ roots: [f.root], ...f.options });
    const changes = { ...f.options, pathsToUpdate: [], pathsToDelete: [] };
    const saved = await index.applyChanges({ ...changes, retainedChatIds: ['saved-chat'] });
    expect(saved.titleMetadata?.[0].title).toBe('Saved title');

    const pruned = await index.applyChanges({ ...changes, retainedChatIds: [] });
    expect(pruned.titleMetadata).toEqual([]);
    expect(pruned.diagnostics.files).toBe(0);
  });

  it('drops deleted metadata while retaining the saved chat ID for later reappearance', async () => {
    const f = await fixture();
    const index = new UsageIndex();
    await index.rebuild({ roots: [f.root], ...f.options, retainedChatIds: ['saved-chat'] });
    await rm(f.file);
    expect((await index.poll(f.options)).titleMetadata).toEqual([]);
    await writeFile(f.file, customTitle('Recovered title'));
    expect((await index.poll(f.options)).titleMetadata?.[0].title).toBe('Recovered title');

    expect((await index.poll({ ...f.options, retainedChatIds: [] })).titleMetadata).toEqual([]);
  });

  it('resets retained chat IDs on a fresh rebuild without supplied IDs', async () => {
    const f = await fixture();
    const index = new UsageIndex();
    await index.rebuild({ roots: [f.root], ...f.options, retainedChatIds: ['saved-chat'] });
    const rebuilt = await index.rebuild({ roots: [f.root], ...f.options });
    expect(rebuilt.titleMetadata).toEqual([]);
    expect(rebuilt.diagnostics.files).toBe(0);
  });
});
