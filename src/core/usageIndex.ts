import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, resolve, sep } from 'node:path';

import { aggregateUsage } from './aggregator';
import { normalizeRawUsage } from './normalizer';
import {
  parseCompleteJsonlLines,
  parseUsageFile,
  type ParseUsageFileResult,
  type ParseUsageMode,
  type RawUsageItem,
} from './parser';
import { isIgnoredUsageCacheFile, isSameOrInsidePath, scanUsageFiles, type ScanDiagnostics } from './scanner';
import type { ExtensionConfig, UsageDiagnostics, UsageRecord, UsageServiceResult } from './types';

export interface UsageIndexOptions {
  roots: string[];
  now?: Date;
  config: ExtensionConfig;
}

export interface UsageIndexUpdateOptions {
  now?: Date;
  config: ExtensionConfig;
}

export interface UsageIndexChangeOptions extends UsageIndexUpdateOptions {
  pathsToDelete: string[];
  pathsToUpdate: string[];
}

interface FileUsageState {
  filePath: string;
  mode: ParseUsageMode;
  records: UsageRecord[];
  parsedRecords: number;
  skippedRecords: number;
  skippedMalformedFiles: number;
  sizeBytes: number;
  mtimeMs: number;
  jsonlOffsetBytes: number;
  canAppendJsonl: boolean;
}

const SUPPORTED_EXTENSIONS = new Set(['.json', '.jsonl']);
const MAX_CONCURRENT_FILE_PARSES = 8;

export class UsageIndex {
  private readonly files = new Map<string, FileUsageState>();
  private roots: string[] = [];
  private watchFolders: string[] = [];
  private scanDiagnostics: ScanDiagnostics = emptyScanDiagnostics();
  private recordsCache: UsageRecord[] | undefined;
  private recordsVersion = 0;
  private summaryCache:
    | { recordsVersion: number; localDateKey: string; result: UsageServiceResult }
    | undefined;

  async rebuild(options: UsageIndexOptions): Promise<UsageServiceResult> {
    this.files.clear();
    this.invalidateCaches();
    this.roots = uniqueResolvedPaths(options.roots);
    const scan = await scanUsageFiles(this.roots, {
      maxFileSizeBytes: options.config.maxFileSizeMb * 1024 * 1024,
      maxDepth: options.config.maxScanDepth,
      broadRootPaths: customDataRoots(options.config),
      includeFilesOutsideUsageFolders: false,
    });
    this.scanDiagnostics = scan.diagnostics;
    this.watchFolders = scan.watchFolders.map((folder) => resolve(folder));

    const billedUsageFiles = scan.files.filter((file) => !isMetadataPath(file));
    await forEachLimited(billedUsageFiles, MAX_CONCURRENT_FILE_PARSES, (file) =>
      this.reparseFile(file, { mode: 'billed-usage', keepEmpty: false }),
    );
    await this.reparseMetadataFiles(scan.files, this.getBilledChatIds());

    return this.summarize(options);
  }

  async applyChanges(options: UsageIndexChangeOptions): Promise<UsageServiceResult> {
    const previousBilledChatIds = this.getBilledChatIds();
    for (const path of options.pathsToDelete) {
      await this.deletePathState(path);
    }

    for (const path of options.pathsToUpdate) {
      await this.updatePathState(path, options.config);
    }

    const nextBilledChatIds = this.getBilledChatIds();
    this.pruneMetadataForBilledChats(nextBilledChatIds);
    if (hasNewChatIds(previousBilledChatIds, nextBilledChatIds)) {
      await this.refreshMetadataForBilledChats(options.config);
    }

    return this.summarize(options);
  }

  summarize(options: UsageIndexUpdateOptions): UsageServiceResult {
    const now = options.now ?? new Date();
    const localDateKey = formatLocalDateKey(now);
    if (
      this.summaryCache?.recordsVersion === this.recordsVersion &&
      this.summaryCache.localDateKey === localDateKey
    ) {
      return this.summaryCache.result;
    }

    const records = this.getRecords();
    const result = {
      summary: aggregateUsage(records, now),
      diagnostics: this.buildDiagnostics(),
    };
    this.summaryCache = {
      recordsVersion: this.recordsVersion,
      localDateKey,
      result,
    };
    return result;
  }

  getWatchFolders(): string[] {
    const folders = new Set<string>([...this.roots, ...this.watchFolders]);
    for (const state of this.files.values()) {
      folders.add(dirname(state.filePath));
    }

    return pruneNestedFolders(Array.from(folders));
  }

