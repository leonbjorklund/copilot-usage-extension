import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class TreeItem {
    label: string;
    collapsibleState: number;
    description?: string;
    iconPath?: unknown;
    command?: unknown;
    tooltip?: string;

    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  return {
    EventEmitter: class {
      event = vi.fn();
      fire = vi.fn();
    },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
  };
});

import * as vscode from 'vscode';

import { differenceInLocalCalendarDays, UsageTreeProvider } from '../src/ui/usageTreeProvider';
import type { ChatUsageSummary, CopilotCostEstimate, UsageRecord, UsageSummary, UsageTotal } from '../src/core/types';

describe('UsageTreeProvider', () => {
  it('returns no tree rows when Copilot file logging is disabled so the welcome view renders', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSetupNeeded();

    const rootChildren = (await provider.getChildren()) ?? [];

    expect(rootChildren).toEqual([]);
  });

  it('renders date buckets at the root and skips summary row', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(createSummary());

    const rootChildren = (await provider.getChildren()) ?? [];

    expect(rootChildren).toHaveLength(2);
    expect(provider.getTreeItem(rootChildren[0]).label).toBe('Today');
    expect(provider.getTreeItem(rootChildren[0]).description).toBe('1 session | 150 (1.2$)');
    expect(provider.getTreeItem(rootChildren[0]).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    expect(provider.getTreeItem(rootChildren[1]).label).toBe('Older');
    expect(provider.getTreeItem(rootChildren[1]).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('renders a no-usage row without tooltip when no usage exists', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(createSummary([]));

    const rootChildren = (await provider.getChildren()) ?? [];

    expect(rootChildren).toHaveLength(1);
    const item = provider.getTreeItem(rootChildren[0]);
    expect(item.label).toBe('No Copilot usage found');
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect(item.tooltip).toBeUndefined();
  });

  it('omits trailing zero decimals in bucket token descriptions', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(
      createSummary([
        createChat('chat-1', 'Feature work', new Date(2026, 4, 28, 9, 30), 57_000),
        createChat('chat-2', 'Review work', new Date(2026, 4, 28, 10, 30), 57_000),
      ]),
    );

    const rootChildren = (await provider.getChildren()) ?? [];

    expect(provider.getTreeItem(rootChildren[0]).description).toBe('2 sessions | 114k (2.4$)');
  });

  it('renders bucket children as chat leaf rows without record children', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(createSummary());
    const rootChildren = (await provider.getChildren()) ?? [];

    const chatChildren = (await provider.getChildren(rootChildren[0])) ?? [];

    expect(chatChildren).toHaveLength(1);
    const chatItem = provider.getTreeItem(chatChildren[0]);
    expect(chatItem.label).toBe('Feature work');
    expect(chatItem.description).toBe('09:30 | gpt-4.1 | 150 (1.2$)');
    expect(chatItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect(await provider.getChildren(chatChildren[0])).toEqual([]);
  });

  it('renders older bucket children with date and time', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(createSummary([createChat('chat-2', 'Bug fix', new Date(2026, 4, 26, 16, 18), 23_300)]));
    const rootChildren = (await provider.getChildren()) ?? [];

    const chatChildren = (await provider.getChildren(rootChildren[0])) ?? [];

    expect(provider.getTreeItem(chatChildren[0]).description).toBe('2026-05-26 16:18 | gpt-4.1 | 23k (1.2$)');
  });

  it('uses the current clock value when building root buckets', async () => {
    let currentDate = new Date(2026, 4, 28, 12, 0);
    const provider = new UsageTreeProvider(() => currentDate);
    provider.setSummary(createSummary([createChat('chat-3', 'New day work', new Date(2026, 4, 29, 8, 45), 125)]));

    currentDate = new Date(2026, 4, 29, 9, 0);
    const rootChildren = (await provider.getChildren()) ?? [];

    expect(rootChildren).toHaveLength(1);
    expect(provider.getTreeItem(rootChildren[0]).label).toBe('Today');
    expect(provider.getTreeItem(rootChildren[0]).description).toBe('1 session | 125 (1.2$)');
    const chatChildren = (await provider.getChildren(rootChildren[0])) ?? [];
    expect(provider.getTreeItem(chatChildren[0]).label).toBe('New day work');
  });

  it('renders yesterday bucket collapsed with session count and tokens', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(createSummary([createChat('chat-4', 'Yesterday work', new Date(2026, 4, 27, 10, 15), 175)]));

    const rootChildren = (await provider.getChildren()) ?? [];

    expect(rootChildren).toHaveLength(1);
    const bucketItem = provider.getTreeItem(rootChildren[0]);
    expect(bucketItem.label).toBe('Yesterday');
    expect(bucketItem.description).toBe('1 session | 175 (1.2$)');
    expect(bucketItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('renders token-only rows without cost text', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(
      createSummary([
        {
          ...createChat(
            'chat-1',
            'Feature work',
            new Date(2026, 4, 28, 9, 30),
            150,
            createCost(0),
          ),
          model: 'gpt-5.6',
        },
      ]),
    );

    const rootChildren = (await provider.getChildren()) ?? [];
    const bucketItem = provider.getTreeItem(rootChildren[0]);
    const chatChildren = (await provider.getChildren(rootChildren[0])) ?? [];
    const chatItem = provider.getTreeItem(chatChildren[0]);

    expect(bucketItem.description).toBe('1 session | 150');
    expect(bucketItem.tooltip).toContain('Tokens: 150');
    expect(bucketItem.tooltip).not.toContain('Cost:');
    expect(chatItem.description).toBe('09:30 | gpt-5.6 | 150');
    expect(chatItem.tooltip).toContain('Model: gpt-5.6');
    expect(chatItem.tooltip).not.toContain('Cost:');
  });

  it('shows exact tokens and formatted cost in hover tooltips', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(
      createSummary([
        createChat(
          'chat-1',
          'Feature work',
          new Date(2026, 4, 28, 9, 30),
          23_300,
          createCost(0.04),
        ),
      ]),
    );

    const rootChildren = (await provider.getChildren()) ?? [];
    const bucketItem = provider.getTreeItem(rootChildren[0]);
    expect(bucketItem.tooltip).toContain('Tokens: 23300');
    expect(bucketItem.tooltip).toContain('Cost: 0.04$');

    const chatChildren = (await provider.getChildren(rootChildren[0])) ?? [];
    const chatItem = provider.getTreeItem(chatChildren[0]);
    expect(chatItem.tooltip).toContain('Tokens: 23300');
    expect(chatItem.tooltip).toContain('Cost: 0.04$');
  });

  it('omits zero-credit costs from bucket and chat rows', async () => {
    const provider = new UsageTreeProvider(() => new Date(2026, 4, 28, 12, 0));
    provider.setSummary(
      createSummary([
        createChat(
          'chat-1',
          'Feature work',
          new Date(2026, 4, 28, 9, 30),
          150,
          createAvailableCost(0, 0),
        ),
      ]),
    );

    const rootChildren = (await provider.getChildren()) ?? [];
    const bucketItem = provider.getTreeItem(rootChildren[0]);
    const chatChildren = (await provider.getChildren(rootChildren[0])) ?? [];
    const chatItem = provider.getTreeItem(chatChildren[0]);

    expect(bucketItem.description).toBe('1 session | 150');
    expect(bucketItem.tooltip).not.toContain('Cost:');
    expect(chatItem.description).toBe('09:30 | gpt-4.1 | 150');
    expect(chatItem.tooltip).not.toContain('Cost:');
  });

});

