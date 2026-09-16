import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isIgnoredUsageCacheFile, isSameOrInsidePath, isSupportedUsageFile, pathContainsUsageFolder } from './scanner';
import type { ScanDiagnostics } from './scanner';
import type { ExtensionConfig, UsageRecord } from './types';

// Bump when the cache schema or parser/normalizer interpretation changes.
const CACHE_VERSION = 1;
export const MAX_USAGE_INDEX_CACHE_BYTES = 64 * 1024 * 1024;

export interface CachedUsageFile {
  key: string;
  filePath: string;
  mode: 'metadata' | 'billed-usage';
  countInDiagnostics: boolean;
  records: UsageRecord[];
  parsedRecords: number;
  skippedRecords: number;
  skippedMalformedFiles: number;
  sizeBytes: number;
  mtimeMs: number;
  jsonlOffsetBytes: number;
  canAppendJsonl: boolean;
  jsonlPrefixDigest?: string;
}

export interface UsageIndexCacheSnapshot {
  files: CachedUsageFile[];
  watchFolders: string[];
  diagnostics: ScanDiagnostics;
}

export interface UsageIndexCacheScope {
  roots: string[];
  dataPath: string;
  maxFileSizeMb: number;
  maxScanDepth: number;
}

export function usageIndexCacheScope(roots: string[], config: ExtensionConfig): UsageIndexCacheScope {
  return {
    roots: [...new Set(roots.map(pathKey))].sort(),
    dataPath: config.dataPath.trim() ? pathKey(config.dataPath.trim()) : '',
    maxFileSizeMb: config.maxFileSizeMb,
    maxScanDepth: config.maxScanDepth,
  };
}

function cachePath(directory: string, scope: UsageIndexCacheScope): string {
  const digest = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return join(directory, `usage-index-${digest}.cache`);
}

/** A missing, oversized, incompatible or malformed cache is always a cache miss. */
export async function readUsageIndexCache(directory: string, scope: UsageIndexCacheScope): Promise<UsageIndexCacheSnapshot | undefined> {
  try {
    const file = await open(cachePath(directory, scope), 'r');
    let content: Buffer;
    try {
      const size = (await file.stat()).size;
      if (size <= 0 || size > MAX_USAGE_INDEX_CACHE_BYTES) return undefined;
      // Read a fixed allocation so replacement/growth cannot bypass the bound.
      content = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(content, offset, size - offset, offset);
        if (bytesRead === 0) return undefined;
        offset += bytesRead;
      }
    } finally {
      await file.close();
    }
    const value: unknown = JSON.parse(content.toString('utf8'));
    if (!object(value) || value.version !== CACHE_VERSION || JSON.stringify(value.scope) !== JSON.stringify(scope)) return undefined;
    if (!Array.isArray(value.files) || !Array.isArray(value.watchFolders) || !object(value.diagnostics)) return undefined;
    const diagnostics: ScanDiagnostics = {
      scannedFiles: integer(value.diagnostics.scannedFiles),
      skippedFolders: integer(value.diagnostics.skippedFolders),
      unsupportedFiles: integer(value.diagnostics.unsupportedFiles),
      oversizedFiles: integer(value.diagnostics.oversizedFiles),
      unreadableFiles: integer(value.diagnostics.unreadableFiles),
    };
    const watchFolders = value.watchFolders.map((folder) => {
      if (typeof folder !== 'string' || !authorizedPath(folder, scope)) throw new Error('Invalid cache folder');
      return folder;
    });
    const files = value.files.map((entry) => parseFile(entry, scope));
    if (new Set(files.map((file) => file.key)).size !== files.length) return undefined;
    return { files, watchFolders, diagnostics };
  } catch {
    return undefined;
  }
}

