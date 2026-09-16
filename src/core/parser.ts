import { open, readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface RawUsageItem {
  value: unknown;
  filePath: string;
}

export interface ParseUsageFileResult {
  items: RawUsageItem[];
  malformedRecords: number;
  /**
   * Bytes of `filePath` these items were read from. The incremental JSONL
   * reader resumes here, so it must reflect what was actually parsed, never a
   * size sampled before the read.
   */
  consumedBytes: number;
}

export type ParseUsageMode = 'billed-usage' | 'metadata';

export interface ParseUsageFileOptions {
  mode: ParseUsageMode;
}

const AI_CREDIT_MARKER = '"copilotUsageNanoAiu"';
const MARKER_SCAN_CHUNK_BYTES = 4096;
const jsonArrayContainerKeys = ['records', 'items', 'requests', 'turns', 'chats'];

function itemsFromArray(values: unknown[], filePath: string): RawUsageItem[] {
  return values.map((value) => ({ value, filePath }));
}

export async function parseUsageFile(
  filePath: string,
  options: ParseUsageFileOptions,
): Promise<ParseUsageFileResult> {
  if (options.mode === 'billed-usage' && !(await fileContainsAiCredits(filePath))) {
    return { items: [], malformedRecords: 0, consumedBytes: 0 };
  }

  const content = await readFile(filePath, 'utf8');
  const extension = extname(filePath).toLowerCase();

  if (extension === '.jsonl') {
    return parseJsonlContent(content, filePath);
  }

  const consumedBytes = Buffer.byteLength(content, 'utf8');

  if (extension === '.json') {
    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed)) {
      return { items: itemsFromArray(parsed, filePath), malformedRecords: 0, consumedBytes };
    }

    if (parsed !== null && typeof parsed === 'object') {
      for (const key of jsonArrayContainerKeys) {
        const value = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
          return { items: itemsFromArray(value, filePath), malformedRecords: 0, consumedBytes };
        }
      }
    }

    return { items: [{ value: parsed, filePath }], malformedRecords: 0, consumedBytes };
  }

  return { items: [], malformedRecords: 0, consumedBytes };
}

async function fileContainsAiCredits(filePath: string): Promise<boolean> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MARKER_SCAN_CHUNK_BYTES);
    let carry = '';

    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        return false;
      }

      const content = carry + buffer.subarray(0, bytesRead).toString('utf8');
      if (content.includes(AI_CREDIT_MARKER)) {
        return true;
      }

      carry = content.slice(-(AI_CREDIT_MARKER.length - 1));
    }
  } finally {
    await file.close();
  }
}

function parseJsonlContent(content: string, filePath: string): ParseUsageFileResult {
  const items: RawUsageItem[] = [];
  let malformedRecords = 0;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      items.push({ value: JSON.parse(trimmed) as unknown, filePath });
    } catch {
      malformedRecords += 1;
    }
  }

  return { items, malformedRecords, consumedBytes: Buffer.byteLength(content, 'utf8') };
}

export function parseCompleteJsonlLines(content: string, filePath: string): ParseUsageFileResult {
  const lastNewline = Math.max(content.lastIndexOf('\n'), content.lastIndexOf('\r'));
  if (lastNewline === -1) {
    return { items: [], malformedRecords: 0, consumedBytes: 0 };
  }

  return parseJsonlContent(content.slice(0, lastNewline + 1), filePath);
}
