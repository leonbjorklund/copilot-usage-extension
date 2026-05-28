import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';

export interface ScanOptions {
  maxFileSizeBytes: number;
  maxDepth: number;
  broadRootPaths?: string[];
  includeFilesOutsideUsageFolders?: boolean;
}

export interface ScanDiagnostics {
  scannedFiles: number;
  skippedFolders: number;
  unsupportedFiles: number;
  oversizedFiles: number;
  unreadableFiles: number;
}

export interface ScanResult {
  files: string[];
  watchFolders: string[];
  diagnostics: ScanDiagnostics;
}

const SUPPORTED_EXTENSIONS = new Set(['.json', '.jsonl']);
const WATCH_FOLDER_NAMES = new Set(['github.copilot-chat', 'debug-logs', 'transcripts', 'chatsessions', 'emptywindowchatsessions']);
const IGNORED_USAGE_CACHE_FILE_NAMES = new Set(['settingembeddings.json', 'commandembeddings.json']);

export async function scanUsageFiles(roots: string[], options: ScanOptions): Promise<ScanResult> {
  const files: string[] = [];
  const watchFolders = new Set<string>();
  const diagnostics = createDiagnostics();
  const broadRoots = new Set(uniqueResolvedPaths(options.broadRootPaths ?? []));
  const includeFilesOutsideUsageFolders = options.includeFilesOutsideUsageFolders ?? true;

  async function scanFolder(folder: string, depth: number, insideUsageFolder: boolean, broadRoot: boolean): Promise<void> {
    if (depth > options.maxDepth) {
      diagnostics.skippedFolders += 1;
      return;
    }

    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      diagnostics.unreadableFiles += 1;
      return;
    }

    for (const entry of entries) {
      const path = join(folder, entry.name);

      if (entry.isDirectory()) {
        const isUsageFolder = WATCH_FOLDER_NAMES.has(entry.name.toLowerCase());
        if (isUsageFolder) {
          watchFolders.add(path);
        }
        await scanFolder(path, depth + 1, insideUsageFolder || isUsageFolder, broadRoot);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!broadRoot && !includeFilesOutsideUsageFolders && !insideUsageFolder) {
        continue;
      }

      if (isIgnoredUsageCacheFile(entry.name)) {
        continue;
      }

      if (!isSupportedUsageFile(entry.name)) {
        diagnostics.unsupportedFiles += 1;
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(path);
      } catch {
        diagnostics.unreadableFiles += 1;
        continue;
      }

      if (fileStat.size > options.maxFileSizeBytes) {
        diagnostics.oversizedFiles += 1;
        continue;
      }

      diagnostics.scannedFiles += 1;
      files.push(path);
    }
  }

  for (const root of uniqueResolvedPaths(roots)) {
    const broadRoot = [...broadRoots].some((broadRootPath) => isSameOrInsidePath(root, broadRootPath));
    await scanFolder(root, 0, pathContainsUsageFolder(root), broadRoot);
  }

  return { files, watchFolders: Array.from(watchFolders), diagnostics };
}

function createDiagnostics(): ScanDiagnostics {
  return {
    scannedFiles: 0,
    skippedFolders: 0,
    unsupportedFiles: 0,
    oversizedFiles: 0,
    unreadableFiles: 0,
  };
}

function isSupportedUsageFile(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export function isIgnoredUsageCacheFile(filePath: string): boolean {
  return IGNORED_USAGE_CACHE_FILE_NAMES.has(basename(filePath).toLowerCase());
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

export function isSameOrInsidePath(path: string, root: string): boolean {
  const resolvedPath = resolve(path).toLowerCase();
  const resolvedRoot = resolve(root).toLowerCase();
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootPrefix);
}

export function pathContainsUsageFolder(path: string): boolean {
  return resolve(path)
    .split(/[\\/]+/)
    .some((segment) => WATCH_FOLDER_NAMES.has(segment.toLowerCase()));
}
