import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readLines } from './quota';

/** This local month's model use from Copilot's debug logs, across every account. */
export interface Tally {
  /** The local month, like `2026-09`. */
  month: string;
  /** When the last scan that changed the tally started, having read every log; older files hold nothing new. */
  readAt: number;
  /** Per model: its credits in billionths, and the chats that spent them. */
  models: Map<string, { nano: number; chats: Set<string> }>;
  /** Per chat: a key for each request counted, so reading the chat again adds nothing. */
  seen: Map<string, Set<string>>;
}

// Large enough for most lines; a longer line doubles the read until it fits.
const CHUNK = 8 * 1024 * 1024;

function monthOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function emptyTally(now: number): Tally {
  return { month: monthOf(now), readAt: 0, models: new Map(), seen: new Map() };
}

/**
 * Counts one debug-log line when it is a request of this month with a cost. A chat is its
 * `debug-logs/<chat>/` folder, whose every file counts. Returns whether the tally changed.
 */
export function addRequest(tally: Tally, chat: string, line: string): boolean {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // A line cut by Copilot's trimming is not a request.
    return false;
  }
  const { type, ts, spanId, attrs } = (entry ?? {}) as { [key: string]: unknown };
  const { model, copilotUsageNanoAiu: nano } = (attrs ?? {}) as { [key: string]: unknown };
  if (type !== 'llm_request' || typeof ts !== 'number' || monthOf(ts) !== tally.month || typeof spanId !== 'string' ||
    typeof model !== 'string' || !model || typeof nano !== 'number' || !(nano > 0 && Number.isFinite(nano))) return false;
  // Every window numbers its spans from 1, so the start time tells requests of one chat apart.
  const key = `${ts.toString(36)}.${spanId.replace(/^0+/, '')}`;
  const seen = tally.seen.get(chat) ?? new Set();
  if (seen.has(key)) return false;
  tally.seen.set(chat, seen.add(key));
  const use = tally.models.get(model) ?? { nano: 0, chats: new Set() };
  use.nano += nano;
  tally.models.set(model, use);
  use.chats.add(chat);
  return true;
}

/**
 * Reads what Copilot's debug logs gained since the last scan into the tally, starting a new tally
 * in a new month. Copilot keeps them per folder under `workspaceStorage`, and under this profile's
 * `globalStorage` for windows without a folder. `read` holds the bytes read of each file. Resolves
 * to whether the tally changed.
 */
export async function scanDebugLogs(
  globalStorage: string, workspaceStorage: string, tally: Tally, read: Map<string, number>, now: number,
): Promise<boolean> {
  let changed = false;
  if (tally.month !== monthOf(now)) {
    Object.assign(tally, emptyTally(now));
    changed = true;
  }
  let complete = true;
  // A missing folder holds nothing; one that cannot be listed leaves the scan incomplete.
  const list = (folder: string) => readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') complete = false;
    return [];
  });
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  // File times can trail the clock by a moment.
  const since = Math.max(tally.readAt, monthStart) - 2000;
  const roots = [join(globalStorage, 'github.copilot-chat', 'debug-logs'),
    ...(await list(workspaceStorage)).map((id) => join(workspaceStorage, id, 'GitHub.copilot-chat', 'debug-logs'))];
  for (const root of roots) {
    for (const chat of await list(root)) {
      for (const name of await list(join(root, chat))) {
        if (!name.endsWith('.jsonl')) continue;
        const file = join(root, chat, name);
        try {
          const { size, mtimeMs } = await stat(file);
          // A file untouched since the last full scan was read then; one that shrank was trimmed.
          let offset = read.get(file) ?? (mtimeMs < since ? size : 0);
          if (size < offset) offset = 0;
          let span = CHUNK;
          while (offset < size) {
            const { text, end } = await readLines(file, offset, Math.min(size, offset + span));
            if (end === offset) {
              // A line longer than the read, or one Copilot is still writing.
              if (offset + span >= size) break;
              span *= 2;
              continue;
            }
            for (const line of text.split('\n')) {
              if (addRequest(tally, chat, line)) changed = true;
            }
            offset = end;
            span = CHUNK;
          }
          read.set(file, offset);
        } catch {
          // The next scan tries again.
          complete = false;
        }
      }
    }
  }
  if (changed && complete) tally.readAt = now;
  return changed;
}

/** The tally as saved: plain objects and arrays. */
export function saveTally(tally: Tally): unknown {
  return {
    month: tally.month,
    readAt: tally.readAt,
    models: Object.fromEntries([...tally.models].map(([model, use]) => [model, { nano: use.nano, chats: [...use.chats] }])),
    seen: Object.fromEntries([...tally.seen].map(([chat, keys]) => [chat, [...keys]])),
  };
}

/** A saved tally of this month, with anything malformed dropped; a new one otherwise. */
export function loadTally(value: unknown, now: number): Tally {
  const tally = emptyTally(now);
  const saved = (value ?? {}) as { [key: string]: unknown };
  if (saved.month !== tally.month) return tally;
  if (typeof saved.readAt === 'number' && Number.isFinite(saved.readAt)) tally.readAt = saved.readAt;
  const entries = (value: unknown) => typeof value === 'object' && value !== null ? Object.entries(value) : [];
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  for (const [model, use] of entries(saved.models)) {
    const { nano, chats } = (use ?? {}) as { [key: string]: unknown };
    if (typeof nano === 'number' && nano > 0 && Number.isFinite(nano)) tally.models.set(model, { nano, chats: new Set(strings(chats)) });
  }
  for (const [chat, keys] of entries(saved.seen)) tally.seen.set(chat, new Set(strings(keys)));
  return tally;
}

/** The top 3 models by credits, with their chats and share of all credits; none before any request. */
export function topModels(tally: Tally): Array<{ model: string; chats: number; share: number }> {
  const total = [...tally.models.values()].reduce((sum, use) => sum + use.nano, 0);
  return [...tally.models]
    .sort((a, b) => b[1].nano - a[1].nano)
    .slice(0, 3)
    .map(([model, use]) => ({ model, chats: use.chats.size, share: use.nano / total * 100 }));
}
