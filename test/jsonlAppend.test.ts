import { afterEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({
  /** Appended once, from inside the next `readFile` of this path. */
  pending: undefined as { path: string; content: string } | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readFile: async (path: unknown, ...rest: unknown[]) => {
      if (hook.pending && path === hook.pending.path) {
        const { path: target, content } = hook.pending;
        hook.pending = undefined;
        await actual.appendFile(target, content);
      }

      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UsageIndex } from '../src/core/usageIndex';

const config = { dataPath: '', maxFileSizeMb: 10, maxScanDepth: 6 };
const now = new Date('2026-05-28T12:00:00.000Z');

describe('incremental JSONL reads', () => {
  const roots: string[] = [];

  afterEach(async () => {
    hook.pending = undefined;
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('does not double count rows Copilot appends while the log is being read', async () => {
    const logPath = await createLog(roots);
    await writeFile(logPath, row('2026-05-28T08:00:00.000Z'));

    const index = new UsageIndex();
    // Copilot writes the second row after `stat` and before the read returns,
    // so those bytes are parsed even though they are past the recorded size.
    hook.pending = { path: logPath, content: row('2026-05-28T08:00:01.000Z') };
    const initial = await index.rebuild({ roots: [dirname3(logPath)], now, config });
    expect(initial.summary.allTime.tokens).toBe(200);

    await appendFile(logPath, row('2026-05-28T08:00:02.000Z'));
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [logPath],
      now,
      config,
    });

    expect(result.summary.allTime.tokens).toBe(300);
  });

  it('rereads a log that was rewritten in place and ended up longer', async () => {
    const logPath = await createLog(roots);
    await writeFile(logPath, row('2026-05-28T08:00:00.000Z', 100));

    const index = new UsageIndex();
    const initial = await index.rebuild({ roots: [dirname3(logPath)], now, config });
    expect(initial.summary.allTime.tokens).toBe(100);

    // A rewrite that grows also passes the "file got bigger" check, so the old
    // rows must not survive and the new first row must not be skipped.
    await writeFile(
      logPath,
      [
        row('2026-05-28T09:00:00.000Z', 7),
        row('2026-05-28T09:00:01.000Z', 7),
        row('2026-05-28T09:00:02.000Z', 7),
      ].join(''),
    );
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [logPath],
      now,
      config,
    });

    expect(result.summary.allTime.tokens).toBe(21);
  });

  it('resumes correctly when the first read ended mid-line', async () => {
    const logPath = await createLog(roots);
    const complete = row('2026-05-28T08:00:00.000Z');
    const partial = row('2026-05-28T08:00:01.000Z');
    await writeFile(logPath, complete + partial.slice(0, partial.length - 12));

    const index = new UsageIndex();
    const initial = await index.rebuild({ roots: [dirname3(logPath)], now, config });
    expect(initial.summary.allTime.tokens).toBe(100);

    await writeFile(logPath, complete + partial);
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [logPath],
      now,
      config,
    });

    expect(result.summary.allTime.tokens).toBe(200);
  });

  it('counts appended rows once when earlier rows hold multi-byte text and CRLF endings', async () => {
    const logPath = await createLog(roots);
    await writeFile(logPath, row('2026-05-28T08:00:00.000Z', 100, 'Förklara detta 日本語 🚀', '\r\n'));

    const index = new UsageIndex();
    const initial = await index.rebuild({ roots: [dirname3(logPath)], now, config });
    expect(initial.summary.allTime.tokens).toBe(100);

    await appendFile(logPath, row('2026-05-28T08:00:01.000Z', 100, 'nästa 🚀', '\r\n'));
    const result = await index.applyChanges({
      pathsToDelete: [],
      pathsToUpdate: [logPath],
      now,
      config,
    });

    expect(result.summary.allTime.tokens).toBe(200);
  });
});

async function createLog(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copilot-usage-append-'));
  roots.push(root);
  const folder = join(root, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'session-1');
  await mkdir(folder, { recursive: true });
  return join(folder, 'main.jsonl');
}

/** The scan root is five folders above `main.jsonl`. */
function dirname3(logPath: string): string {
  return join(logPath, '..', '..', '..', '..', '..', '..');
}

function row(at: string, inputTokens = 100, debugName = 'panel/editAgent', terminator = '\n'): string {
  return (
    JSON.stringify({
      type: 'llm_request',
      sid: 'session-1',
      ts: Date.parse(at),
      attrs: {
        model: 'gpt-5.6-luna',
        debugName,
        inputTokens,
        outputTokens: 0,
        copilotUsageNanoAiu: 1_000_000_000,
      },
    }) + terminator
  );
}
