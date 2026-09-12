import { createHash, type Hash } from 'node:crypto';
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
import {
  isIgnoredUsageCacheFile,
  isSameOrInsidePath,
  isSupportedUsageFile,
  scanUsageFiles,
  uniqueResolvedPaths,
  type ScanDiagnostics,
} from './scanner';
import type { ExtensionConfig, UsageDiagnostics, UsageRecord, UsageServiceResult } from './types';

export interface UsageIndexOptions {
  roots: string[];
  now?: Date;
  config: ExtensionConfig;
  /** Saved billed chats whose title sources may outlive their debug logs. */
  retainedChatIds?: string[];
}

export interface UsageIndexUpdateOptions {
  now?: Date;
  config: ExtensionConfig;
  /** Omit to keep the last supplied set; pass an empty array to clear it. */
  retainedChatIds?: string[];
}

export interface UsageIndexChangeOptions extends UsageIndexUpdateOptions {
  pathsToDelete: string[];
  pathsToUpdate: string[];
}

interface FileUsageState {
  filePath: string;
  mode: ParseUsageMode;
  countInDiagnostics: boolean;
  records: UsageRecord[];
  parsedRecords: number;
  skippedRecords: number;
  skippedMalformedFiles: number;
  sizeBytes: number;
  mtimeMs: number;
  jsonlOffsetBytes: number;
  canAppendJsonl: boolean;
  jsonlPrefixHash?: Hash;
}

const MAX_CONCURRENT_FILE_PARSES = 8;

export class UsageIndex {
  private readonly files = new Map<string, FileUsageState>();
  private roots: string[] = [];
  private retainedChatIds = new Set<string>();
  private watchFolders: string[] = [];
  private scanDiagnostics: ScanDiagnostics = emptyScanDiagnostics();
  private recordsCache: UsageRecord[] | undefined;
  private summaryCache:
    | { localDateKey: string; result: UsageServiceResult }
    | undefined;

