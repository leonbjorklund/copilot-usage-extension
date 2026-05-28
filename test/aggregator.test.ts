import { describe, expect, it } from 'vitest';

import { aggregateUsage } from '../src/core/aggregator';
import type { UsageRecord } from '../src/core/types';

describe('aggregateUsage', () => {
  it('aggregates positive AI Credit usage totals and chat summaries', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const records: UsageRecord[] = [
      createBilledRecord('small', 'Small chat', new Date('2026-05-28T08:00:00Z'), 'gpt-small', 20),
      createBilledRecord('large', 'Large chat', new Date('2026-05-20T08:00:00Z'), 'gpt-large', 200),
      createBilledRecord('old', 'Old chat', new Date('2026-04-01T08:00:00Z'), 'gpt-old', 100),
      createRecord('token-only', 'Token only', new Date('2026-05-28T09:00:00Z'), 'gpt-token', 500),
      createBilledRecord('zero-credit', 'Zero credit', new Date('2026-05-28T10:00:00Z'), 'gpt-zero', 600, 0),
    ];

    const summary = aggregateUsage(records, now);

    expect(summary.today).toEqual(createTotal(20, 0.2));
    expect(summary.month).toEqual(createTotal(220, 2.2));
    expect(summary.allTime).toEqual(createTotal(320, 3.2));
    expect(summary.chats.map((chat) => chat.chatId)).toEqual(['small', 'large', 'old']);
  });

  it('keeps visible chat records sorted newest first', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const olderRecord = createBilledRecord('chat', 'Older title', new Date('2026-05-28T08:00:00Z'), 'gpt-old', 20);
    const newerRecord = createBilledRecord('chat', 'Newer title', new Date('2026-05-28T10:00:00Z'), 'gpt-new', 40);
    olderRecord.filePath = 'older.json';
    newerRecord.filePath = 'newer.json';

    const summary = aggregateUsage([olderRecord, newerRecord], now);

    expect(summary.chats).toHaveLength(1);
    expect(summary.chats[0]).toMatchObject({
      chatId: 'chat',
      title: 'Newer title',
      model: 'gpt-new',
      timestamp: newerRecord.timestamp,
      tokens: 60,
    });
    expect(summary.chats[0].records.map((record) => record.filePath)).toEqual(['newer.json', 'older.json']);
  });

  it('excludes hidden records from user-facing totals and sessions', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const records: UsageRecord[] = [
      {
        chatId: 'visible',
        title: 'Visible chat',
        timestamp: new Date('2026-05-28T08:00:00Z'),
        model: 'gpt-visible',
        tokens: {
          input: 10,
          cachedInput: 0,
          output: 10,
          cacheWriteInput: 0,
          total: 20,
          source: 'recorded',
        },
        filePath: 'visible.json',
        billing: {
          aiCredits: 0.2,
          source: 'copilot-debug-log',
        },
      },
      {
        chatId: 'hidden',
        title: 'Hidden chat',
        timestamp: new Date('2026-05-28T09:00:00Z'),
        model: 'gpt-hidden',
        tokens: {
          input: 30,
          cachedInput: 0,
          output: 30,
          cacheWriteInput: 0,
          total: 60,
          source: 'recorded',
        },
        filePath: 'hidden.json',
        hiddenFromExplorer: true,
        billing: {
          aiCredits: 0.6,
          source: 'copilot-debug-log',
        },
      },
    ];

    const summary = aggregateUsage(records, now);

    expect(summary.today).toEqual(createTotal(20, 0.2));
    expect(summary.month).toEqual(createTotal(20, 0.2));
    expect(summary.allTime).toEqual(createTotal(20, 0.2));
    expect(summary.chats.map((chat) => chat.chatId)).toEqual(['visible']);
  });

  it('sorts sessions by latest timestamp instead of token count', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const records: UsageRecord[] = [
      createBilledRecord('large-old', 'Large old chat', new Date('2026-05-28T08:00:00Z'), 'gpt-large', 200),
      createBilledRecord('small-new', 'Small new chat', new Date('2026-05-28T10:00:00Z'), 'gpt-small', 20),
    ];

    const summary = aggregateUsage(records, now);

    expect(summary.chats.map((chat) => chat.chatId)).toEqual(['small-new', 'large-old']);
  });

  it('uses highest priority title metadata for session and child record labels', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const records: UsageRecord[] = [
      {
        chatId: 'session-1',
        title: 'panel/editAgent',
        timestamp: new Date('2026-05-28T08:00:00Z'),
        model: 'gpt-test',
        titlePriority: 0,
        tokens: {
          input: 100,
          cachedInput: 0,
          output: 50,
          cacheWriteInput: 0,
          total: 150,
          source: 'recorded',
        },
        filePath: 'main.jsonl',
        billing: {
          aiCredits: 1.5,
          source: 'copilot-debug-log',
        },
      },
      {
        chatId: 'session-1',
        title: 'First prompt fallback',
        timestamp: new Date('2026-05-28T08:00:01Z'),
        model: 'unknown',
        tokens: {
          input: 0,
          cachedInput: 0,
          output: 0,
          cacheWriteInput: 0,
          total: 0,
          source: 'missing',
        },
        filePath: 'transcript.jsonl',
        metadataOnly: true,
        titlePriority: 2,
      },
      {
        chatId: 'session-1',
        title: 'Generated chat title',
        timestamp: new Date('2026-05-28T08:00:02Z'),
        model: 'unknown',
        tokens: {
          input: 0,
          cachedInput: 0,
          output: 0,
          cacheWriteInput: 0,
          total: 0,
          source: 'missing',
        },
        filePath: 'title.jsonl',
        metadataOnly: true,
        titlePriority: 4,
      },
    ];

    const summary = aggregateUsage(records, now);

    expect(summary.chats).toHaveLength(1);
    expect(summary.chats[0].title).toBe('Generated chat title');
    expect(summary.chats[0].records).toHaveLength(1);
    expect(summary.chats[0].records[0].title).toBe('panel/editAgent');
  });

  it('falls back to session id before generic debug names', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const records: UsageRecord[] = [
      {
        chatId: 'session-1',
        title: 'panel/editAgent',
        timestamp: new Date('2026-05-28T08:00:00Z'),
        model: 'gpt-test',
        titlePriority: 0,
        tokens: {
          input: 100,
          cachedInput: 0,
          output: 50,
          cacheWriteInput: 0,
          total: 150,
          source: 'recorded',
        },
        filePath: 'main.jsonl',
        billing: {
          aiCredits: 1.5,
          source: 'copilot-debug-log',
        },
      },
    ];

    const summary = aggregateUsage(records, now);

    expect(summary.chats[0].title).toBe('session-1');
  });

  it('ignores hidden records when selecting session titles', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const records: UsageRecord[] = [
      {
        chatId: 'session-1',
        title: 'title',
        timestamp: new Date('2026-05-28T08:00:00Z'),
        model: 'gpt-title',
        titlePriority: 1,
        hiddenFromExplorer: true,
        tokens: {
          input: 10,
          cachedInput: 0,
          output: 2,
          cacheWriteInput: 0,
          total: 12,
          source: 'recorded',
        },
        filePath: 'title.jsonl',
      },
      {
        chatId: 'session-1',
        title: 'panel/editAgent',
        timestamp: new Date('2026-05-28T08:00:01Z'),
        model: 'gpt-test',
        titlePriority: 0,
        tokens: {
          input: 100,
          cachedInput: 0,
          output: 50,
          cacheWriteInput: 0,
          total: 150,
          source: 'recorded',
        },
        filePath: 'main.jsonl',
        billing: {
          aiCredits: 1.5,
          source: 'copilot-debug-log',
        },
      },
    ];

    const summary = aggregateUsage(records, now);

    expect(summary.chats[0].title).toBe('session-1');
  });

  it('prefers stored custom titles over generated title metadata', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    const records: UsageRecord[] = [
      {
        chatId: 'session-1',
        title: 'panel/editAgent',
        timestamp: new Date('2026-05-28T08:00:00Z'),
        model: 'gpt-test',
        titlePriority: 0,
        tokens: {
          input: 100,
          cachedInput: 0,
          output: 50,
          cacheWriteInput: 0,
          total: 150,
          source: 'recorded',
        },
        filePath: 'main.jsonl',
        billing: {
          aiCredits: 1.5,
          source: 'copilot-debug-log',
        },
      },
      {
        chatId: 'session-1',
        title: 'Generated chat title',
        timestamp: new Date('2026-05-28T08:00:02Z'),
        model: 'unknown',
        tokens: {
          input: 0,
          cachedInput: 0,
          output: 0,
          cacheWriteInput: 0,
          total: 0,
          source: 'missing',
        },
        filePath: 'title.jsonl',
        metadataOnly: true,
        titlePriority: 4,
      },
      {
        chatId: 'session-1',
        title: 'Stored custom title',
        timestamp: new Date(0),
        model: 'unknown',
        tokens: {
          input: 0,
          cachedInput: 0,
          output: 0,
          cacheWriteInput: 0,
          total: 0,
          source: 'missing',
        },
        filePath: 'chatSession.jsonl',
        metadataOnly: true,
        titlePriority: 5,
      },
    ];

    const summary = aggregateUsage(records, now);

    expect(summary.chats[0].title).toBe('Stored custom title');
    expect(summary.chats[0].records[0].title).toBe('panel/editAgent');
  });

  it('adds week total using local Monday start', () => {
    const now = new Date(2026, 4, 28, 12, 0);
    const summary = aggregateUsage(
      [
        createBilledRecord('monday', 'Monday', new Date(2026, 4, 25, 8, 0), 'model-a', 100),
        createBilledRecord('sunday', 'Sunday', new Date(2026, 4, 24, 8, 0), 'model-a', 200),
      ],
      now,
    );

    expect(summary.week).toEqual(createTotal(100, 1));
  });

  it('ranks top models by tokens and counts sessions', () => {
    const now = new Date(2026, 4, 28, 12, 0);
    const summary = aggregateUsage(
      [
        createBilledRecord('a-1', 'A1', new Date(2026, 4, 28, 8, 0), 'model-a', 100),
        createBilledRecord('a-2', 'A2', new Date(2026, 4, 28, 9, 0), 'model-a', 150),
        createBilledRecord('b-1', 'B1', new Date(2026, 4, 28, 10, 0), 'model-b', 300),
        createBilledRecord('c-1', 'C1', new Date(2026, 4, 28, 11, 0), 'model-c', 50),
        createBilledRecord('d-1', 'D1', new Date(2026, 4, 28, 12, 0), 'model-d', 25),
      ],
      now,
    );

    expect(summary.topModels).toEqual([
      { model: 'model-b', sessions: 1, tokens: 300, githubCopilot: createCost(3) },
      { model: 'model-a', sessions: 2, tokens: 250, githubCopilot: createCost(2.5) },
      { model: 'model-c', sessions: 1, tokens: 50, githubCopilot: createCost(0.5) },
    ]);
  });

  it('ranks top models from underlying records in mixed-model sessions', () => {
    const now = new Date(2026, 4, 28, 12, 0);
    const summary = aggregateUsage(
      [
        createBilledRecord('mixed', 'Mixed chat', new Date(2026, 4, 28, 8, 0), 'model-a', 100),
        createBilledRecord('mixed', 'Mixed chat', new Date(2026, 4, 28, 9, 0), 'model-b', 200),
        createBilledRecord('solo', 'Solo chat', new Date(2026, 4, 28, 10, 0), 'model-a', 50),
      ],
      now,
    );

    expect(summary.topModels).toEqual([
      { model: 'model-b', sessions: 1, tokens: 200, githubCopilot: createCost(2) },
      { model: 'model-a', sessions: 2, tokens: 150, githubCopilot: createCost(1.5) },
    ]);
  });

  it('excludes hidden token records from top model usage', () => {
    const now = new Date(2026, 4, 28, 12, 0);
    const visible = createBilledRecord('chat', 'Visible', new Date(2026, 4, 28, 8, 0), 'visible-model', 100);
    const hidden = {
      ...createBilledRecord('hidden', 'title', new Date(2026, 4, 28, 9, 0), 'hidden-model', 200),
      hiddenFromExplorer: true,
    } satisfies UsageRecord;

    const summary = aggregateUsage([visible, hidden], now);

    expect(summary.today).toEqual(createTotal(100, 1));
    expect(summary.chats.map((chat) => chat.chatId)).toEqual(['chat']);
    expect(summary.topModels).toEqual([
      { model: 'visible-model', sessions: 1, tokens: 100, githubCopilot: createCost(1) },
    ]);
  });

  it('aggregates AI Credits from billed records and ignores token-only records', () => {
    const now = new Date('2026-05-29T12:00:00.000Z');
    const billed = {
      ...createRecord('billed', 'Billed', new Date('2026-05-29T08:00:00Z'), 'gemini-3.5-flash', 1_250),
      billing: {
        aiCredits: 2.204445,
        source: 'copilot-debug-log',
      },
    } satisfies UsageRecord;
    const tokenOnly = createRecord('token-only', 'Token only', new Date('2026-05-29T09:00:00Z'), 'unknown-model', 100);

    const summary = aggregateUsage([billed, tokenOnly], now);

    expect(summary.today.tokens).toBe(1_250);
    expect(summary.today.githubCopilot).toEqual({
      available: true,
      usd: 0.02204445,
      aiCredits: 2.204445,
    });
    expect(summary.chats.map((chat) => chat.chatId)).toEqual(['billed']);
  });

  it('ignores billed records with zero AI Credits', () => {
    const now = new Date('2026-05-29T12:00:00.000Z');
    const billed = {
      ...createRecord('billed-zero', 'Billed zero', new Date('2026-05-29T08:00:00Z'), 'gpt-zero', 100),
      billing: {
        aiCredits: 0,
        source: 'copilot-debug-log',
      },
    } satisfies UsageRecord;

    const summary = aggregateUsage([billed], now);

    expect(summary.today).toEqual(createTotal(0));
    expect(summary.chats).toEqual([]);
  });

  it('ignores token-only records', () => {
    const now = new Date('2026-05-29T12:00:00.000Z');

    const summary = aggregateUsage(
      [createRecord('token-only', 'Token only', new Date('2026-05-29T09:00:00Z'), 'unknown-model', 100)],
      now,
    );

    expect(summary.today).toEqual(createTotal(0));
    expect(summary.chats).toEqual([]);
    expect(summary.topModels).toEqual([]);
  });

  it('selects highest token and cost sessions from today-only usage', () => {
    const now = new Date(2026, 4, 28, 12, 0);
    const summary = aggregateUsage(
      [
        createBilledRecord('costly', 'Costly today', new Date(2026, 4, 28, 8, 0), 'model-expensive', 100, 450),
        createBilledRecord('large', 'Large today', new Date(2026, 4, 28, 9, 0), 'model-large', 300, 300),
        createBilledRecord('large', 'Large yesterday', new Date(2026, 4, 27, 9, 0), 'model-large', 500, 500),
      ],
      now,
    );

    expect(summary.highestSessionToday).toMatchObject({
      chatId: 'large',
      title: 'Large today',
      tokens: 300,
      model: 'model-large',
    });
    expect(summary).toHaveProperty('mostExpensiveSessionToday');
    expect(summary.mostExpensiveSessionToday).toMatchObject({
      chatId: 'costly',
      title: 'Costly today',
      tokens: 100,
      model: 'model-expensive',
      githubCopilot: createCost(450),
    });
  });
});

function createRecord(chatId: string, title: string, timestamp: Date, model: string, total: number): UsageRecord {
  return {
    chatId,
    title,
    timestamp,
    model,
    tokens: {
      input: total,
      cachedInput: 0,
      output: 0,
      cacheWriteInput: 0,
      total,
      source: 'recorded',
    },
    filePath: `${chatId}.jsonl`,
  };
}

function createBilledRecord(
  chatId: string,
  title: string,
  timestamp: Date,
  model: string,
  total: number,
  aiCredits = total / 100,
): UsageRecord {
  return {
    ...createRecord(chatId, title, timestamp, model, total),
    billing: {
      aiCredits,
      source: 'copilot-debug-log',
    },
  };
}

function createTotal(tokens: number, aiCredits = 0) {
  return {
    tokens,
    githubCopilot: createCost(aiCredits),
  };
}

function createCost(aiCredits = 0) {
  return {
    available: aiCredits > 0,
    usd: Number((aiCredits * 0.01).toFixed(10)),
    aiCredits,
  };
}