  private async updateFileState(filePath: string, config: ExtensionConfig): Promise<void> {
    const resolvedPath = resolve(filePath);
    const stateKey = await fileStateKey(resolvedPath);
    if (isIgnoredUsageCacheFile(resolvedPath) || !isSupportedUsageFile(resolvedPath)) {
      if (this.files.delete(stateKey)) {
        this.invalidateCaches();
      }
      return;
    }

    const maxFileSizeBytes = config.maxFileSizeMb * 1024 * 1024;
    let fileStat;
    try {
      fileStat = await stat(resolvedPath);
    } catch {
      if (this.files.delete(stateKey)) {
        this.invalidateCaches();
      }
      return;
    }

    if (!fileStat.isFile() || fileStat.size > maxFileSizeBytes) {
      if (this.files.delete(stateKey)) {
        this.invalidateCaches();
      }
      return;
    }

    const extension = extname(resolvedPath).toLowerCase();
    const existing = this.files.get(stateKey);
    const billedChatIds = this.getBilledChatIds();
    const metadataChatId = metadataChatIdFromPath(resolvedPath, billedChatIds);
    if (isMetadataPath(resolvedPath) && metadataChatId === undefined) {
      if (this.files.delete(stateKey)) {
        this.invalidateCaches();
      }
      return;
    }

    const mode = metadataChatId ? 'metadata' : 'billed-usage';
    const sameSizeRewrite = existing !== undefined && fileStat.size === existing.sizeBytes && fileStat.mtimeMs !== existing.mtimeMs;
    if (
      extension === '.jsonl' &&
      existing?.canAppendJsonl === true &&
      existing.mode === mode &&
      fileStat.size >= existing.jsonlOffsetBytes &&
      !sameSizeRewrite
    ) {
      await this.appendJsonlFile(resolvedPath, fileStat.size, fileStat.mtimeMs, existing);
    } else {
      await this.reparseFile(resolvedPath, { mode, keepEmpty: mode === 'metadata' });
    }

  }

  private async updatePathState(path: string, config: ExtensionConfig): Promise<void> {
    const resolvedPath = resolve(path);
    let pathStat;
    try {
      pathStat = await stat(resolvedPath);
    } catch {
      await this.deletePathState(resolvedPath);
      return;
    }

    if (pathStat.isDirectory()) {
      await this.updateFolderState(resolvedPath, config);
      return;
    }

    await this.updateFileState(resolvedPath, config);
  }

