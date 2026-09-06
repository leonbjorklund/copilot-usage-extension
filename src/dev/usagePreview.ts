import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCopilotQuota } from '../core/quota';
import type { QuotaState } from '../core/quotaService';

// Oldest to newest across the rolling 30-day window.
export const PREVIEW_DAILY_CREDITS = [
  0, 0, 12, 34, 28, 0, 0, 41, 55, 47, 33, 0, 0, 61, 52,
  18, 0, 0, 44, 39, 58, 22, 0, 0, 48, 31, 26, 64, 29, 87,
];

const MODELS = ['gpt-5.6-luna', 'claude-sonnet-4.6', 'gemini-3.5-flash'];
const PREVIEW_QUOTA = 1_500;

export interface UsagePreview {
  root: string;
  now: Date;
  quotaState: QuotaState;
  dispose(): void;
}

/** Substitute raw inputs only; the normal index calculates every displayed total. */
export function createUsagePreview(now = new Date(2026, 9, 1, 12)): UsagePreview {
  const root = mkdtempSync(join(tmpdir(), 'copilot-usage-preview-'));
  let periodCredits = 0;

  function writeSession(day: Date, id: string, title: string, model: string, credits: number, tokens: number): void {
    const folder = join(root, 'debug-logs', id);
    mkdirSync(folder, { recursive: true });
    // Multiple real-shaped requests exercise session grouping and cached-input subtraction.
    const requests = [0, 1].map((request) => {
      const effectiveTokens = request === 0 ? Math.floor(tokens / 2) : Math.ceil(tokens / 2);
      const outputTokens = Math.floor(effectiveTokens / 10);
      const cachedTokens = Math.floor(effectiveTokens / 3);
      return {
        type: 'llm_request',
        sid: id,
        ts: day.getTime() + request * 1_000,
        attrs: {
          debugName: title,
          model,
          inputTokens: effectiveTokens - outputTokens + cachedTokens,
          cachedTokens,
          outputTokens,
          copilotUsageNanoAiu: Math.round(credits * 1_000_000_000 / 2),
        },
      };
    });
    writeFileSync(join(folder, 'main.jsonl'), requests.map((row) => JSON.stringify(row)).join('\n') + '\n');
    if (day.getFullYear() === now.getFullYear() && day.getMonth() === now.getMonth()) {
      periodCredits += credits;
    }
  }

  try {
    PREVIEW_DAILY_CREDITS.forEach((credits, i) => {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29 + i, 9);
      if (i === 29) {
        writeSession(day, 'today-tokens', 'Refactor the usage scanner', MODELS[0], 18, 1_700_000);
        writeSession(day, 'today-cost', 'Investigate quota refresh behavior', MODELS[1], 60, 300_000);
        writeSession(day, 'today-small', 'Polish session labels', MODELS[2], 9, 100_000);
      } else {
        writeSession(day, `day-${i}`, `Preview session ${i + 1}`, MODELS[i % MODELS.length], credits, credits * 10_000);
      }
    });
    // An older session keeps all-time different from both month and the graph window.
    writeSession(new Date(now.getFullYear(), now.getMonth() - 2, 15, 9), 'older', 'Earlier project work', MODELS[0], 250, 4_000_000);
    const quota = parseCopilotQuota({
      quota_snapshots: {
        premium_models: {
          entitlement: PREVIEW_QUOTA,
          percent_remaining: 100 * (1 - periodCredits / PREVIEW_QUOTA),
          overage_count: 0,
          reset_date: new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1)).toISOString(),
        },
      },
    });
    if (!quota) {
      throw new Error('Invalid preview quota fixture.');
    }
    return {
      root,
      now: new Date(now),
      quotaState: { kind: 'quota', quota, account: 'mock-preview' },
      // root is exclusively the fresh directory returned by mkdtempSync above.
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
