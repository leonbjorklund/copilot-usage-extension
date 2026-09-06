import { appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UsageIndex } from '../src/core/usageIndex';
import { createUsagePreview, type UsagePreview } from '../src/dev/usagePreview';

describe('mock usage through the real pipeline', () => {
  let preview: UsagePreview | undefined;
  const config = { dataPath: '', maxFileSizeMb: 200, maxScanDepth: 12 };
  afterEach(() => preview?.dispose());

  it('derives daily tokens, credits, USD, model rows and quota from raw fixtures', async () => {
    preview = createUsagePreview();
    const { summary, diagnostics } = await new UsageIndex().rebuild({
      roots: [preview.root], config, now: preview.now,
    });

    expect(summary.today.tokens).toBe(2_100_000);
    expect(summary.today.githubCopilot.aiCredits).toBe(87);
    expect(summary.today.githubCopilot.usd).toBeCloseTo(0.87);
    expect(summary.month.tokens).toBe(7_820_000);
    expect(summary.month.githubCopilot.aiCredits).toBe(659);
    expect(summary.allTime.tokens).toBe(13_520_000);
    expect(summary.allTime.githubCopilot.aiCredits).toBe(1_079);
    expect(summary.allTime.githubCopilot.usd).toBeCloseTo(10.79);
    expect(summary.topModels).toHaveLength(3);
    expect(summary.highestSessionToday?.title).toBe('Refactor the usage scanner');
    expect(summary.mostExpensiveSessionToday?.title).toBe('Investigate quota refresh behavior');
    expect(summary.chats).toHaveLength(23);
    expect(diagnostics.skippedMalformedFiles).toBe(0);
    expect(diagnostics.skippedRecords).toBeGreaterThan(0); // Zero-credit rows use the real gate.

    const records = summary.chats.flatMap((chat) => chat.records);
    expect(records.every((record) => record.filePath.startsWith(preview!.root))).toBe(true);
    expect(records.some((record) => record.timestamp.getMonth() === 7)).toBe(true);
    expect(records.some((record) => record.timestamp.getMonth() === 6)).toBe(true);
    expect(preview.quotaState.kind).toBe('quota');
    if (preview.quotaState.kind === 'quota') {
      expect(preview.quotaState.quota.entitlement).toBe(1_500);
      expect(preview.quotaState.quota.remaining).toBeCloseTo(841);
      expect(preview.quotaState.quota.resetDate).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    }
  });

  it('counts appended mock requests once through the normal incremental index', async () => {
    preview = createUsagePreview();
    const index = new UsageIndex();
    await index.rebuild({ roots: [preview.root], config, now: preview.now });
    const filePath = join(preview.root, 'debug-logs', 'today-tokens', 'main.jsonl');
    await appendFile(filePath, JSON.stringify({
      type: 'llm_request', sid: 'today-tokens', ts: preview.now.getTime(),
      attrs: { model: 'gpt-5.6-luna', inputTokens: 100, outputTokens: 20, copilotUsageNanoAiu: 1_000_000_000 },
    }) + '\n');

    for (let refresh = 0; refresh < 2; refresh++) {
      const { summary } = await index.applyChanges({ pathsToUpdate: [filePath], pathsToDelete: [], config, now: preview.now });
      expect(summary.today.tokens).toBe(2_100_120);
      expect(summary.today.githubCopilot.aiCredits).toBe(88);
      expect(summary.today.githubCopilot.usd).toBeCloseTo(0.88);
    }
    const root = preview.root;
    preview.dispose();
    await expect(access(root)).rejects.toThrow();
  });
});
