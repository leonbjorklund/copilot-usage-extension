import { createHash, randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { aggregateUsage } from '../core/aggregator';
import { TITLE_PRIORITY } from '../core/types';
import type { UsageRecord, UsageSummary } from '../core/types';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MATCH_TOLERANCE_MS = 2_000;
const SETTLE_MS = 2_000;
const SUMMARY_TOLERANCE_MS = 25;
const MAX_JOURNALS = 256;
// Below Node's 512 KiB appendFile chunk, so each group is one write call.
const MAX_APPEND_BYTES = 256 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

type AuthEvent = { kind: 'login' | 'token' | 'unknown'; stream: string; at: number; account?: string };
type Completion = { kind: 'completion'; stream: string; at: number; responseId: string };
type RequestSummary = { kind: 'request-summary'; stream: string; at: number; id: string; model: string; durationMs: number };
type Evidence = AuthEvent | Completion | RequestSummary;
type Bill = { kind: 'bill'; key: string; record: UsageRecord; sessionStart?: number; titleTimestamp?: number; titleModifiedAt?: number };
type Entry = Evidence | Bill;
export type Attribution = { account: string } | { excluded: string } | { pending: string };

export interface AccountPocView {
  summary: UsageSummary;
  account?: string;
  startedAt: Date;
  excluded: number;
  pending: number;
  problem?: string;
  diagnostics: string;
}

/** Only account/request markers are retained; no credentials or prompt bodies are saved. */
export function parseAccountEvidence(text: string, stream: string): Evidence[] {
  stream = pathIdentity(stream);
  const entries: Evidence[] = [];
  for (const line of text.split('\n')) {
    const at = new Date(line.slice(0, 23)).getTime();
    if (!Number.isFinite(at)) continue;
    const auth = /\] (Logged in as |Got Copilot token for )(\S+)/.exec(line);
    // Enterprise managed logins include an underscore before the organization suffix.
    if (auth && /^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(auth[2]) && auth[2] !== 'devDeviceId') {
      entries.push({ kind: auth[1].startsWith('Logged') ? 'login' : 'token', stream, at, account: auth[2].toLowerCase() });
    } else if (/GitHub login failed|AuthenticationService: firing onDidAuthenticationChange .*Has token: false/.test(line)) {
      entries.push({ kind: 'unknown', stream, at });
    }
    const request = /request done: requestId: \[([^\]]+)\]/.exec(line);
    if (request) entries.push({ kind: 'completion', stream, at, responseId: request[1] });
    const summary = /ccreq:([^\s|]+) \| success \| ([^|]+) \| (\d+)ms \| \[/.exec(line);
    if (summary) entries.push({ kind: 'request-summary', stream, at, id: summary[1], model: summary[2].trim(), durationMs: Number(summary[3]) });
  }
  return entries;
}

function authAt(events: AuthEvent[], at: number): string | undefined {
  let account: string | undefined;
  for (const event of events) {
    if (event.at > at) break;
    if (event.kind === 'token') account = event.account;
    else if (event.kind === 'unknown' || event.account !== account) account = undefined;
  }
  return account;
}

/** Account selection never substitutes for missing request evidence. */
export function attributeRequest(
  record: UsageRecord, sessionStart: number | undefined,
  evidence: Evidence[], now: number, peers: UsageRecord[] = [record],
): Attribution {
  return attributeIndexedRequest(record, sessionStart, indexEvidence(evidence), now, peers);
}

interface EvidenceIndex {
  auth: Map<string, AuthEvent[]>;
  completions: Map<string, Completion[]>;
  summaries: Map<string, RequestSummary[]>;
}

