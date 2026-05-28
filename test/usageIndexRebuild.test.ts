import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UsageIndex } from '../src/core/usageIndex';
import type { ExtensionConfig } from '../src/core/types';

describe('UsageIndex rebuild', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('scans, normalizes, and aggregates usage files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    await writeFile(
      join(root, 'usage.json'),
      JSON.stringify(usageRecord('chat', 1000, 500)),
    );

    const result = await rebuildUsage(root, {});

    expect(result.summary.today.tokens).toBe(1500);
    expect(result.summary.chats[0].chatId).toBe('chat');
    expect(result.diagnostics.files).toBe(1);
    expect(result.diagnostics.normalizedRecords).toBe(1);
  });

  it('tracks malformed JSONL lines and skipped records in diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-index-'));
    roots.push(root);
    await writeFile(
      join(root, 'usage.jsonl'),
      [
        JSON.stringify(usageRecord('usage', 100, 50)),
        'not-json',
        JSON.stringify({
          id: 'no-tokens',
          title: 'No Tokens',
          createdAt: '2026-05-28T09:00:00.000Z',
          model: 'gpt-test',
        }),
      ].join('\n'),
    );

    const result = await rebuildUsage(root, {});

    expect(result.summary.today).toEqual(createTotal(150));
    expect(result.summary.chats[0]).toMatchObject({
      chatId: 'usage',
    });
    expect(result.diagnostics.parsedRecords).toBe(2);
    expect(result.diagnostics.normalizedRecords).toBe(1);
    expect(result.diagnostics.skippedRecords).toBe(2);
    expect(result.diagnostics.skippedMalformedFiles).toBe(0);
  });

});

function createTotal(tokens: number) {
  return {
    tokens,
    githubCopilot: createCost(tokens),
  };
}

function createCost(_tokensWithoutCost: number) {
  const aiCredits = _tokensWithoutCost / 1000;
  return {
    available: true,
    usd: aiCredits * 0.01,
    aiCredits,
  };
}

function usageRecord(id: string, inputTokens: number, outputTokens: number) {
  return {
    type: 'llm_request',
    sid: id,
    ts: Date.parse('2026-05-28T08:00:00.000Z'),
    attrs: {
      debugName: id,
      model: 'gpt-test',
      inputTokens,
      outputTokens,
      copilotUsageNanoAiu: (inputTokens + outputTokens) * 1_000_000,
    },
  };
}

async function rebuildUsage(root: string, configPatch: Partial<ExtensionConfig>) {
  const index = new UsageIndex();
  return index.rebuild({
    roots: [root],
    now: new Date('2026-05-28T12:00:00.000Z'),
    config: {
      dataPath: root,
      maxFileSizeMb: 10,
      maxScanDepth: 6,
      ...configPatch,
    },
  });
}