describe('differenceInLocalCalendarDays', () => {
  it('buckets adjacent local calendar dates across spring DST as yesterday', () => {
    const previousDate = createDateLike(2026, 2, 29);
    const baseDate = createDateLike(2026, 2, 30);

    expect(differenceInLocalCalendarDays(previousDate, baseDate)).toBe(1);
  });
});

function createSummary(
  chats: ChatUsageSummary[] = [
    createChat('chat-1', 'Feature work', new Date(2026, 4, 28, 9, 30), 150),
    createChat('chat-2', 'Bug fix', new Date(2026, 4, 26, 14, 15), 100),
  ],
): UsageSummary {
  const totalTokens = chats.reduce((sum, chat) => sum + chat.tokens, 0);

  return {
    today: createTotal(100),
    week: createTotal(totalTokens),
    month: createTotal(2_000),
    allTime: createTotal(3_000_000),
    chats,
    topModels: [
      { model: 'gpt-4.1', sessions: chats.length, tokens: totalTokens, githubCopilot: createCost(1.2) },
    ],
    highestSessionToday: chats[0],
  };
}

function createChat(
  chatId: string,
  title: string,
  timestamp: Date,
  tokens: number,
  cost = createCost(1.2),
): ChatUsageSummary {
  const record: UsageRecord = {
    chatId,
    title,
    timestamp,
    model: 'gpt-4.1',
    tokens: {
      input: Math.floor(tokens / 2),
      cachedInput: 0,
      output: Math.ceil(tokens / 2),
      cacheWriteInput: 0,
      total: tokens,
      source: 'recorded',
    },
    filePath: 'usage.jsonl',
  };

  return {
    chatId,
    title,
    timestamp,
    model: 'gpt-4.1',
    tokens,
    githubCopilot: cost,
    records: [record],
  };
}

function createTotal(tokens: number): UsageTotal {
  return {
    tokens,
    githubCopilot: createCost(1.2),
  };
}

function createCost(usd: number): CopilotCostEstimate {
  return {
    available: usd > 0,
    usd,
    aiCredits: usd * 100,
  };
}

function createAvailableCost(usd: number, aiCredits: number): CopilotCostEstimate {
  return {
    available: true,
    usd,
    aiCredits,
  };
}

function createDateLike(year: number, month: number, day: number): Date {
  return {
    getFullYear: () => year,
    getMonth: () => month,
    getDate: () => day,
  } as Date;
}
