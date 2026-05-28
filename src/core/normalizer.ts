import { basename, dirname } from 'node:path';

import type { TokenSource, TokenUsage, UsageRecord } from './types';
import type { RawUsageItem } from './parser';

type RecordValue = Record<string, unknown>;

const TITLE_PRIORITY_GENERATED = 4;
const TITLE_PRIORITY_CUSTOM = 5;
const TITLE_PRIORITY_PROMPT = 2;
const TITLE_PRIORITY_RECORD = 1;
const TITLE_PRIORITY_GENERIC = 0;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: RecordValue, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function readNumber(record: RecordValue, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }

  return undefined;
}

function readBilling(record: RecordValue): UsageRecord['billing'] {
  const nanoAiu = readNumber(record, ['copilotUsageNanoAiu']);
  return nanoAiu === undefined || nanoAiu <= 0
    ? undefined
    : {
        aiCredits: nanoAiu / 1_000_000_000,
        source: 'copilot-debug-log',
      };
}

function readNestedRecord(record: RecordValue, key: string): RecordValue | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readTimestampValue(value: unknown): Date | undefined {
  if (typeof value === 'string') {
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
  }

  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
  }

  return undefined;
}

function readTimestamp(record: RecordValue): Date {
  for (const key of ['timestamp', 'createdAt', 'creationDate', 'date', 'time', 'ts']) {
    const timestamp = readTimestampValue(record[key]);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return new Date(0);
}

function readTimestampFromRecords(records: Array<RecordValue | undefined>): Date {
  for (const record of records) {
    if (!record) {
      continue;
    }

    const timestamp = readTimestamp(record);
    if (timestamp.getTime() !== 0) {
      return timestamp;
    }
  }

  return new Date(0);
}

function buildTokenUsage(
  input: number,
  output: number,
  cachedInput = 0,
  cacheWriteInput = 0,
  source: TokenSource,
  total?: number,
): TokenUsage {
  return {
    input,
    cachedInput,
    output,
    cacheWriteInput,
    total: total ?? input + output,
    source,
  };
}

function subtractCachedTokens(
  input: number,
  output: number,
  cached: number | undefined,
): { input: number; output: number; total: number } {
  const cachedTokens = cached ?? 0;
  const effectiveInput = Math.max(0, input - cachedTokens);
  const remainingCached = Math.max(0, cachedTokens - input);
  const effectiveOutput = Math.max(0, output - remainingCached);

  return {
    input: effectiveInput,
    output: effectiveOutput,
    total: effectiveInput + effectiveOutput,
  };
}

function isTitleGenerationName(name: string | undefined): boolean {
  if (name === undefined) {
    return false;
  }

  const normalized = name.trim().toLowerCase();
  return normalized === 'title' || normalized === 'generate title' || normalized === 'chat title';
}

function isGenericDebugName(name: string | undefined): boolean {
  if (name === undefined) {
    return true;
  }

  const normalized = name.trim().toLowerCase();
  return normalized === '' || normalized === 'panel/editagent' || normalized === 'copilot debug request';
}

function compactTitle(value: string, maxLength = 64): string | undefined {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (compacted.length === 0) {
    return undefined;
  }

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`;
}

function chatIdFromFilePath(filePath: string): string | undefined {
  const name = basename(filePath).replace(/\.[^.]+$/, '');
  return name.length > 0 ? name : undefined;
}

function parentDebugSessionIdFromTitleFile(filePath: string): string | undefined {
  if (!basename(filePath).toLowerCase().startsWith('title-')) {
    return undefined;
  }

  const parent = basename(dirname(filePath));
  return parent.length > 0 ? parent : undefined;
}

function parseAssistantResponseTitle(response: string): string | undefined {
  try {
    const parsed = JSON.parse(response) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    for (const message of parsed) {
      if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.parts)) {
        continue;
      }

      for (const part of message.parts) {
        if (!isRecord(part) || part.type !== 'text' || typeof part.content !== 'string') {
          continue;
        }

        const title = compactTitle(part.content);
        if (title !== undefined) {
          return title;
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function buildUsageRecord(
  item: RawUsageItem,
  values: Omit<UsageRecord, 'filePath'>,
): UsageRecord {
  return {
    ...values,
    filePath: item.filePath,
  };
}

function buildTitleMetadataRecord(
  item: RawUsageItem,
  chatId: string,
  title: string,
  timestamp: Date,
  titlePriority: number,
): UsageRecord {
  return buildUsageRecord(item, {
    chatId,
    title,
    timestamp,
    model: 'unknown',
    metadataOnly: true,
    titlePriority,
    tokens: buildTokenUsage(0, 0, 0, 0, 'missing'),
  });
}

function normalizeCopilotGeneratedTitleRecord(item: RawUsageItem, value: RecordValue): UsageRecord[] {
  if (value.type !== 'agent_response') {
    return [];
  }

  const chatId = parentDebugSessionIdFromTitleFile(item.filePath);
  const attrs = readNestedRecord(value, 'attrs');
  const response = attrs ? readString(attrs, ['response']) : undefined;
  const title = response ? parseAssistantResponseTitle(response) : undefined;
  if (chatId === undefined || title === undefined) {
    return [];
  }

  return [buildTitleMetadataRecord(item, chatId, title, readTimestamp(value), TITLE_PRIORITY_GENERATED)];
}

function normalizeCopilotChatSessionTitleRecord(item: RawUsageItem, value: RecordValue): UsageRecord[] {
  if (value.kind === 0) {
    const session = readNestedRecord(value, 'v');
    const title = session ? readString(session, ['customTitle']) : undefined;
    const chatId = session ? readString(session, ['sessionId']) : undefined;
    if (title !== undefined && chatId !== undefined) {
      return [
        buildTitleMetadataRecord(
          item,
          chatId,
          title,
          readTimestampFromRecords([session, value]),
          TITLE_PRIORITY_CUSTOM,
        ),
      ];
    }
  }

  if (value.kind === 1 && Array.isArray(value.k) && value.k.includes('customTitle')) {
    const chatId = chatIdFromFilePath(item.filePath);
    const title = typeof value.v === 'string' ? compactTitle(value.v) : undefined;
    if (chatId !== undefined && title !== undefined) {
      return [buildTitleMetadataRecord(item, chatId, title, readTimestamp(value), TITLE_PRIORITY_CUSTOM)];
    }
  }

  return [];
}

function normalizeCopilotTranscriptUserMessage(item: RawUsageItem, value: RecordValue): UsageRecord[] {
  if (value.type !== 'user.message') {
    return [];
  }

  const data = readNestedRecord(value, 'data');
  const content = data ? readString(data, ['content']) : undefined;
  const title = content ? compactTitle(content) : undefined;
  const chatId = chatIdFromFilePath(item.filePath);
  if (chatId === undefined || title === undefined) {
    return [];
  }

  return [buildTitleMetadataRecord(item, chatId, title, readTimestamp(value), TITLE_PRIORITY_PROMPT)];
}

function normalizeCopilotDebugLogRecord(item: RawUsageItem, value: RecordValue): UsageRecord[] {
  if (value.type !== 'llm_request') {
    return [];
  }

  const attrs = readNestedRecord(value, 'attrs');
  if (attrs === undefined) {
    return [];
  }

  const billing = readBilling(attrs);
  if (billing === undefined) {
    return [];
  }

  const input = readNumber(attrs, ['inputTokens', 'input_tokens']);
  const output = readNumber(attrs, ['outputTokens', 'output_tokens']);
  if (input === undefined && output === undefined) {
    return [];
  }
  const cachedInput = readNumber(attrs, ['cachedTokens', 'cached_tokens']) ?? 0;
  const cacheWriteInput = readNumber(attrs, [
    'cacheWriteInputTokens',
    'cache_write_input_tokens',
    'cacheCreationInputTokens',
    'cache_creation_input_tokens',
  ]) ?? 0;
  const tokens = subtractCachedTokens(input ?? 0, output ?? 0, cachedInput);
  const timestamp = readTimestamp(value);

  const chatId =
    readString(value, ['sid', 'sessionId']) ??
    readString(attrs, ['sessionId', 'responseId']) ??
    `${item.filePath}:${timestamp.toISOString()}`;
  const debugName = readString(attrs, ['debugName']);

  return [
    buildUsageRecord(item, {
      chatId,
      title: debugName ?? 'Copilot debug request',
      timestamp,
      model: readString(attrs, ['model']) ?? 'unknown',
      hiddenFromExplorer: isTitleGenerationName(debugName),
      titlePriority: isGenericDebugName(debugName) ? TITLE_PRIORITY_GENERIC : TITLE_PRIORITY_RECORD,
      tokens: buildTokenUsage(tokens.input, tokens.output, cachedInput, cacheWriteInput, 'recorded', tokens.total),
      billing,
    }),
  ];
}

export function normalizeRawUsage(item: RawUsageItem): UsageRecord[] {
  if (!isRecord(item.value)) {
    return [];
  }

  const value = item.value;
  const generatedTitleRecords = normalizeCopilotGeneratedTitleRecord(item, value);
  if (generatedTitleRecords.length > 0) {
    return generatedTitleRecords;
  }

  const chatSessionTitleRecords = normalizeCopilotChatSessionTitleRecord(item, value);
  if (chatSessionTitleRecords.length > 0) {
    return chatSessionTitleRecords;
  }

  const transcriptTitleRecords = normalizeCopilotTranscriptUserMessage(item, value);
  if (transcriptTitleRecords.length > 0) {
    return transcriptTitleRecords;
  }

  const debugLogRecords = normalizeCopilotDebugLogRecord(item, value);
  if (debugLogRecords.length > 0) {
    return debugLogRecords;
  }

  return [];
}
