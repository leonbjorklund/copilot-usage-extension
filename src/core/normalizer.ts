import { basename, dirname } from 'node:path';

import { TITLE_PRIORITY, type UsageRecord } from './types';
import type { RawUsageItem } from './parser';

type RecordValue = Record<string, unknown>;

const DEBUG_LOG_FOLDER_NAME = 'debug-logs';
const DEBUG_LOG_MAIN_FILE_NAME = 'main.jsonl';

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

/**
 * Copilot writes every log for one chat into `debug-logs/<sessionId>/`. The
 * folder name is the chat session id; `sid` inside a child log is the id of the
 * child run (a subagent call id, or the title request id), not the chat.
 */
export function debugSessionIdFromFilePath(filePath: string): string | undefined {
  const folder = dirname(filePath);
  if (basename(dirname(folder)).toLowerCase() !== DEBUG_LOG_FOLDER_NAME) {
    return undefined;
  }

  const sessionId = basename(folder);
  return sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Anything beside `main.jsonl` in a session folder is a child run: a subagent,
 * a search subagent, or title generation. Subagent spend belongs to the chat,
 * but a child run's `debugName` must never become the chat's label.
 */
export function isChildDebugLogFile(filePath: string): boolean {
  return (
    debugSessionIdFromFilePath(filePath) !== undefined &&
    basename(filePath).toLowerCase() !== DEBUG_LOG_MAIN_FILE_NAME
  );
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

function buildTitleMetadataRecord(
  item: RawUsageItem,
  chatId: string,
  title: string,
  timestamp: Date,
  titlePriority: number,
): UsageRecord {
  return {
    chatId,
    title,
    timestamp,
    model: 'unknown',
    metadataOnly: true,
    titlePriority,
    tokens: { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0, total: 0, source: 'missing' },
    filePath: item.filePath,
  };
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

  return [buildTitleMetadataRecord(item, chatId, title, readTimestamp(value), TITLE_PRIORITY.generated)];
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
          TITLE_PRIORITY.custom,
        ),
      ];
    }
  }

  if (value.kind === 1 && Array.isArray(value.k) && value.k.includes('customTitle')) {
    const chatId = chatIdFromFilePath(item.filePath);
    const title = typeof value.v === 'string' ? compactTitle(value.v) : undefined;
    if (chatId !== undefined && title !== undefined) {
      return [buildTitleMetadataRecord(item, chatId, title, readTimestamp(value), TITLE_PRIORITY.custom)];
    }
  }

  return [];
}

function normalizeCopilotTranscriptUserMessage(item: RawUsageItem, value: RecordValue): UsageRecord[] {
  // `user_message` with `attrs.content` is the current debug-log shape;
  // `user.message` with `data.content` is the older transcript shape.
  if (value.type !== 'user_message' && value.type !== 'user.message') {
    return [];
  }

  const payload = readNestedRecord(value, 'attrs') ?? readNestedRecord(value, 'data');
  const content = payload ? readString(payload, ['content']) : undefined;
  const title = content ? compactTitle(content) : undefined;
  // A prompt inside a child log belongs to the subagent, not to the chat.
  const chatId = isChildDebugLogFile(item.filePath)
    ? undefined
    : debugSessionIdFromFilePath(item.filePath) ?? chatIdFromFilePath(item.filePath);
  if (chatId === undefined || title === undefined) {
    return [];
  }

  return [buildTitleMetadataRecord(item, chatId, title, readTimestamp(value), TITLE_PRIORITY.prompt)];
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

  // Prefer the session folder so subagent and title runs bill to their chat
  // instead of appearing as separate sessions keyed by their own `sid`.
  const chatId =
    debugSessionIdFromFilePath(item.filePath) ??
    readString(value, ['sid', 'sessionId']) ??
    readString(attrs, ['sessionId', 'responseId']) ??
    `${item.filePath}:${timestamp.toISOString()}`;
  const debugName = readString(attrs, ['debugName']);
  const childRun = isChildDebugLogFile(item.filePath);

  return [
    {
      chatId,
      title: debugName ?? 'Copilot debug request',
      timestamp,
      model: readString(attrs, ['model']) ?? 'unknown',
      hiddenFromExplorer: isTitleGenerationName(debugName),
      titlePriority: childRun
        ? TITLE_PRIORITY.childRun
        : isGenericDebugName(debugName)
          ? TITLE_PRIORITY.generic
          : TITLE_PRIORITY.record,
      tokens: { ...tokens, cachedInput, cacheWriteInput, source: 'recorded' },
      billing,
      filePath: item.filePath,
    },
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

  return normalizeCopilotDebugLogRecord(item, value);
}