/** Rebuilt for each refresh so delayed or conflicting evidence is never cached away. */
function indexEvidence(evidence: Evidence[]): EvidenceIndex {
  const index: EvidenceIndex = { auth: new Map(), completions: new Map(), summaries: new Map() };
  for (const original of evidence) {
    const entry = { ...original, stream: pathIdentity(original.stream) };
    if (entry.kind === 'completion') {
      const group = index.completions.get(entry.responseId) ?? [];
      group.push(entry);
      index.completions.set(entry.responseId, group);
    } else if (entry.kind === 'request-summary') {
      for (const model of new Set(entry.model.split(' -> '))) {
        const group = index.summaries.get(model) ?? [];
        group.push(entry);
        index.summaries.set(model, group);
      }
    } else {
      const group = index.auth.get(entry.stream) ?? [];
      group.push(entry);
      index.auth.set(entry.stream, group);
    }
  }
  for (const events of index.auth.values()) events.sort((a, b) => a.at - b.at || authOrder(a) - authOrder(b));
  return index;
}

function attributeIndexedRequest(
  record: UsageRecord, sessionStart: number | undefined,
  evidence: EvidenceIndex, now: number, peers: UsageRecord[],
): Attribution {
  const request = record.debugRequest;
  if (!request) return { pending: 'Request correlation fields are missing.' };
  const start = record.timestamp.getTime();
  const end = start + request.durationMs;
  if (now < end + SETTLE_MS) return { pending: 'Waiting for complete request logs.' };
  const completions = (evidence.completions.get(request.responseId) ?? [])
    .filter((entry) => Math.abs(entry.at - end) <= MATCH_TOLERANCE_MS);
  let streams = [...new Set(completions.map((entry) => entry.stream))];
  if (!streams.length) {
    // Some transports omit request-done. Their successful ccreq summary still
    // reports the measured request interval and model. Require a unique match
    // in both directions, never merely the nearest request or current account.
    const summaries = [...new Map((evidence.summaries.get(record.model) ?? [])
      .filter((entry) => matchesSummary(record, entry)).map((entry) => [entryKey(entry), entry])).values()];
    if (summaries.length > 1) return { pending: 'Request matches more than one successful request summary.' };
    if (summaries.length === 1) {
      const matchingBills = new Set(peers.filter((peer) => matchesSummary(peer, summaries[0])).map((peer) => billKey(peer, true)));
      if (matchingBills.size !== 1) return { pending: 'Successful request summary matches more than one billed request.' };
      streams = [summaries[0].stream];
    }
  }
  if (streams.length !== 1) return { pending: streams.length === 0
    ? 'No matching window request log is available.'
    : 'Request matches more than one window.' };
  const events = evidence.auth.get(streams[0]) ?? [];
  const account = authAt(events, start);
  if (!account) return events.some((event) => event.kind === 'token' && event.at < start)
    ? { excluded: 'Authentication changed before dispatch completed.' }
    : { pending: 'No successful account evidence is available before this request.' };
  if (events.some((event) => event.at >= start - MATCH_TOLERANCE_MS && event.at <= end + MATCH_TOLERANCE_MS &&
    (event.kind === 'unknown' || event.account !== account))) {
    return { excluded: 'Account changed during or immediately around the request.' };
  }
  // Conservatively reject an older chat after a switch, including a switch back.
  // Copilot may keep a socket authenticated with an earlier account in that chat.
  let previous: string | undefined;
  let lastSwitch = -Infinity;
  for (const event of events) {
    if (event.at > start) break;
    if (previous && (event.kind === 'unknown' || event.account !== previous)) lastSwitch = event.at;
    if (event.account) previous = event.account;
  }
  if (lastSwitch !== -Infinity && (sessionStart === undefined || sessionStart <= lastSwitch + MATCH_TOLERANCE_MS)) {
    return { excluded: 'Account ownership is uncertain for a chat continued after a switch.' };
  }
  return { account };
}

function isAuth(entry: Evidence): entry is AuthEvent {
  return entry.kind === 'login' || entry.kind === 'token' || entry.kind === 'unknown';
}