  private async deletePathState(path: string): Promise<void> {
    const resolvedPath = resolve(path);
    const stateKey = await fileStateKey(resolvedPath);
    let changed = this.files.delete(stateKey);

    const folderPrefix = stateKey.endsWith(sep) ? stateKey : `${stateKey}${sep}`;
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(folderPrefix)) {
        this.files.delete(filePath);
        changed = true;
      }
    }

    if (changed) {
      this.invalidateCaches();
    }
  }

  private async updateFolderState(folder: string, config: ExtensionConfig): Promise<void> {
    const scan = await scanUsageFiles([folder], {
      maxFileSizeBytes: config.maxFileSizeMb * 1024 * 1024,
      maxDepth: config.maxScanDepth,
      broadRootPaths: customDataRoots(config),
      includeFilesOutsideUsageFolders: false,
    });

    this.watchFolders = uniqueResolvedPaths([folder, ...this.watchFolders, ...scan.watchFolders]);
    const billedUsageFiles = scan.files.filter((file) => !isMetadataPath(file));
    await forEachLimited(billedUsageFiles, MAX_CONCURRENT_FILE_PARSES, (file) =>
      this.reparseFile(file, { mode: 'billed-usage', keepEmpty: false }),
    );
    await this.reparseMetadataFiles(scan.files, this.getBilledChatIds());
  }

  private async appendJsonlFile(
    filePath: string,
    sizeBytes: number,
    mtimeMs: number,
    state: FileUsageState,
  ): Promise<void> {
    if (sizeBytes === state.jsonlOffsetBytes) {
      state.sizeBytes = sizeBytes;
      return;
    }

    let content: string;
    try {
      content = await readUtf8Range(filePath, state.jsonlOffsetBytes, sizeBytes - state.jsonlOffsetBytes);
    } catch {
      await this.reparseFile(filePath, { mode: state.mode, keepEmpty: state.mode === 'metadata' });
      return;
    }

    const parsed = parseCompleteJsonlLines(content, filePath);
    if (parsed.consumedBytes === 0) {
      state.sizeBytes = sizeBytes;
      return;
    }

    const normalized = normalizeItems(parsed.items, recordFilterForMode(state.mode));
    state.records.push(...normalized.records);
    state.parsedRecords += parsed.items.length;
    state.skippedRecords += parsed.malformedRecords + normalized.skippedRecords;
    state.jsonlOffsetBytes += parsed.consumedBytes;
    state.sizeBytes = sizeBytes;
    state.mtimeMs = mtimeMs;
    state.canAppendJsonl = true;
    if (parsed.items.length > 0 || parsed.malformedRecords > 0 || normalized.records.length > 0) {
      this.invalidateCaches();
    }
  }

  private async reparseFile(
    filePath: string,
    options: { mode: ParseUsageMode; keepEmpty?: boolean },
  ): Promise<void> {
    const resolvedPath = resolve(filePath);
    const stateKey = await fileStateKey(resolvedPath);
    const mode = options.mode;
    const keepEmpty = options.keepEmpty ?? true;
    try {
      const fileStat = await stat(resolvedPath);
      const parsed = await parseUsageFile(resolvedPath, { mode });
      const canAppendJsonl =
        extname(resolvedPath).toLowerCase() === '.jsonl' && (await sizeBytesEndsAtLineBoundary(resolvedPath, fileStat.size));
      const state = buildState(
        resolvedPath,
        mode,
        fileStat.size,
        fileStat.mtimeMs,
        parsed,
        canAppendJsonl,
      );
      if (keepEmpty || state.records.length > 0 || state.skippedRecords > 0 || state.skippedMalformedFiles > 0) {
        this.files.set(stateKey, state);
      } else {
        this.files.delete(stateKey);
      }
    } catch {
      this.files.set(stateKey, emptyMalformedState(resolvedPath, mode));
    }
    this.invalidateCaches();
  }

  private async reparseMetadataFiles(files: string[], billedChatIds: Set<string>): Promise<void> {
    if (billedChatIds.size === 0) {
      return;
    }

    const metadataFiles = files.filter((file) => metadataChatIdFromPath(file, billedChatIds) !== undefined);
    await forEachLimited(metadataFiles, MAX_CONCURRENT_FILE_PARSES, (file) =>
      this.reparseFile(file, { mode: 'metadata', keepEmpty: false }),
    );
  }

  private async refreshMetadataForBilledChats(config: ExtensionConfig): Promise<void> {
    const billedChatIds = this.getBilledChatIds();
    if (billedChatIds.size === 0) {
      return;
    }

    const scan = await scanUsageFiles(this.roots, {
      maxFileSizeBytes: config.maxFileSizeMb * 1024 * 1024,
      maxDepth: config.maxScanDepth,
      broadRootPaths: customDataRoots(config),
      includeFilesOutsideUsageFolders: false,
    });
    this.watchFolders = uniqueResolvedPaths([...this.watchFolders, ...scan.watchFolders]);
    await this.reparseMetadataFiles(scan.files, billedChatIds);
  }

  private buildDiagnostics(): UsageDiagnostics {
    let parsedRecords = 0;
    let normalizedRecords = 0;
    let skippedMalformedFiles = 0;
    let skippedRecords = 0;

    for (const state of this.files.values()) {
      parsedRecords += state.parsedRecords;
      normalizedRecords += state.records.length;
      skippedMalformedFiles += state.skippedMalformedFiles;
      skippedRecords += state.skippedRecords;
    }

    return {
      roots: this.roots.length,
      files: this.files.size,
      parsedRecords,
      normalizedRecords,
      skippedMalformedFiles,
      skippedRecords,
      ...this.scanDiagnostics,
    };
  }

  private getRecords(): UsageRecord[] {
    if (this.recordsCache === undefined) {
      this.recordsCache = Array.from(this.files.values()).flatMap((state) => state.records);
    }

    return this.recordsCache;
  }

  private invalidateCaches(): void {
    this.recordsVersion += 1;
    this.recordsCache = undefined;
    this.summaryCache = undefined;
  }

  private getBilledChatIds(): Set<string> {
    const chatIds = new Set<string>();
    for (const state of this.files.values()) {
      for (const record of state.records) {
        if (record.metadataOnly !== true && (record.billing?.aiCredits ?? 0) > 0) {
          chatIds.add(record.chatId);
        }
      }
    }
    return chatIds;
  }

  private pruneMetadataForBilledChats(billedChatIds: Set<string>): void {
    let changed = false;
    for (const [stateKey, state] of this.files) {
      if (state.mode !== 'metadata') {
        continue;
      }

      if (metadataChatIdFromPath(state.filePath, billedChatIds) === undefined) {
        this.files.delete(stateKey);
        changed = true;
      }
    }

    if (changed) {
      this.invalidateCaches();
    }
  }
}

