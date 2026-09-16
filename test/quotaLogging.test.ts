import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  authentication: {
    getSession: vi.fn(),
    getAccounts: vi.fn(),
    onDidChangeSessions: vi.fn(),
  },
}));

import { enableQuotaLogging } from '../src/core/quotaLogging';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  try {
    for (const api of Object.values(vscode.authentication)) expect(api).not.toHaveBeenCalled();
  } finally {
    vi.resetAllMocks();
  }
});

async function fixture(original: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'quota-logging-'));
  directories.push(directory);
  vi.stubEnv('VSCODE_PORTABLE', directory);
  const path = join(directory, 'argv.json');
  await writeFile(path, JSON.stringify(original));
  const data = async () => JSON.parse(await readFile(path, 'utf8'));
  vi.mocked(vscode.commands.executeCommand).mockImplementation(async () => {
    const current = await data().catch(() => ({}));
    const entries = typeof current['log-level'] === 'string' ? [current['log-level']] : current['log-level'] ?? [];
    current['log-level'] = [...entries.filter((entry: string) => !entry.startsWith('github.copilot-chat=')), 'github.copilot-chat=trace'];
    await writeFile(path, JSON.stringify(current));
  });
  return { path, data };
}

describe('persistent quota logging', () => {
  it('saves only the Copilot default and retains it for later activations', async () => {
    const f = await fixture({ 'log-level': ['warn', 'other.extension=debug'], setting: 'keep' });
    expect((await enableQuotaLogging()).requested).toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
      'workbench.action.setDefaultLogLevel', 1, 'github.copilot-chat');
    const saved = { 'log-level': ['warn', 'other.extension=debug', 'github.copilot-chat=trace'], setting: 'keep' };
    expect(await f.data()).toEqual(saved);
    expect((await enableQuotaLogging()).requested).toBe(true);
    expect(await f.data()).toEqual(saved);
  });

  it.each([3, 2])('does not mistake a saved default for runtime capture at level %s', async (runtime) => {
    const f = await fixture({ 'log-level': ['github.copilot-chat=trace'] });
    const channel = { level: runtime };
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (_command, level) => {
      // VS Code preserves a channel whose runtime differs from the previous saved default.
      const previous = (await f.data())['log-level'].includes('github.copilot-chat=trace') ? 1 : 3;
      if (channel.level === previous) channel.level = level;
    });
    const result = await enableQuotaLogging();
    expect(result.requested).toBe(true);
    expect(result.reason).toContain('Fully quit and reopen VS Code');
    expect(channel.level).toBe(runtime);
  });

  it('preserves unrelated edits made while VS Code saves the setting', async () => {
    const f = await fixture({ setting: 'before' });
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async () => {
      await writeFile(f.path, JSON.stringify({ setting: 'after', 'log-level': ['warn', 'other.extension=debug', 'github.copilot-chat=trace'] }));
    });
    expect((await enableQuotaLogging()).requested).toBe(true);
    expect(await f.data()).toEqual({ setting: 'after', 'log-level': ['warn', 'other.extension=debug', 'github.copilot-chat=trace'] });
  });

  it('handles a first launch without argv.json', async () => {
    const f = await fixture();
    await rm(f.path);
    expect((await enableQuotaLogging()).requested).toBe(true);
    expect((await f.data())['log-level']).toEqual(['github.copilot-chat=trace']);
  });

  it.each(['future-log-syntax', 'warning', 'INFO', 'other.extension=DEBUG'])(
    'refuses %s before VS Code could discard it', async (entry) => {
      const original = { 'log-level': [entry] };
      const f = await fixture(original);
      const result = await enableQuotaLogging();
      expect(result.requested).toBe(false);
      expect(result.reason).toContain('unsupported entries');
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
      expect(await f.data()).toEqual(original);
    });

  it.each(['{"log-level":"info","log-level":"error"}', '{"log-level":42}', '{"log-level":["info",false]}'])(
    'rejects ambiguous or unsupported configuration %s without changing it', async (text) => {
      const f = await fixture();
      await writeFile(f.path, text);
      expect((await enableQuotaLogging()).requested).toBe(false);
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
      expect(await readFile(f.path, 'utf8')).toBe(text);
    });

  it('reads JSONC comments, escaped keys and trailing commas without rewriting them', async () => {
    const f = await fixture();
    const text = '{ /* retain */ "nested":{"log-level":false}, "log-\\u006cevel":["github.copilot-chat=trace",], }';
    await writeFile(f.path, text);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    expect((await enableQuotaLogging()).requested).toBe(true);
    expect(await readFile(f.path, 'utf8')).toBe(text);
  });

  it('reports command failure while keeping a successfully written persistent default', async () => {
    const f = await fixture();
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async () => {
      await writeFile(f.path, JSON.stringify({ 'log-level': ['github.copilot-chat=trace'] }));
      throw new Error('renderer disconnected');
    });
    const result = await enableQuotaLogging();
    expect(result.requested).toBe(false);
    expect(result.reason).toContain('renderer disconnected');
    expect((await f.data())['log-level']).toEqual(['github.copilot-chat=trace']);
  });

  it('reports when the scoped command does not save Trace', async () => {
    const f = await fixture({ 'log-level': ['info'] });
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const result = await enableQuotaLogging();
    expect(result.requested).toBe(false);
    expect(result.reason).toContain('did not save');
    expect((await f.data())['log-level']).toEqual(['info']);
  });

  it('bounds configuration reads before invoking the command', async () => {
    const f = await fixture();
    await writeFile(f.path, ' '.repeat(128 * 1024 + 1));
    const result = await enableQuotaLogging();
    expect(result.requested).toBe(false);
    expect(result.reason).toContain('read limit');
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
