import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UsageIndex } from '../src/core/usageIndex';
import type { ExtensionConfig } from '../src/core/types';

const config: ExtensionConfig = {
  dataPath: '',
  maxFileSizeMb: 10,
  maxScanDepth: 6,
};

function configForRoot(root: string): ExtensionConfig {
  return { ...config, dataPath: root };
}

describe('UsageIndex', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('rebuilds from disk and summarizes cached records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    await writeFile(join(root, 'usage.json'), JSON.stringify(usageRecord('json', 7)));
    await writeFile(join(root, 'usage.jsonl'), JSON.stringify(usageRecord('jsonl', 5)) + '\n');

    const index = new UsageIndex();
    const result = await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(12);
    expect(result.summary.chats.map((chat) => chat.chatId).sort()).toEqual(['json', 'jsonl']);
    expect(result.diagnostics.files).toBe(2);
    expect(result.diagnostics.normalizedRecords).toBe(2);
  });

  it('skips files without AI Credit markers before parsing usage content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    await writeFile(join(root, 'usage.jsonl'), JSON.stringify(usageRecord('billed', 7)) + '\n');
    await writeFile(join(root, 'old-session.json'), '{not valid json');

    const index = new UsageIndex();
    const result = await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(7);
    expect(result.diagnostics.files).toBe(1);
    expect(result.diagnostics.skippedMalformedFiles).toBe(0);
    expect(result.diagnostics.parsedRecords).toBe(1);
  });

  it('parses only metadata files for billed chat ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const billedDebugFolder = join(root, 'GitHub.copilot-chat', 'debug-logs', 'billed');
    const chatSessionsFolder = join(root, 'chatSessions');
    await mkdir(billedDebugFolder, { recursive: true });
    await mkdir(chatSessionsFolder, { recursive: true });
    await writeFile(join(billedDebugFolder, 'main.jsonl'), JSON.stringify(usageRecord('billed', 7)) + '\n');
    await writeFile(
      join(billedDebugFolder, 'title-response.jsonl'),
      JSON.stringify({
        type: 'agent_response',
        ts: Date.parse('2026-05-28T08:00:01.000Z'),
        attrs: {
          response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Billed title' }] }]),
        },
      }),
    );
    await writeFile(join(chatSessionsFolder, 'unbilled.jsonl'), '{"kind":1,"copilotUsageNanoAiu":');

    const index = new UsageIndex();
    const result = await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.chats[0].title).toBe('Billed title');
    expect(result.diagnostics.normalizedRecords).toBe(2);
    expect(result.diagnostics.skippedMalformedFiles).toBe(0);
  });

  it('removes metadata diagnostics when the last billed record for a chat is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const debugFolder = join(root, 'GitHub.copilot-chat', 'debug-logs', 'billed');
    await mkdir(debugFolder, { recursive: true });
    const usageFile = join(debugFolder, 'main.jsonl');
    await writeFile(usageFile, JSON.stringify(usageRecord('billed', 7)) + '\n');
    await writeFile(
      join(debugFolder, 'title-response.jsonl'),
      JSON.stringify({
        type: 'agent_response',
        ts: Date.parse('2026-05-28T08:00:01.000Z'),
        attrs: {
          response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Billed title' }] }]),
        },
      }),
    );

    const index = new UsageIndex();
    await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    const result = await index.applyChanges({
      pathsToDelete: [usageFile],
      pathsToUpdate: [],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.chats).toEqual([]);
    expect(result.diagnostics.files).toBe(0);
    expect(result.diagnostics.normalizedRecords).toBe(0);
  });

  it('keeps parsed skipped marker files in diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    await writeFile(join(root, 'bad-marker.jsonl'), '{"copilotUsageNanoAiu":');

    const index = new UsageIndex();
    const result = await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.diagnostics.files).toBe(1);
    expect(result.diagnostics.skippedRecords).toBe(1);
  });

  it('does not rescan metadata when existing billed chat receives more usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const debugFolder = join(root, 'GitHub.copilot-chat', 'debug-logs', 'billed');
    await mkdir(debugFolder, { recursive: true });
    const usageFile = join(debugFolder, 'main.jsonl');
    await writeFile(usageFile, JSON.stringify(usageRecord('billed', 7)) + '\n');

    const index = new UsageIndex();
    await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    await writeFile(
      join(debugFolder, 'title-late.jsonl'),
      JSON.stringify({
        type: 'agent_response',
        ts: Date.parse('2026-05-28T08:00:01.000Z'),
        attrs: {
          response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Late title' }] }]),
        },
      }),
    );
    await appendFile(usageFile, JSON.stringify(usageRecord('billed', 5)) + '\n');
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [usageFile],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(12);
    expect(result.summary.chats[0].title).toBe('billed');
  });

  it('uses root recursive watchers instead of nested Copilot folder watchers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    await mkdir(join(root, 'workspace-id', 'GitHub.copilot-chat', 'debug-logs'), { recursive: true });
    await mkdir(join(root, 'workspace-id', 'GitHub.copilot-chat', 'chatSessions'), { recursive: true });

    const index = new UsageIndex();
    await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(index.getWatchFolders().sort()).toEqual(
      [
        root,
      ].sort(),
    );
  });

  it('deduplicates nested watch folders under indexed roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const sessionFolder = join(root, 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, 'main.jsonl'), JSON.stringify(usageRecord('session-1', 1)) + '\n');

    const index = new UsageIndex();
    await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(index.getWatchFolders()).toEqual([root]);
  });

  it('adds only complete appended JSONL lines to the cached records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(filePath, JSON.stringify(usageRecord('first', 1)) + '\n');

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await appendFile(filePath, JSON.stringify(usageRecord('second', 2)));
    let result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });
    expect(result.summary.allTime.tokens).toBe(1);
    expect(result.diagnostics.normalizedRecords).toBe(1);

    await appendFile(filePath, '\n');
    result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(3);
    expect(result.summary.chats.map((chat) => chat.chatId).sort()).toEqual(['first', 'second']);
    expect(result.diagnostics.normalizedRecords).toBe(2);
  });

  it('reuses the summary when an appended JSONL fragment has no complete line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(filePath, JSON.stringify(usageRecord('first', 1)) + '\n');

    const index = new UsageIndex();
    const initial = await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await appendFile(filePath, JSON.stringify(usageRecord('second', 2)));
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result).toBe(initial);
    expect(result.summary.allTime.tokens).toBe(1);
  });

  it('recomputes the summary after a complete appended JSONL line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(filePath, JSON.stringify(usageRecord('first', 1)) + '\n');

    const index = new UsageIndex();
    const initial = await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await appendFile(filePath, JSON.stringify(usageRecord('second', 2)) + '\n');
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result).not.toBe(initial);
    expect(result.summary.allTime.tokens).toBe(3);
  });

  it('reparses a JSONL file when content changes without growing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(filePath, JSON.stringify(usageRecord('first', 1)) + '\n');

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await writeFile(filePath, JSON.stringify(usageRecord('third', 3)) + '\n');
    await utimes(filePath, new Date('2026-05-28T12:00:00.000Z'), new Date('2026-05-28T12:00:01.000Z'));
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(3);
    expect(result.summary.chats.map((chat) => chat.chatId)).toEqual(['third']);
  });

  it.skipIf(process.platform !== 'win32')('does not duplicate cached records when a Windows file event changes drive letter casing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(filePath, JSON.stringify(usageRecord('first', 1)) + '\n');

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    const watcherPath = filePath.charAt(0).toLowerCase() + filePath.slice(1);
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [watcherPath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(1);
    expect(result.diagnostics.files).toBe(1);
    expect(result.diagnostics.normalizedRecords).toBe(1);
  });

  it('falls back to reparsing a JSONL file after truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const filePath = join(root, 'usage.jsonl');
    await writeFile(
      filePath,
      [
        JSON.stringify(usageRecord('first', 1)),
        JSON.stringify(usageRecord('second', 2)),
        '',
      ].join('\n'),
    );

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await truncate(filePath, Buffer.byteLength(JSON.stringify(usageRecord('first', 1)) + '\n'));
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(1);
    expect(result.summary.chats.map((chat) => chat.chatId)).toEqual(['first']);
    expect(result.diagnostics.normalizedRecords).toBe(1);
  });

  it('replaces cached records when a JSON file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const filePath = join(root, 'usage.json');
    await writeFile(filePath, JSON.stringify(usageRecord('first', 1)));

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await writeFile(filePath, JSON.stringify(usageRecord('second', 5)));
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(5);
    expect(result.summary.chats.map((chat) => chat.chatId)).toEqual(['second']);
  });

  it('indexes usage files that already exist inside a newly discovered folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const sessionFolder = join(root, 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    const filePath = join(sessionFolder, 'main.jsonl');
    await mkdir(sessionFolder, { recursive: true });

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await writeFile(filePath, JSON.stringify(usageRecord('new-session', 11)) + '\n');
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [sessionFolder],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(11);
    expect(result.summary.chats.map((chat) => chat.chatId)).toEqual(['new-session']);
    expect(index.getWatchFolders()).toEqual([root]);
  });

  it('indexes files in newly discovered custom data path subfolders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const folder = join(root, 'new-folder');
    const filePath = join(folder, 'usage.jsonl');

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    await mkdir(folder, { recursive: true });
    await writeFile(filePath, JSON.stringify(usageRecord('custom-new', 11)) + '\n');
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [folder],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(11);
    expect(result.summary.chats.map((chat) => chat.chatId)).toEqual(['custom-new']);
  });

  it('removes cached file records when a file or containing folder is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const folder = join(root, 'nested');
    const filePath = join(folder, 'usage.jsonl');
    await mkdir(folder);
    await writeFile(filePath, JSON.stringify(usageRecord('nested', 9)) + '\n', { flag: 'w' });

    const index = new UsageIndex();
    await index.rebuild({ roots: [root], now: new Date('2026-05-28T12:00:00.000Z'), config: configForRoot(root) });

    let result = await index.applyChanges({
      pathsToDelete: [filePath],
      pathsToUpdate: [],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });
    expect(result.summary.allTime.tokens).toBe(0);

    await writeFile(filePath, JSON.stringify(usageRecord('nested', 9)) + '\n', { flag: 'w' });
    await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [filePath],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });
    result = await index.applyChanges({
      pathsToDelete: [folder],
      pathsToUpdate: [],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(0);
    expect(result.diagnostics.files).toBe(0);
  });

  it('ignores known Copilot embedding cache files during incremental updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    const cacheFile = join(root, 'GitHub.copilot-chat', 'settingEmbeddings.json');
    await mkdir(join(root, 'GitHub.copilot-chat'), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ id: 'cache', total_tokens: 99 }));

    const index = new UsageIndex();
    let result = await index.rebuild({
      roots: [root],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(0);

    result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [cacheFile],
      now: new Date('2026-05-28T12:00:00.000Z'),
      config: configForRoot(root),
    });

    expect(result.summary.allTime.tokens).toBe(0);
    expect(result.diagnostics.files).toBe(0);
  });
});

function usageRecord(id: string, tokens: number) {
  return {
    type: 'llm_request',
    sid: id,
    ts: Date.parse('2026-05-28T08:00:00.000Z'),
    attrs: {
      debugName: id,
      model: 'gpt-test',
      inputTokens: tokens,
      outputTokens: 0,
      copilotUsageNanoAiu: tokens * 1_000_000,
    },
  };
}