function buildState(
  filePath: string,
  mode: ParseUsageMode,
  sizeBytes: number,
  mtimeMs: number,
  parsed: ParseUsageFileResult,
  canAppendJsonl: boolean,
): FileUsageState {
  const normalized = normalizeItems(parsed.items, recordFilterForMode(mode));
  const extension = extname(filePath).toLowerCase();

  return {
    filePath,
    mode,
    records: normalized.records,
    parsedRecords: parsed.items.length,
    skippedRecords: parsed.malformedRecords + normalized.skippedRecords,
    skippedMalformedFiles: 0,
    sizeBytes,
    mtimeMs,
    jsonlOffsetBytes: extension === '.jsonl' ? sizeBytes : 0,
    canAppendJsonl,
  };
}

function normalizeItems(
  items: RawUsageItem[],
  recordFilter: (record: UsageRecord) => boolean = () => true,
): { records: UsageRecord[]; skippedRecords: number } {
  const records: UsageRecord[] = [];
  let skippedRecords = 0;

  for (const item of items) {
    const normalizedRecords = normalizeRawUsage(item).filter(recordFilter);
    skippedRecords += normalizedRecords.length === 0 ? 1 : 0;
    records.push(...normalizedRecords);
  }

  return { records, skippedRecords };
}

function emptyMalformedState(filePath: string, mode: ParseUsageMode): FileUsageState {
  return {
    filePath,
    mode,
    records: [],
    parsedRecords: 0,
    skippedRecords: 0,
    skippedMalformedFiles: 1,
    sizeBytes: 0,
    mtimeMs: 0,
    jsonlOffsetBytes: 0,
    canAppendJsonl: false,
  };
}

async function fileStateKey(filePath: string): Promise<string> {
  const canonicalPath = await realpath(filePath).catch(() => resolve(filePath));
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

function recordFilterForMode(mode: ParseUsageMode): (record: UsageRecord) => boolean {
  if (mode === 'billed-usage') {
    return (record) => record.metadataOnly !== true && (record.billing?.aiCredits ?? 0) > 0;
  }

  if (mode === 'metadata') {
    return (record) => record.metadataOnly === true;
  }

  return () => false;
}

function metadataChatIdFromPath(filePath: string, billedChatIds: Set<string>): string | undefined {
  if (!isMetadataPath(filePath)) {
    return undefined;
  }

  const fileName = basename(filePath);
  const fileStem = fileName.replace(/\.[^.]+$/, '');
  const parentName = basename(dirname(filePath));
  const normalizedParent = parentName.toLowerCase();

  if (fileName.toLowerCase().startsWith('title-')) {
    return billedChatIds.has(parentName) ? parentName : undefined;
  }

  if (
    normalizedParent === 'chatsessions' ||
    normalizedParent === 'emptywindowchatsessions' ||
    normalizedParent === 'transcripts'
  ) {
    return billedChatIds.has(fileStem) ? fileStem : undefined;
  }

  return undefined;
}

function isMetadataPath(filePath: string): boolean {
  const fileName = basename(filePath).toLowerCase();
  const parentName = basename(dirname(filePath)).toLowerCase();
  return (
    fileName.startsWith('title-') ||
    parentName === 'chatsessions' ||
    parentName === 'emptywindowchatsessions' ||
    parentName === 'transcripts'
  );
}

function hasNewChatIds(previous: Set<string>, next: Set<string>): boolean {
  for (const chatId of next) {
    if (!previous.has(chatId)) {
      return true;
    }
  }

  return false;
}

function emptyScanDiagnostics(): ScanDiagnostics {
  return {
    scannedFiles: 0,
    skippedFolders: 0,
    unsupportedFiles: 0,
    oversizedFiles: 0,
    unreadableFiles: 0,
  };
}

function isSupportedUsageFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function pruneNestedFolders(paths: string[]): string[] {
  const resolvedPaths = uniqueResolvedPaths(paths).sort((left, right) => left.length - right.length);
  const kept: string[] = [];

  for (const path of resolvedPaths) {
    if (!kept.some((parent) => isSameOrInsidePath(path, parent))) {
      kept.push(path);
    }
  }

  return kept;
}

function customDataRoots(config: ExtensionConfig): string[] {
  const dataPath = config.dataPath.trim();
  return dataPath.length > 0 ? [dataPath] : [];
}

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

async function forEachLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    }),
  );
}

async function sizeBytesEndsAtLineBoundary(filePath: string, sizeBytes: number): Promise<boolean> {
  if (sizeBytes === 0) {
    return true;
  }

  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1);
    await file.read(buffer, 0, 1, sizeBytes - 1);
    return buffer[0] === 10 || buffer[0] === 13;
  } finally {
    await file.close();
  }
}

async function readUtf8Range(filePath: string, start: number, length: number): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}
