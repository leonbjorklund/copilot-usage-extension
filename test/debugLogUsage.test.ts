import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UNTITLED_CHAT_TITLE } from '../src/core/aggregator';
import {
  debugSessionIdFromFilePath,
  isChildDebugLogFile,
  normalizeRawUsage,
} from '../src/core/normalizer';
import { parseUsageFile } from '../src/core/parser';
import { UsageIndex } from '../src/core/usageIndex';

describe('Copilot debug log usage', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('normalizes llm_request records from Copilot debug main logs', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'main.jsonl',
        value: {
          type: 'llm_request',
          sid: 'session-1',
          ts: 1779978683085,
          attrs: {
            model: 'claude-sonnet-4.6',
            inputTokens: 123110,
            outputTokens: 943,
            cachedTokens: 102858,
            copilotUsageNanoAiu: 2119500000,
          },
        },
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      chatId: 'session-1',
      title: 'Copilot debug request',
      model: 'claude-sonnet-4.6',
      timestamp: new Date(1779978683085),
      tokens: {
        input: 20252,
        cachedInput: 102858,
        output: 943,
        cacheWriteInput: 0,
        total: 21195,
        source: 'recorded',
      },
    });
  });

  it('normalizes llm_request cache write token counts when present', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'main.jsonl',
        value: {
          type: 'llm_request',
          sid: 'session-1',
          ts: 1779978683085,
          attrs: {
            model: 'claude-sonnet-4.6',
            inputTokens: 5000,
            outputTokens: 1000,
            cacheWriteInputTokens: 2000,
            copilotUsageNanoAiu: 600000000,
          },
        },
      },
    );

    expect(records[0].tokens).toMatchObject({
      input: 5000,
      cachedInput: 0,
      output: 1000,
      cacheWriteInput: 2000,
      total: 6000,
    });
  });

  it('normalizes billed AI Credits from Copilot debug logs', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'main.jsonl',
        value: {
          type: 'llm_request',
          sid: 'session-1',
          ts: 1779978683085,
          attrs: {
            model: 'gemini-3.5-flash',
            inputTokens: 19154,
            outputTokens: 102,
            cachedTokens: 5633,
            copilotUsageNanoAiu: 2204445000,
          },
        },
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0].billing).toEqual({
      aiCredits: 2.204445,
      source: 'copilot-debug-log',
    });
  });

  it('skips token-only Copilot debug records when AI Credits are absent', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'main.jsonl',
        value: {
          type: 'llm_request',
          sid: 'session-1',
          ts: 1779978683085,
          attrs: {
            model: 'gemini-3.5-flash',
            inputTokens: 100,
            outputTokens: 25,
          },
        },
      },
    );

    expect(records).toEqual([]);
  });

  it('skips Copilot debug records with zero AI Credits', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'main.jsonl',
        value: {
          type: 'llm_request',
          sid: 'old-session',
          ts: 1779978683085,
          attrs: {
            model: 'gpt-old',
            inputTokens: 100,
            outputTokens: 25,
            copilotUsageNanoAiu: 0,
          },
        },
      },
    );

    expect(records).toEqual([]);
  });

  it('marks title generation debug records hidden from explorer', () => {
    const records = normalizeRawUsage(
      {
        filePath: 'main.jsonl',
        value: {
          type: 'llm_request',
          sid: 'session-title',
          ts: 1779978683085,
          attrs: {
            debugName: 'title',
            model: 'gpt-test',
            inputTokens: 100,
            outputTokens: 20,
            copilotUsageNanoAiu: 120000000,
          },
        },
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      chatId: 'session-title',
      title: 'title',
      hiddenFromExplorer: true,
    });
  });

  it('normalizes generated title responses as metadata for the parent session', () => {
    const records = normalizeRawUsage(
      {
        filePath: join(
          'workspaceStorage',
          'abc',
          'GitHub.copilot-chat',
          'debug-logs',
          'session-1',
          'title-response.jsonl',
        ),
        value: {
          type: 'agent_response',
          ts: 1779978684169,
          attrs: {
            response: JSON.stringify([
              {
                role: 'assistant',
                parts: [{ type: 'text', content: 'Test VS Code extension installation' }],
              },
            ]),
          },
        },
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      chatId: 'session-1',
      title: 'Test VS Code extension installation',
      metadataOnly: true,
      titlePriority: 4,
      tokens: {
        total: 0,
        source: 'missing',
      },
    });
  });

  it('normalizes chat session custom titles as metadata', () => {
    const records = normalizeRawUsage(
      {
        filePath: join('workspaceStorage', 'abc', 'chatSessions', 'session-1.jsonl'),
        value: {
          kind: 1,
          k: ['customTitle'],
          v: 'Fix missing license file',
        },
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      chatId: 'session-1',
      title: 'Fix missing license file',
      metadataOnly: true,
      titlePriority: 5,
    });
  });

  it('normalizes transcript user messages as prompt title fallback metadata', () => {
    const records = normalizeRawUsage(
      {
        filePath: join('workspaceStorage', 'abc', 'GitHub.copilot-chat', 'transcripts', 'session-1.jsonl'),
        value: {
          type: 'user.message',
          timestamp: '2026-05-28T10:41:39.783Z',
          data: {
            content:
              'PS C:\\Users\\Leon\\Desktop\\Repos\\copilot-usage-extension> npm run package\r\n\r\nHow can I fix this',
          },
        },
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      chatId: 'session-1',
      title: 'PS C:\\Users\\Leon\\Desktop\\Repos\\copilot-usage-extension> npm r...',
      metadataOnly: true,
      titlePriority: 2,
    });
  });

  it('scans workspace debug logs and aggregates recorded tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-workspace-'));
    roots.push(root);
    const debugFolder = join(root, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    await mkdir(debugFolder, { recursive: true });
    await writeFile(
      join(debugFolder, 'main.jsonl'),
      [
        JSON.stringify({
          type: 'llm_request',
          sid: 'session-1',
          ts: Date.parse('2026-05-28T08:00:00.000Z'),
          attrs: {
            model: 'gpt-test',
            inputTokens: 1000,
            outputTokens: 250,
            cachedTokens: 200,
            copilotUsageNanoAiu: 1050000000,
          },
        }),
        JSON.stringify({
          type: 'tool_call',
          ts: Date.parse('2026-05-28T08:00:01.000Z'),
          attrs: { toolName: 'read_file' },
        }),
      ].join('\n'),
    );

    const result = await rebuildUsage(root);

    expect(result.summary.today.tokens).toBe(1050);
    expect(result.summary.chats[0]).toMatchObject({
      chatId: 'session-1',
      model: 'gpt-test',
      tokens: 1050,
    });
    expect(result.diagnostics.normalizedRecords).toBe(1);

    const parsed = await parseUsageFile(join(debugFolder, 'main.jsonl'), { mode: 'billed-usage' });
    expect(parsed.items).toHaveLength(2);
  });

  it('scans workspace debug logs and ignores zero-credit rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-workspace-'));
    roots.push(root);
    const debugFolder = join(root, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    await mkdir(debugFolder, { recursive: true });
    await writeFile(
      join(debugFolder, 'main.jsonl'),
      [
        JSON.stringify({
          type: 'llm_request',
          sid: 'old-session',
          ts: Date.parse('2026-05-27T08:00:00.000Z'),
          attrs: {
            model: 'gpt-old',
            inputTokens: 1000,
            outputTokens: 250,
            copilotUsageNanoAiu: 0,
          },
        }),
        JSON.stringify({
          type: 'llm_request',
          sid: 'billed-session',
          ts: Date.parse('2026-05-28T08:00:00.000Z'),
          attrs: {
            model: 'gpt-test',
            inputTokens: 1000,
            outputTokens: 250,
            copilotUsageNanoAiu: 1250000000,
          },
        }),
      ].join('\n'),
    );

    const result = await rebuildUsage(root);

    expect(result.summary.today.tokens).toBe(1250);
    expect(result.summary.allTime.tokens).toBe(1250);
    expect(result.summary.chats.map((chat) => chat.chatId)).toEqual(['session-1']);
    expect(result.summary.topModels.map((model) => model.model)).toEqual(['gpt-test']);
  });

  it('uses generated title metadata for scanned debug log sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-workspace-'));
    roots.push(root);
    const debugFolder = join(root, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    await mkdir(debugFolder, { recursive: true });
    await writeFile(
      join(debugFolder, 'main.jsonl'),
      JSON.stringify({
        type: 'llm_request',
        sid: 'session-1',
        ts: Date.parse('2026-05-28T08:00:00.000Z'),
        attrs: {
          debugName: 'panel/editAgent',
          model: 'gpt-test',
          inputTokens: 1000,
          outputTokens: 250,
          copilotUsageNanoAiu: 1250000000,
        },
      }),
    );
    await writeFile(
      join(debugFolder, 'title-response.jsonl'),
      JSON.stringify({
        type: 'agent_response',
        ts: Date.parse('2026-05-28T08:00:01.000Z'),
        attrs: {
          response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Fix explorer titles' }] }]),
        },
      }),
    );

    const result = await rebuildUsage(root);

    expect(result.summary.chats[0].title).toBe('Fix explorer titles');
    expect(result.summary.chats[0].records[0].title).toBe('panel/editAgent');
  });
  it('folds subagent child logs into their parent chat session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-subagent-'));
    roots.push(root);
    const debugFolder = join(root, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    await mkdir(debugFolder, { recursive: true });

    await writeFile(
      join(debugFolder, 'main.jsonl'),
      [
        JSON.stringify({
          type: 'user_message',
          sid: 'session-1',
          ts: Date.parse('2026-05-28T08:00:00.000Z'),
          attrs: { content: 'Refactor the scanner' },
        }),
        JSON.stringify({
          type: 'child_session_ref',
          sid: 'session-1',
          ts: Date.parse('2026-05-28T08:00:01.000Z'),
          attrs: {
            childSessionId: 'call_abc',
            childLogFile: 'runSubagent-Explore-call_abc.jsonl',
            label: 'runSubagent-Explore',
          },
        }),
        JSON.stringify({
          type: 'llm_request',
          sid: 'session-1',
          ts: Date.parse('2026-05-28T08:00:02.000Z'),
          attrs: {
            model: 'gpt-5.6-luna',
            debugName: 'panel/editAgent',
            inputTokens: 1000,
            outputTokens: 200,
            copilotUsageNanoAiu: 1_000_000_000,
          },
        }),
      ].join('\n') + '\n',
    );

    // The subagent log carries its own `sid`, which must not create a session.
    await writeFile(
      join(debugFolder, 'runSubagent-Explore-call_abc.jsonl'),
      JSON.stringify({
        type: 'llm_request',
        sid: 'call_abc',
        ts: Date.parse('2026-05-28T08:00:03.000Z'),
        attrs: {
          model: 'gpt-5.6-luna',
          debugName: 'tool/runSubagent-Explore',
          inputTokens: 500,
          outputTokens: 100,
          copilotUsageNanoAiu: 500_000_000,
        },
      }) + '\n',
    );

    const result = await rebuildUsage(root);

    expect(result.summary.chats).toHaveLength(1);
    expect(result.summary.chats[0]).toMatchObject({
      chatId: 'session-1',
      title: 'Refactor the scanner',
      tokens: 1800,
    });
    expect(result.summary.chats[0].githubCopilot.aiCredits).toBeCloseTo(1.5, 10);
  });

  it('titles a chat from its first prompt when no generated title exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-prompt-title-'));
    roots.push(root);
    const debugFolder = join(root, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    await mkdir(debugFolder, { recursive: true });
    await writeFile(
      join(debugFolder, 'main.jsonl'),
      [
        JSON.stringify({
          type: 'user_message',
          sid: 'session-1',
          ts: Date.parse('2026-05-28T08:00:00.000Z'),
          attrs: { content: 'Why is the status bar blank?' },
        }),
        JSON.stringify({
          type: 'llm_request',
          sid: 'session-1',
          ts: Date.parse('2026-05-28T08:00:01.000Z'),
          attrs: {
            model: 'gpt-5.6-luna',
            debugName: 'panel/editAgent',
            inputTokens: 10,
            outputTokens: 5,
            copilotUsageNanoAiu: 1_000_000_000,
          },
        }),
      ].join('\n') + '\n',
    );

    const result = await rebuildUsage(root);

    expect(result.summary.chats[0].title).toBe('Why is the status bar blank?');
  });

  it('never lets a subagent log name the chat it belongs to', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-subagent-title-'));
    roots.push(root);
    const folder = join(root, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'session-1');
    await mkdir(folder, { recursive: true });

    const request = (at: string, debugName: string) =>
      JSON.stringify({
        type: 'llm_request',
        sid: 'session-1',
        ts: Date.parse(at),
        attrs: {
          model: 'gpt-5.6-luna',
          debugName,
          inputTokens: 10,
          outputTokens: 0,
          copilotUsageNanoAiu: 1_000_000_000,
        },
      }) + '\n';

    await writeFile(join(folder, 'main.jsonl'), request('2026-05-28T08:00:00.000Z', 'panel/editAgent'));
    // A subagent names itself after its own task, and its log is written after
    // the parent turn, so a plain recency tie-break would hand it the label.
    await writeFile(
      join(folder, 'runSubagent-Explore-call_abc.jsonl'),
      request('2026-05-28T08:00:05.000Z', 'Explore repo layout'),
    );

    const result = await rebuildUsage(root);

    expect(result.summary.chats).toHaveLength(1);
    expect(result.summary.chats[0].title).toBe(UNTITLED_CHAT_TITLE);
    expect(result.summary.chats[0].tokens).toBe(20);
  });

  it('reads the chat id from the debug-logs folder and marks child runs', () => {
    const posix = 'C:/Users/x/GitHub.copilot-chat/debug-logs/session-1/main.jsonl';
    const child = 'C:/Users/x/GitHub.copilot-chat/debug-logs/session-1/title-abc.jsonl';

    expect(debugSessionIdFromFilePath(posix)).toBe('session-1');
    expect(debugSessionIdFromFilePath(child)).toBe('session-1');
    expect(debugSessionIdFromFilePath(join('C:', 'x', 'DEBUG-LOGS', 'session-2', 'MAIN.JSONL'))).toBe(
      'session-2',
    );
    expect(debugSessionIdFromFilePath('C:/Users/x/transcripts/session-1/main.jsonl')).toBeUndefined();
    expect(debugSessionIdFromFilePath('C:/x/debug-logs/session-1/nested/main.jsonl')).toBeUndefined();

    expect(isChildDebugLogFile(posix)).toBe(false);
    expect(isChildDebugLogFile(join('C:', 'x', 'debug-logs', 'session-2', 'MAIN.JSONL'))).toBe(false);
    expect(isChildDebugLogFile(child)).toBe(true);
    expect(isChildDebugLogFile('C:/Users/x/transcripts/session-1/other.jsonl')).toBe(false);
  });
});

async function rebuildUsage(root: string) {
  const index = new UsageIndex();
  return index.rebuild({
    roots: [root],
    now: new Date('2026-05-28T12:00:00.000Z'),
    config: {
      dataPath: '',
      maxFileSizeMb: 10,
      maxScanDepth: 6,
    },
  });
}