function matchesSummary(record: UsageRecord, summary: RequestSummary): boolean {
  const request = record.debugRequest;
  if (!request) return false;
  const start = record.timestamp.getTime();
  return Math.abs(summary.at - (start + request.durationMs)) <= SUMMARY_TOLERANCE_MS &&
    Math.abs(summary.at - summary.durationMs - start) <= SUMMARY_TOLERANCE_MS &&
    Math.abs(summary.durationMs - request.durationMs) <= SUMMARY_TOLERANCE_MS &&
    summary.model.split(' -> ').includes(record.model);
}

function pathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function authOrder(event: AuthEvent): number {
  // Same-millisecond account changes are conservatively unknown.
  return event.kind === 'token' ? 0 : event.kind === 'login' ? 1 : 2;
}

/**
 * Local-only ledger. Every extension process appends whole lines to one shared
 * journal, so the folder never grows with reloads and nothing is ever
 * rewritten. Older per-process observer journals are still read, never written.
 * Readers deduplicate events and requests; account decisions are recomputed so
 * delayed/conflicting evidence cannot permanently stamp a guessed account.
 */
export class AccountUsagePoc {
  private readonly entries = new Map<string, Entry>();
  private readonly offsets = new Map<string, { size: number; modified: number }>();
  private readonly sessionStarts = new Map<string, number | undefined>();
  private readonly ledger: string;
  /** Byte offset of the last complete ledger line already loaded. */
  private loaded = 0;
  private tornLines = 0;
  private startedAt = 0;
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: string, private readonly currentStream: string, private readonly logRoots: string[]) {
    this.ledger = join(storage, 'ledger.jsonl');
  }

  getRetainedChatIds(): string[] {
    return [...new Set([...this.entries.values()].filter((entry): entry is Bill => entry.kind === 'bill')
      .map((entry) => entry.record.chatId))];
  }

  refresh(summary: UsageSummary, now = new Date(), titleMetadata: UsageRecord[] = []): Promise<AccountPocView> {
    const work = this.queue.then(() => this.refreshOnce(summary, now, titleMetadata));
    this.queue = work.catch(() => undefined);
    return work;
  }

  private async refreshOnce(summary: UsageSummary, now: Date, titleMetadata: UsageRecord[]): Promise<AccountPocView> {
    await this.initialize(now.getTime());
    await this.readJournals();
    await this.readLedger();
    const additions: Entry[] = [];
    const replaced = new Map<string, Entry | undefined>();
    const readProblems: string[] = [];
    const logFiles = await this.discoverLogs(readProblems);
    for (const file of logFiles) {
      try {
        const text = await this.readChanged(file);
        if (text === undefined) continue;
        for (const entry of parseAccountEvidence(text, resolve(dirname(file)))) {
          if (isAuth(entry) || entry.at >= this.startedAt) this.add(entry, additions, replaced);
        }
      } catch {
        readProblems.push(`Cannot read Copilot log: ${file}`);
      }
    }
    // A request may arrive while its session header is still missing. Retry
    // retained requests too, and append the recovered header without replacing
    // any journal contents or guessing that an older chat belongs to this login.
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'bill' || entry.sessionStart !== undefined) continue;
      const sessionStart = await this.readSessionStart(entry.record.filePath);
      if (sessionStart === undefined) continue;
      this.add({ ...entry, sessionStart }, additions, replaced);
    }
    // Title metadata can outlive billed debug logs. Resolve it against saved
    // requests without adding those requests to the scanner's usage totals.
    const retainedTitles = titleMetadata.length ? aggregateUsage([
      ...[...this.entries.values()].filter((entry): entry is Bill => entry.kind === 'bill').map((entry) =>
        entry.titleTimestamp === undefined ? entry.record : { ...entry.record,
          titleTimestamp: new Date(entry.titleTimestamp), titleModifiedAt: entry.titleModifiedAt }),
      ...titleMetadata.filter((record) => record.metadataOnly === true),
    ], now).chats : [];
    for (const chat of [...summary.chats, ...retainedTitles]) {
      for (const record of chat.records) {
        if (record.timestamp.getTime() < this.startedAt || record.metadataOnly || record.hiddenFromExplorer || !(record.billing?.aiCredits)) continue;
        const key = billKey(record);
        const previous = this.entries.get(billKey(record, true));
        const sessionStart = previous?.kind === 'bill' ? previous.sessionStart : await this.readSessionStart(record.filePath);
        const savedRecord = { ...record, title: chat.title, titlePriority: chat.titlePriority ?? record.titlePriority };
        // The journal stores title time on the bill, never as part of request data.
        delete savedRecord.titleTimestamp;
        delete savedRecord.titleModifiedAt;
        this.add({ kind: 'bill', key, record: savedRecord, sessionStart,
          titleTimestamp: chat.titleTimestamp?.getTime(), titleModifiedAt: chat.titleModifiedAt }, additions, replaced);
      }
    }
    if (additions.length) {
      // Another window may have saved the same entries while this refresh ran.
      // Drop what it wrote identically or superseded, so a request is normally
      // stored once per machine.
      const fresh = await this.readLedger();
      const pending = additions.filter((entry) => {
        const key = entryKey(entry);
        return this.entries.get(key) === entry && fresh.get(key) !== JSON.stringify(entry);
      });
      // Persist before displaying the result. A failed write must not become a
      // successful-looking total that disappears on restart.
      try {
        await appendLines(this.ledger, pending.map((entry) => JSON.stringify(entry)));
      } catch (error) {
        // Lines that did reach the ledger are reloaded on the next refresh; the
        // rest must be parsed from the logs again, so forget the logs' offsets.
        for (const entry of pending) {
          const key = entryKey(entry);
          const previous = replaced.get(key);
          if (previous) this.entries.set(key, previous);
          else this.entries.delete(key);
        }
        for (const file of logFiles) this.offsets.delete(file);
        throw error;
      }
    }
    const evidence = [...this.entries.values()].filter((entry): entry is Evidence => entry.kind !== 'bill');
    const bills = [...this.entries.values()].filter((entry): entry is Bill => entry.kind === 'bill');
    const peers = bills.map((entry) => entry.record);
    const attributionIndex = indexEvidence(evidence);
    const currentAuth = attributionIndex.auth.get(pathIdentity(this.currentStream)) ?? [];
    const account = authAt(currentAuth, now.getTime());
    // Historical usage stays in the ordinary display without entering the
    // account ledger. Only newer requests are filtered by account.
    const records: UsageRecord[] = summary.chats.flatMap((chat) => chat.records
      .filter((record) => record.timestamp.getTime() < this.startedAt)
      .map((record) => ({ ...record, title: chat.title, titlePriority: chat.titlePriority ?? record.titlePriority,
        titleTimestamp: chat.titleTimestamp, titleModifiedAt: chat.titleModifiedAt })));
    let attributed = 0;
    let excluded = 0;
    let pending = 0;
    const reasons = new Map<string, number>();
    for (const entry of bills) {
      const decision = attributeIndexedRequest(entry.record, entry.sessionStart, attributionIndex, now.getTime(), peers);
      if (!account || ('account' in decision && decision.account === account)) {
        records.push(entry.titleTimestamp === undefined ? entry.record :
          { ...entry.record, titleTimestamp: new Date(entry.titleTimestamp), titleModifiedAt: entry.titleModifiedAt });
      }
      if ('account' in decision) {
        if (decision.account === account) attributed++;
      } else {
        const reason = 'excluded' in decision ? decision.excluded : decision.pending;
        if ('excluded' in decision) excluded++; else pending++;
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    // Retained usage can outlive the window logs needed to identify its owner.
    // Such requests are diagnostic gaps, not active work the user can wait for.
    // Keep retrying their evidence without replacing or decorating known usage.
    const problem = readProblems[0];
    const diagnostics = [
      `Account POC: ${account ?? 'unknown'}`,
      `Tracking began: ${new Date(this.startedAt).toLocaleString()}`,
      `Attributed requests for this account: ${attributed}`,
      ...(!account ? ['Current account unavailable; showing combined local usage.'] : []),
      `Excluded switch requests: ${excluded}; unresolved requests: ${pending}`,
      ...[...reasons].map(([reason, count]) => `${count}: ${reason}`),
      ...readProblems,
      ...(this.tornLines ? [`Skipped unreadable ledger lines: ${this.tornLines}`] : []),
      `Local ledger: ${this.storage}`,
    ].join('\n');
    return { summary: aggregateUsage(records, now), account, startedAt: new Date(this.startedAt), excluded, pending, problem, diagnostics };
  }

  private async initialize(now: number): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.storage, { recursive: true });
    const path = join(this.storage, 'start.json');
    const candidate = join(this.storage, `start-${randomUUID()}.tmp`);
    try {
      await writeFile(candidate, JSON.stringify({ version: 1, startedAt: now }), { flag: 'wx' });
      // Publish complete contents without replacing another observer's start.
      try { await link(candidate, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally {
      await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.version !== 1 || !Number.isFinite(data.startedAt) || data.startedAt <= 0) {
      throw new Error('Account POC start file is invalid. Existing tracking data was left untouched.');
    }
    this.startedAt = data.startedAt;
    this.initialized = true;
  }

  private add(entry: Entry, additions?: Entry[], replaced?: Map<string, Entry | undefined>): void {
    const key = entryKey(entry);
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.kind !== 'bill' || entry.kind !== 'bill') return;
      const priority = entry.record.titlePriority ?? TITLE_PRIORITY.record;
      const previousPriority = previous.record.titlePriority ?? TITLE_PRIORITY.record;
      const laterTitle = priority === TITLE_PRIORITY.custom && entry.titleModifiedAt !== undefined &&
        previous.titleModifiedAt !== undefined && entry.titleModifiedAt !== previous.titleModifiedAt
        ? entry.titleModifiedAt > previous.titleModifiedAt
        : entry.titleTimestamp! > previous.titleTimestamp! ||
          (entry.titleTimestamp === previous.titleTimestamp && (entry.titleModifiedAt ?? 0) > (previous.titleModifiedAt ?? 0));
      // Older journals saved resolved labels with request-level priority. Keep
      // descriptive labels until their source is rediscovered or a custom title
      // replaces them, since their original priority cannot be recovered.
      const legacyFallback = previous.titleTimestamp === undefined && previous.record.title !== previous.record.chatId &&
        priority < TITLE_PRIORITY.custom && entry.record.title !== previous.record.title;
      const newerTitle = !legacyFallback && entry.titleTimestamp !== undefined && (previous.titleTimestamp === undefined ||
        priority > previousPriority || (priority === previousPriority && (priority === TITLE_PRIORITY.prompt
          ? entry.titleTimestamp < previous.titleTimestamp : laterTitle)));
      const sessionStart = previous.sessionStart ?? entry.sessionStart;
      if (!newerTitle && sessionStart === previous.sessionStart) return;
      // Copilot rewrites the chat file on every message, so title times move
      // while the label stays. Carry them in memory only; a ledger line is
      // worth writing for a changed label, priority, or session start.
      const sameLabel = sessionStart === previous.sessionStart && entry.record.title === previous.record.title &&
        priority === previousPriority;
      entry = { ...previous, sessionStart, ...(newerTitle ? {
        record: { ...previous.record, title: entry.record.title, titlePriority: entry.record.titlePriority },
        titleTimestamp: entry.titleTimestamp,
        titleModifiedAt: entry.titleModifiedAt,
      } : {}) };
      if (sameLabel) {
        this.entries.set(key, entry);
        return;
      }
    }
    if (replaced && !replaced.has(key)) replaced.set(key, previous);
    this.entries.set(key, entry);
    additions?.push(entry);
  }

  private async readJournals(): Promise<void> {
    const files = (await readdir(this.storage)).filter((file) => /^observer-[\da-f-]+\.jsonl$/.test(file));
    if (files.length > MAX_JOURNALS) throw new Error('Account POC has too many observer journals. Tracking data was left untouched.');
    for (const name of files) {
      const file = join(this.storage, name);
      // Nothing writes these files any more, so a torn tail is final, not in progress.
      const text = await this.readChanged(file, true);
      if (text === undefined) continue;
      try {
        for (const line of text.split('\n').filter(Boolean)) this.add(validateEntry(JSON.parse(line)));
      } catch (error) {
        // Invalid journals must fail on every retry, never become cached success.
        this.offsets.delete(file);
        throw error;
      }
    }
  }

  /**
   * Resumes after the last complete line. A line that is not JSON is a torn
   * write from a window that failed mid-append; it is skipped and counted, never
   * repaired. A parsed entry that fails validation still fails every refresh.
   * Returns the lines loaded by this call, by entry key.
   */
  private async readLedger(): Promise<Map<string, string>> {
    const fresh = new Map<string, string>();
    let handle;
    try {
      handle = await open(this.ledger, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fresh;
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      if (size < this.loaded) {
        this.loaded = 0;
        this.tornLines = 0;
      }
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      let pending = Buffer.alloc(0);
      let position = this.loaded;
      while (position < size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        const complete = pending.lastIndexOf(10) + 1;
        if (complete === 0) {
          // A line this long cannot be an entry. Drop its bytes; whatever
          // remains before its newline is counted when it fails to parse.
          if (pending.length > MAX_LINE_BYTES) {
            this.loaded = position;
            pending = Buffer.alloc(0);
          }
          continue;
        }
        for (const line of pending.toString('utf8', 0, complete).split('\n')) {
          if (!line) continue;
          let parsed;
          try { parsed = JSON.parse(line); }
          catch { this.tornLines++; continue; }
          const entry = validateEntry(parsed);
          fresh.set(entryKey(entry), line);
          this.add(entry);
        }
        this.loaded += complete;
        pending = Buffer.from(pending.subarray(complete));
      }
    } finally {
      await handle.close();
    }
    return fresh;
  }

  private async readChanged(file: string, settled = false): Promise<string | undefined> {
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      const previous = this.offsets.get(file);
      if (previous?.size === info.size && previous.modified === info.mtimeMs) return undefined;
      if (info.size > MAX_FILE_BYTES) throw new Error(`Account POC file exceeds its read limit: ${file}`);
      const buffer = Buffer.alloc(info.size);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      // Read only the checked descriptor size, even if its contents grow.
      // Event keys deduplicate replay and tolerate delayed writes.
      const complete = buffer.subarray(0, read).lastIndexOf(10) + 1;
      if (complete === info.size || (settled && read === info.size)) {
        this.offsets.set(file, { size: info.size, modified: info.mtimeMs });
      } else {
        // A complete last line does not prove the read reached the stat's size.
        // Retry snapshots taken while the writer was replacing or growing logs.
        this.offsets.delete(file);
      }
      return buffer.toString('utf8', 0, complete);
    } finally {
      await handle.close();
    }
  }

  private async discoverLogs(problems: string[]): Promise<string[]> {
    const folders = new Set([pathIdentity(this.currentStream)]);
    for (const root of new Set(this.logRoots.map(pathIdentity))) {
      let sessions;
      try { sessions = await readdir(root, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Cannot list Copilot log root: ${root}`);
        continue;
      }
      for (const session of sessions.filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))) {
        const sessionRoot = join(root, session.name);
        try {
          const windows = await readdir(sessionRoot, { withFileTypes: true });
          for (const window of windows.filter((entry) => entry.isDirectory() && /^window\d+$/.test(entry.name))) {
            const windowRoot = join(sessionRoot, window.name);
            const hosts = await readdir(windowRoot, { withFileTypes: true });
            for (const host of hosts.filter((entry) => entry.isDirectory() && /^exthost\d*$/.test(entry.name))) {
              folders.add(pathIdentity(join(windowRoot, host.name, 'GitHub.copilot-chat')));
              if (folders.size > 512) throw new Error('Account POC found too many window log folders.');
            }
          }
        } catch (error) {
          if (folders.size > 512) throw error;
          problems.push(`Cannot list window logs: ${sessionRoot}`);
        }
      }
    }
    const files: string[] = [];
    for (const folder of folders) {
      try {
        for (const file of await readdir(folder)) {
          if (/^GitHub Copilot Chat(?:\.\d+)?\.log$/.test(file)) files.push(join(folder, file));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Cannot read window log folder: ${folder}`);
      }
    }
    return files;
  }

  private async readSessionStart(file: string): Promise<number | undefined> {
    const main = join(dirname(file), 'main.jsonl');
    if (this.sessionStarts.has(main)) return this.sessionStarts.get(main);
    let handle;
    try {
      handle = await open(main, 'r');
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      // Copilot can write hooks before session_start. Other event timestamps
      // do not prove when the chat began, especially after an account switch.
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.type === 'session_start' && Number.isFinite(row.ts)) {
          this.sessionStarts.set(main, row.ts);
          return row.ts as number;
        }
      }
      return undefined;
    } catch { return undefined; }
    finally { await handle?.close(); }
  }
}

