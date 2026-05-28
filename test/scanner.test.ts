import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanUsageFiles } from '../src/core/scanner';

describe('scanUsageFiles', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('returns supported usage files and counts unsupported files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
    roots.push(root);

    await writeFile(join(root, 'usage.json'), '{}');
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'usage.jsonl'), '{}\n');
    await writeFile(join(root, 'a', 'b', 'skip.txt'), '');

    const result = await scanUsageFiles([root], { maxFileSizeBytes: 1024, maxDepth: 6 });

    expect(result.files.sort()).toEqual([join(root, 'a', 'usage.jsonl'), join(root, 'usage.json')].sort());
    expect(result.diagnostics).toMatchObject({
      scannedFiles: 2,
      unsupportedFiles: 1,
    });
  });

  it('skips oversized files and folders beyond max depth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
    roots.push(root);

    await writeFile(join(root, 'too-big.json'), '123456789');
    await mkdir(join(root, 'deep', 'child'), { recursive: true });
    await writeFile(join(root, 'deep', 'child', 'too-deep.json'), '{}');

    const result = await scanUsageFiles([root], { maxFileSizeBytes: 4, maxDepth: 1 });

    expect(result.files).toEqual([]);
    expect(result.diagnostics.oversizedFiles).toBe(1);
  });

  it('does not scan duplicate roots twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
    roots.push(root);
    const usageFile = join(root, 'usage.json');
    await writeFile(usageFile, '{}');

    const result = await scanUsageFiles([root, root], { maxFileSizeBytes: 1024, maxDepth: 6 });

    expect(result.files).toEqual([usageFile]);
    expect(result.diagnostics.scannedFiles).toBe(1);
  });

  it('tracks empty-window chat session folders for live updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
    roots.push(root);
    const sessionsFolder = join(root, 'emptyWindowChatSessions');
    await mkdir(sessionsFolder);

    const result = await scanUsageFiles([root], { maxFileSizeBytes: 1024, maxDepth: 6 });

    expect(result.watchFolders).toContain(sessionsFolder);
  });

  it('can prune unrelated JSON outside known Copilot usage folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
    roots.push(root);
    const unrelatedFile = join(root, 'other-extension', 'state.json');
    const usageFile = join(root, 'workspace', 'GitHub.copilot-chat', 'debug-logs', 'session', 'main.jsonl');
    await mkdir(join(root, 'other-extension'), { recursive: true });
    await mkdir(join(root, 'workspace', 'GitHub.copilot-chat', 'debug-logs', 'session'), { recursive: true });
    await writeFile(unrelatedFile, '{}');
    await writeFile(join(root, 'other-extension', 'notes.txt'), '');
    await writeFile(usageFile, '{}\n');

    const result = await scanUsageFiles([root], {
      maxFileSizeBytes: 1024,
      maxDepth: 6,
      includeFilesOutsideUsageFolders: false,
    });

    expect(result.files).toEqual([usageFile]);
    expect(result.diagnostics.unsupportedFiles).toBe(0);
  });

  it('keeps broad scanning for subfolders inside configured broad roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
    roots.push(root);
    const folder = join(root, 'new-folder');
    const usageFile = join(folder, 'usage.jsonl');
    await mkdir(folder, { recursive: true });
    await writeFile(usageFile, '{}\n');

    const result = await scanUsageFiles([folder], {
      maxFileSizeBytes: 1024,
      maxDepth: 6,
      broadRootPaths: [root],
      includeFilesOutsideUsageFolders: false,
    });

    expect(result.files).toEqual([usageFile]);
  });

  it('ignores known Copilot embedding cache files inside usage folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
    roots.push(root);
    const copilotFolder = join(root, 'workspace', 'github.copilot-chat');
    const debugFolder = join(copilotFolder, 'debug-logs', 'session-1');
    const usageFile = join(debugFolder, 'main.jsonl');
    await mkdir(debugFolder, { recursive: true });
    await writeFile(join(copilotFolder, 'settingEmbeddings.json'), '{}');
    await writeFile(join(copilotFolder, 'commandEmbeddings.json'), '{}');
    await writeFile(usageFile, '{}\n');

    const result = await scanUsageFiles([root], {
      maxFileSizeBytes: 1024,
      maxDepth: 6,
      includeFilesOutsideUsageFolders: false,
    });

    expect(result.files).toEqual([usageFile]);
    expect(result.diagnostics.scannedFiles).toBe(1);
  });
});
