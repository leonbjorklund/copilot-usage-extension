import { createHash, randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, open, readdir, readFile, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { aggregateUsage } from '../core/aggregator';
import { TITLE_PRIORITY } from '../core/types';
import type { UsageRecord, UsageSummary } from '../core/types';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MATCH_TOLERANCE_MS = 2_000;
const SETTLE_MS = 2_000;
const SUMMARY_TOLERANCE_MS = 25;

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
  const request = record.debugRequest;
  if (!request) return { pending: 'Request correlation fields are missing.' };
  const start = record.timestamp.getTime();
  const end = start + request.durationMs;
  if (now < end + SETTLE_MS) return { pending: 'Waiting for complete request logs.' };
  const completions = evidence.filter((entry): entry is Completion => entry.kind === 'completion' &&
    entry.responseId === request.responseId && Math.abs(entry.at - end) <= MATCH_TOLERANCE_MS);
  let streams = [...new Set(completions.map((entry) => pathIdentity(entry.stream)))];
  if (!streams.length) {
    // Some transports omit request-done. Their successful ccreq summary still
    // reports the measured request interval and model. Require a unique match
    // in both directions, never merely the nearest request or current account.
    const summaries = [...new Map(evidence.filter((entry): entry is RequestSummary =>
      entry.kind === 'request-summary' && matchesSummary(record, entry)).map((entry) => [entryKey(entry), entry])).values()];
    if (summaries.length > 1) return { pending: 'Request matches more than one successful request summary.' };
    if (summaries.length === 1) {
      const matchingBills = new Set(peers.filter((peer) => matchesSummary(peer, summaries[0])).map((peer) => billKey(peer, true)));
      if (matchingBills.size !== 1) return { pending: 'Successful request summary matches more than one billed request.' };
      streams = [pathIdentity(summaries[0].stream)];
    }
  }
  if (streams.length !== 1) return { pending: streams.length === 0
    ? 'No matching window request log is available.'
    : 'Request matches more than one window.' };
  const events = evidence.filter((entry): entry is AuthEvent => isAuth(entry) && pathIdentity(entry.stream) === streams[0])
    .sort((a, b) => a.at - b.at || authOrder(a) - authOrder(b));
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
  if (!request || !summary.model.split(' -> ').includes(record.model)) return false;
  const start = record.timestamp.getTime();
  return Math.abs(summary.at - (start + request.durationMs)) <= SUMMARY_TOLERANCE_MS &&
    Math.abs(summary.at - summary.durationMs - start) <= SUMMARY_TOLERANCE_MS &&
    Math.abs(summary.durationMs - request.durationMs) <= SUMMARY_TOLERANCE_MS;
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
 * Local-only ledger. Each extension process writes its own append-only
 * journal, so simultaneous windows cannot overwrite each other's observations.
 * Readers deduplicate events and requests; account decisions are recomputed so
 * delayed/conflicting evidence cannot permanently stamp a guessed account.
 */
export class AccountUsagePoc {
  private readonly entries = new Map<string, Entry>();
  private readonly offsets = new Map<string, { size: number; modified: number }>();
  private readonly sessionStarts = new Map<string, number | undefined>();
  private readonly writer: string;
  private incompleteWrite = false;
  private startedAt = 0;
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: string, private readonly currentStream: string, private readonly logRoots: string[]) {
    this.writer = join(storage, `observer-${randomUUID()}.jsonl`);
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
    // Only this observer writes this journal. Another observer may have already
    // displayed complete lines from a failed append, so preserve them and remove
    // only the unfinished tail before reading or retrying it.
    if (this.incompleteWrite) {
      try {
        const written = await readFile(this.writer);
        await truncate(this.writer, written.lastIndexOf(10) + 1);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.incompleteWrite = false;
    }
    await this.readJournals();
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
      // Persist before displaying the result. A failed write must not become a
      // successful-looking total that disappears on restart.
      try {
        const text = additions.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
        this.incompleteWrite = true;
        await appendFile(this.writer, text, 'utf8');
        this.incompleteWrite = false;
      } catch (error) {
        for (const entry of additions) {
          const key = entryKey(entry);
          const previous = replaced.get(key);
          if (previous) this.entries.set(key, previous);
          else this.entries.delete(key);
        }
        this.offsets.clear();
        throw error;
      }
    }
    const evidence = [...this.entries.values()].filter((entry): entry is Evidence => entry.kind !== 'bill');
    const bills = [...this.entries.values()].filter((entry): entry is Bill => entry.kind === 'bill');
    const peers = bills.map((entry) => entry.record);
    const currentAuth = evidence.filter((entry): entry is AuthEvent => isAuth(entry) && pathIdentity(entry.stream) === pathIdentity(this.currentStream))
      .sort((a, b) => a.at - b.at || authOrder(a) - authOrder(b));
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
      const decision = attributeRequest(entry.record, entry.sessionStart, evidence, now.getTime(), peers);
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
      entry = { ...previous, sessionStart, ...(newerTitle ? {
        record: { ...previous.record, title: entry.record.title, titlePriority: entry.record.titlePriority },
        titleTimestamp: entry.titleTimestamp,
        titleModifiedAt: entry.titleModifiedAt,
      } : {}) };
    }
    if (replaced && !replaced.has(key)) replaced.set(key, previous);
    this.entries.set(key, entry);
    additions?.push(entry);
  }

  private async readJournals(): Promise<void> {
    const files = (await readdir(this.storage)).filter((file) => /^observer-[\da-f-]+\.jsonl$/.test(file));
    if (files.length > 256) throw new Error('Account POC has too many observer journals. Tracking data was left untouched.');
    for (const name of files) {
      const file = join(this.storage, name);
      const text = await this.readChanged(file);
      if (text === undefined) continue;
      try {
        for (const line of text.split('\n').filter(Boolean)) {
          const entry = JSON.parse(line) as Entry;
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
          this.add(entry);
        }
      } catch (error) {
        // Invalid journals must fail on every retry, never become cached success.
        this.offsets.delete(file);
        throw error;
      }
    }
  }

  private async readChanged(file: string): Promise<string | undefined> {
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
      if (complete === info.size) {
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
      const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
      const row = JSON.parse(firstLine);
      const start = row.type === 'session_start' && Number.isFinite(row.ts) ? row.ts as number : undefined;
      if (start !== undefined) this.sessionStarts.set(main, start);
      return start;
    } catch { return undefined; }
    finally { await handle?.close(); }
  }
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