function validateEntry(entry: Entry): Entry {
  if (typeof entry !== 'object' || entry === null) throw new Error('Invalid account POC evidence journal. Tracking data was left untouched.');
  if (entry.kind === 'bill') {
    entry.record.timestamp = new Date(entry.record.timestamp);
    if (!Number.isFinite(entry.record.timestamp.getTime()) || entry.key !== billKey(entry.record) ||
      typeof entry.record.billing?.aiCredits !== 'number' || !Number.isFinite(entry.record.billing.aiCredits) || entry.record.billing.aiCredits <= 0) {
      throw new Error('Invalid account POC request journal. Tracking data was left untouched.');
    }
    if ((entry.titleTimestamp !== undefined && (!Number.isFinite(entry.titleTimestamp) || !Number.isFinite(entry.record.titlePriority))) ||
      (entry.titleModifiedAt !== undefined && !Number.isFinite(entry.titleModifiedAt))) {
      throw new Error('Invalid account POC title journal. Tracking data was left untouched.');
    }
  } else if (!['login', 'token', 'unknown', 'completion', 'request-summary'].includes(entry.kind) || !Number.isFinite(entry.at) || typeof entry.stream !== 'string') {
    throw new Error('Invalid account POC evidence journal. Tracking data was left untouched.');
  }
  return entry;
}

/**
 * Appends whole lines in groups small enough for one write call each, so
 * concurrent windows never interleave inside a line. Every group starts with a
 * newline: a fragment left by a write that failed part-way ends there instead
 * of swallowing the next entry, and blank lines are ignored on read.
 */
async function appendLines(file: string, lines: string[]): Promise<void> {
  let group = '';
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes && bytes + size > MAX_APPEND_BYTES) {
      await appendFile(file, `\n${group}`, 'utf8');
      group = '';
      bytes = 0;
    }
    group += `${line}\n`;
    bytes += size;
  }
  if (bytes) await appendFile(file, `\n${group}`, 'utf8');
}

function billKey(record: UsageRecord, canonical = false): string {
  return createHash('sha256').update(JSON.stringify([
    canonical ? pathIdentity(record.filePath) : resolve(record.filePath), record.timestamp.getTime(), record.debugRequest?.spanId,
    record.debugRequest?.responseId, record.debugRequest?.durationMs, record.model,
  ])).digest('hex');
}

function entryKey(entry: Entry): string {
  // Keep validating the original saved key, but collapse path aliases in memory.
  return entry.kind === 'bill' ? billKey(entry.record, true) : JSON.stringify({ ...entry, stream: pathIdentity(entry.stream) });
}