/** Each writer publishes one complete snapshot; failures leave the old file intact. */
export async function writeUsageIndexCache(directory: string, scope: UsageIndexCacheScope, snapshot: UsageIndexCacheSnapshot): Promise<void> {
  const content = JSON.stringify({ version: CACHE_VERSION, scope, ...snapshot });
  if (Buffer.byteLength(content) > MAX_USAGE_INDEX_CACHE_BYTES) throw new Error('Usage index cache exceeds size limit');
  await mkdir(directory, { recursive: true });
  const target = cachePath(directory, scope);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseFile(value: unknown, scope: UsageIndexCacheScope): CachedUsageFile {
  if (!object(value) || typeof value.filePath !== 'string' || !authorizedPath(value.filePath, scope, true) ||
      !isSupportedUsageFile(value.filePath) || isIgnoredUsageCacheFile(value.filePath) ||
      typeof value.key !== 'string' || !isAbsolute(value.key) ||
      (value.mode !== 'metadata' && value.mode !== 'billed-usage') ||
      typeof value.countInDiagnostics !== 'boolean' || typeof value.canAppendJsonl !== 'boolean' || !Array.isArray(value.records)) {
    throw new Error('Invalid cached file');
  }
  const sizeBytes = integer(value.sizeBytes);
  const jsonlOffsetBytes = integer(value.jsonlOffsetBytes);
  if (sizeBytes > scope.maxFileSizeMb * 1024 * 1024 || jsonlOffsetBytes > sizeBytes ||
      (value.canAppendJsonl && (!value.filePath.toLowerCase().endsWith('.jsonl') ||
        typeof value.jsonlPrefixDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.jsonlPrefixDigest)))) {
    throw new Error('Invalid cached file revision');
  }
  const records = value.records.map((record) => parseRecord(record, value.filePath as string));
  if (value.mode === 'metadata' && records.some((record) => record.metadataOnly !== true)) throw new Error('Invalid metadata records');
  return {
    key: value.key,
    filePath: value.filePath,
    mode: value.mode,
    countInDiagnostics: value.countInDiagnostics,
    records,
    parsedRecords: integer(value.parsedRecords),
    skippedRecords: integer(value.skippedRecords),
    skippedMalformedFiles: integer(value.skippedMalformedFiles),
    sizeBytes,
    mtimeMs: nonnegative(value.mtimeMs),
    jsonlOffsetBytes,
    canAppendJsonl: value.canAppendJsonl,
    jsonlPrefixDigest: value.canAppendJsonl ? value.jsonlPrefixDigest as string : undefined,
  };
}

function parseRecord(value: unknown, filePath: string): UsageRecord {
  if (!object(value) || typeof value.chatId !== 'string' || !value.chatId || typeof value.title !== 'string' ||
      typeof value.model !== 'string' || typeof value.filePath !== 'string' || pathKey(value.filePath) !== pathKey(filePath) ||
      !object(value.tokens) || (value.tokens.source !== 'recorded' && value.tokens.source !== 'missing')) throw new Error('Invalid cached record');
  for (const flag of ['metadataOnly', 'hiddenFromExplorer']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error('Invalid record flag');
  }
  const record: UsageRecord = {
    chatId: value.chatId,
    title: value.title,
    timestamp: date(value.timestamp),
    model: value.model,
    filePath: value.filePath,
    tokens: {
      input: nonnegative(value.tokens.input),
      cachedInput: nonnegative(value.tokens.cachedInput),
      output: nonnegative(value.tokens.output),
      cacheWriteInput: nonnegative(value.tokens.cacheWriteInput),
      total: nonnegative(value.tokens.total),
      source: value.tokens.source,
    },
  };
  if (value.metadataOnly !== undefined) record.metadataOnly = value.metadataOnly as boolean;
  if (value.hiddenFromExplorer !== undefined) record.hiddenFromExplorer = value.hiddenFromExplorer as boolean;
  if (value.titlePriority !== undefined) {
    if (typeof value.titlePriority !== 'number' || !Number.isFinite(value.titlePriority)) throw new Error('Invalid title priority');
    record.titlePriority = value.titlePriority;
  }
  if (value.titleTimestamp !== undefined) record.titleTimestamp = date(value.titleTimestamp);
  if (value.titleModifiedAt !== undefined) record.titleModifiedAt = nonnegative(value.titleModifiedAt);
  if (value.billing !== undefined) {
    if (!object(value.billing) || value.billing.source !== 'copilot-debug-log' || nonnegative(value.billing.aiCredits) <= 0) throw new Error('Invalid cached billing');
    record.billing = { aiCredits: value.billing.aiCredits as number, source: value.billing.source };
  }
  if (record.metadataOnly !== true && record.billing === undefined) throw new Error('Missing cached billing');
  if (value.debugRequest !== undefined) {
    if (!object(value.debugRequest) || typeof value.debugRequest.responseId !== 'string' || typeof value.debugRequest.spanId !== 'string') throw new Error('Invalid request evidence');
    record.debugRequest = { responseId: value.debugRequest.responseId, spanId: value.debugRequest.spanId, durationMs: nonnegative(value.debugRequest.durationMs) };
  }
  return record;
}

function authorizedPath(path: string, scope: UsageIndexCacheScope, file = false): boolean {
  if (!isAbsolute(path)) return false;
  const normalized = pathKey(path);
  return scope.roots.some((root) => {
    const child = relative(root, normalized);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return false;
    if (file && !child) return false;
    const depth = (file ? dirname(child) : child).split(sep).filter((part) => part !== '.' && part !== '').length;
    if (depth > scope.maxScanDepth + (file ? 0 : 1)) return false;
    const broadRoot = scope.dataPath !== '' && isSameOrInsidePath(root, scope.dataPath);
    return !file || broadRoot || pathContainsUsageFolder(path);
  });
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid cached number');
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(nonnegative(value))) throw new Error('Invalid cached count');
  return value as number;
}

function date(value: unknown): Date {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid cached date');
  return new Date(value);
}