  async rebuild(options: UsageIndexOptions): Promise<UsageServiceResult> {
    this.files.clear();
    this.invalidateCaches();
    this.roots = uniqueResolvedPaths(options.roots);
    this.retainedChatIds = new Set(options.retainedChatIds ?? []);
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
    if (options.retainedChatIds !== undefined) this.retainedChatIds = new Set(options.retainedChatIds);
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

  /** Reconcile disk state when writers delay filesystem notifications. */
  async poll(options: UsageIndexUpdateOptions): Promise<UsageServiceResult> {
    if (options.retainedChatIds !== undefined) this.retainedChatIds = new Set(options.retainedChatIds);
    const scan = await scanUsageFiles(this.roots, {
      maxFileSizeBytes: options.config.maxFileSizeMb * 1024 * 1024,
      maxDepth: options.config.maxScanDepth,
      broadRootPaths: customDataRoots(options.config),
      includeFilesOutsideUsageFolders: false,
    });
    this.scanDiagnostics = scan.diagnostics;
    this.watchFolders = scan.watchFolders;
    const scannedFiles = new Map<string, string>();
    await forEachLimited(scan.files, MAX_CONCURRENT_FILE_PARSES, async (file) => {
      scannedFiles.set(await fileStateKey(file), file);
    });
    for (const key of this.files.keys()) {
      if (!scannedFiles.has(key)) {
        this.files.delete(key);
        this.invalidateCaches();
      }
    }
    const files = [...scannedFiles.values()];
    await forEachLimited(files.filter((file) => !isMetadataPath(file)), MAX_CONCURRENT_FILE_PARSES,
      (file) => this.updateFileState(file, options.config));
    const billedChatIds = this.getBilledChatIds();
    await forEachLimited(files.filter(isMetadataPath), MAX_CONCURRENT_FILE_PARSES,
      (file) => this.updateFileState(file, options.config, billedChatIds));
    this.pruneMetadataForBilledChats(billedChatIds);
    this.summaryCache = undefined;
    return this.summarize(options);
  }

  private summarize(options: UsageIndexUpdateOptions): UsageServiceResult {
    const now = options.now ?? new Date();
    const localDateKey = formatLocalDateKey(now);
    if (this.summaryCache?.localDateKey === localDateKey) {
      return this.summaryCache.result;
    }

    const records = this.getRecords();
    const result = {
      summary: aggregateUsage(records, now),
      diagnostics: this.buildDiagnostics(),
      titleMetadata: records.filter((record) => record.metadataOnly === true),
    };
    this.summaryCache = {
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

  private async updateFileState(filePath: string, config: ExtensionConfig, billedChatIds?: Set<string>): Promise<void> {
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
    const metadataChatId = isMetadataPath(resolvedPath)
      ? metadataChatIdFromPath(resolvedPath, billedChatIds ?? this.getBilledChatIds()) : undefined;
    if (isMetadataPath(resolvedPath) && metadataChatId === undefined) {
      if (this.files.delete(stateKey)) {
        this.invalidateCaches();
      }
      return;
    }

    const mode = metadataChatId ? 'metadata' : 'billed-usage';
    if (
      (extension === '.json' || existing?.canAppendJsonl === true) &&
      existing?.mode === mode &&
      existing.skippedMalformedFiles === 0 &&
      fileStat.size === existing.sizeBytes &&
      fileStat.mtimeMs === existing.mtimeMs
    ) {
      return;
    }
    const sameSizeRewrite = existing !== undefined && fileStat.size === existing.sizeBytes && fileStat.mtimeMs !== existing.mtimeMs;
    if (
      extension === '.jsonl' &&
      existing?.canAppendJsonl === true &&
      existing.mode === mode &&
      fileStat.size >= existing.jsonlOffsetBytes &&
      !sameSizeRewrite &&
      // A rewrite can preserve the old line boundary. Verify all previously
      // parsed bytes before treating growth as an append.
      existing.jsonlPrefixHash !== undefined &&
      (await hashFilePrefix(resolvedPath, existing.jsonlOffsetBytes))?.copy().digest('hex') ===
        existing.jsonlPrefixHash.copy().digest('hex')
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

    let content: Buffer;
    try {
      content = await readFileRange(filePath, state.jsonlOffsetBytes, sizeBytes - state.jsonlOffsetBytes);
    } catch {
      await this.reparseFile(filePath, { mode: state.mode, keepEmpty: state.mode === 'metadata' });
      return;
    }
    // An early EOF can race with a rewrite. Keep the snapshot retryable even
    // when the next stat reports the originally requested size and revision.
    sizeBytes = state.jsonlOffsetBytes + content.length;

    const parsed = parseCompleteJsonlLines(content.toString('utf8'), filePath);
    if (parsed.consumedBytes === 0) {
      state.sizeBytes = sizeBytes;
      state.mtimeMs = mtimeMs;
      return;
    }

    const normalized = normalizeItems(parsed.items, state.mode, mtimeMs);
    state.records.push(...normalized.records);
    state.parsedRecords += parsed.items.length;
    state.skippedRecords += parsed.malformedRecords + normalized.skippedRecords;
    state.jsonlOffsetBytes += parsed.consumedBytes;
    state.jsonlPrefixHash?.update(content.subarray(0, parsed.consumedBytes));
    state.sizeBytes = sizeBytes;
    state.mtimeMs = mtimeMs;
    if (parsed.items.length > 0 || parsed.malformedRecords > 0) {
      this.invalidateCaches();
    }
  }

  private async reparseFile(
    filePath: string,
    options: { mode: ParseUsageMode; keepEmpty: boolean },
  ): Promise<void> {
    const resolvedPath = resolve(filePath);
    const stateKey = await fileStateKey(resolvedPath);
    const mode = options.mode;
    const keepEmpty = options.keepEmpty;
    try {
      const fileStat = await stat(resolvedPath);
      const parsed = await parseUsageFile(resolvedPath, { mode });
      // Resume from what the read actually consumed. `fileStat.size` is sampled
      // before the read, so Copilot appending mid-read would leave those bytes
      // both parsed and ahead of the offset, and the next append would count
      // them a second time.
      let canAppendJsonl =
        extname(resolvedPath).toLowerCase() === '.jsonl' &&
        (await endsAtLineBoundary(resolvedPath, parsed.consumedBytes));
      const jsonlPrefixHash = canAppendJsonl ? await hashFilePrefix(resolvedPath, parsed.consumedBytes) : undefined;
      if (canAppendJsonl) {
        const after = await stat(resolvedPath);
        // Do not associate parsed records with a digest from a different
        // revision if a writer changed the file during the initial read.
        canAppendJsonl = jsonlPrefixHash !== undefined && after.size === fileStat.size && after.mtimeMs === fileStat.mtimeMs;
      }
      const state = buildState(
        resolvedPath,
        mode,
        fileStat.size,
        fileStat.mtimeMs,
        parsed,
        canAppendJsonl,
      );
      state.jsonlPrefixHash = canAppendJsonl ? jsonlPrefixHash : undefined;
      state.countInDiagnostics = keepEmpty || state.records.length > 0 || state.skippedRecords > 0 || state.skippedMalformedFiles > 0;
      // Cache successful marker-free JSON reads too, without adding them to usage diagnostics.
      if (state.countInDiagnostics || extname(resolvedPath).toLowerCase() === '.json') {
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
    let files = 0;
    let parsedRecords = 0;
    let normalizedRecords = 0;
    let skippedMalformedFiles = 0;
    let skippedRecords = 0;

    for (const state of this.files.values()) {
      if (!state.countInDiagnostics) {
        continue;
      }
      files += 1;
      parsedRecords += state.parsedRecords;
      normalizedRecords += state.records.length;
      skippedMalformedFiles += state.skippedMalformedFiles;
      skippedRecords += state.skippedRecords;
    }

    return {
      roots: this.roots.length,
      files,
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
    this.recordsCache = undefined;
    this.summaryCache = undefined;
  }

  private getBilledChatIds(): Set<string> {
    const chatIds = new Set(this.retainedChatIds);
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
  const normalized = normalizeItems(parsed.items, mode, mtimeMs);

  return {
    filePath,
    mode,
    countInDiagnostics: true,
    records: normalized.records,
    parsedRecords: parsed.items.length,
    skippedRecords: parsed.malformedRecords + normalized.skippedRecords,
    skippedMalformedFiles: 0,
    sizeBytes,
    mtimeMs,
    jsonlOffsetBytes: canAppendJsonl ? parsed.consumedBytes : 0,
    canAppendJsonl,
  };
}

function normalizeItems(
  items: RawUsageItem[],
  mode: ParseUsageMode,
  mtimeMs: number,
): { records: UsageRecord[]; skippedRecords: number } {
  const records: UsageRecord[] = [];
  let skippedRecords = 0;

  for (const item of items) {
    // Keep prompts from billed logs as title candidates, but never bill title files.
    const normalizedRecords = normalizeRawUsage(item).filter((record) =>
      record.metadataOnly === true || (mode === 'billed-usage' && (record.billing?.aiCredits ?? 0) > 0),
    );
    for (const record of normalizedRecords) {
      if (record.metadataOnly === true) {
        record.titleModifiedAt = mtimeMs;
      }
    }
    skippedRecords += normalizedRecords.length === 0 ? 1 : 0;
    records.push(...normalizedRecords);
  }

  return { records, skippedRecords };
}

function emptyMalformedState(filePath: string, mode: ParseUsageMode): FileUsageState {
  return {
    filePath,
    mode,
    countInDiagnostics: true,
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

/** True when byte `sizeBytes - 1` of the file as it stands now is a line ending. */
async function endsAtLineBoundary(filePath: string, sizeBytes: number): Promise<boolean> {
  if (sizeBytes === 0) {
    return true;
  }

  let file;
  try {
    file = await open(filePath, 'r');
  } catch {
    return false;
  }

  try {
    const buffer = Buffer.alloc(1);
    const { bytesRead } = await file.read(buffer, 0, 1, sizeBytes - 1);
    return bytesRead === 1 && (buffer[0] === 10 || buffer[0] === 13);
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

async function readFileRange(filePath: string, start: number, length: number): Promise<Buffer> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(buffer, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await file.close();
  }
}

/** Hash with bounded scratch space; unchanged polls never read the prefix. */
async function hashFilePrefix(filePath: string, length: number): Promise<Hash | undefined> {
  let file;
  try {
    file = await open(filePath, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(length, 64 * 1024));
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (bytesRead === 0) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}
