import { createHash, randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { aggregateUsage, collectModelUsage, mergeCostEstimates, mergeUsageTotals, rankModelUsage } from '../core/aggregator';
import type { ModelUsage } from '../core/aggregator';
import { TITLE_PRIORITY } from '../core/types';
import type { ChatUsageSummary, CopilotCostEstimate, UsageRecord, UsageSummary } from '../core/types';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MATCH_TOLERANCE_MS = 2_000;
const SETTLE_MS = 2_000;
const SUMMARY_TOLERANCE_MS = 25;
const MAX_JOURNALS = 256;
// Below Node's 512 KiB appendFile chunk, so each group is one write call.
const MAX_APPEND_BYTES = 256 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/**
 * Requests older than this are frozen: their account decision is final and
 * they are kept as per-day rollups instead of bills with request evidence.
 * Unresolved decisions also become permanent; evidence discovered after
 * freezing no longer changes attribution.
 */
const FREEZE_MS = 7 * 86_400_000;
/** Version 1 snapshots already compacted requests after three days. */
const LEGACY_FREEZE_MS = 3 * 86_400_000;
/** A rolled ledger waits this long for in-flight appends before it is frozen. */
const ROLL_SETTLE_MS = 10 * 60_000;
/** A snapshot temp file older than this belongs to a window that died mid-write. */
const STALE_TEMP_MS = 60 * 60_000;
const LIVE_LEDGER = 'ledger.jsonl';
const LEGACY_JOURNAL = /^observer-[\da-f-]+\.jsonl$/;
const ROLLED_LEDGER = /^ledger-(\d+)-[\da-f-]+\.jsonl$/;
const SNAPSHOT = /^snapshot-(\d+)-[\da-f-]+\.jsonl$/;
const SNAPSHOT_TEMP = /^snapshot-(\d+)-[\da-f-]+\.tmp$/;
const SNAPSHOT_WRITER = '00000000-0000-0000-0000-000000000000';

type AuthEvent = { kind: 'login' | 'token' | 'unknown'; stream: string; at: number; account?: string };
type Completion = { kind: 'completion'; stream: string; at: number; responseId: string };
type RequestSummary = { kind: 'request-summary'; stream: string; at: number; id: string; model: string; durationMs: number };
type Evidence = AuthEvent | Completion | RequestSummary;
type Bill = { kind: 'bill'; key: string; record: UsageRecord; sessionStart?: number; titleTimestamp?: number; titleModifiedAt?: number };
/** Frozen requests of one chat, model, local day, and decision. */
type Rollup = { kind: 'rollup'; key: string; record: UsageRecord; day: string; requests: number; decision: Attribution;
  frozenAt: number; titleTimestamp?: number; titleModifiedAt?: number };
type Saved = Bill | Rollup;
type Entry = Evidence | Saved;
type Absorbed = { name: string; bytes: number };
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
    if (auth && /^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(auth[2]) && auth[2].toLowerCase() !== 'devdeviceid') {
      entries.push({ kind: auth[1].startsWith('Logged') ? 'login' : 'token', stream, at, account: auth[2].toLowerCase() });
    } else if (auth || /GitHub login failed|AuthenticationService: firing onDidAuthenticationChange .*Has token: false|onDidCopilotTokenChange .*token lost|onDidCopilotTokenChange .*resetCopilotToken|Auth state changed \(identity change\)/.test(line)) {
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
  const index = new EvidenceIndex();
  for (const entry of evidence) index.add({ ...entry, stream: pathIdentity(entry.stream) });
  const billed = new PeerIndex();
  for (const peer of peers) billed.add(billKey(peer, true), peer);
  return attributeIndexedRequest(record, sessionStart, index, now, billed);
}

/**
 * Evidence grouped for attribution. Entries are only ever added, so the index
 * grows with the journal and is rebuilt only when the journal is reloaded;
 * nothing is cached away, delayed or conflicting evidence still lands here.
 */
class EvidenceIndex {
  private readonly auth = new Map<string, { events: AuthEvent[]; sorted: boolean }>();
  private readonly completions = new Map<string, Completion[]>();
  private readonly summaries = new Map<string, RequestSummary[]>();

  add(entry: Evidence): void {
    if (entry.kind === 'completion') {
      push(this.completions, entry.responseId, entry);
    } else if (entry.kind === 'request-summary') {
      for (const model of new Set(entry.model.split(' -> '))) push(this.summaries, timeBucket(model, entry.at), entry);
    } else {
      const group = this.auth.get(entry.stream);
      if (group) {
        group.events.push(entry);
        group.sorted = false;
      } else {
        this.auth.set(entry.stream, { events: [entry], sorted: true });
      }
    }
  }

  authFor(stream: string): AuthEvent[] {
    const group = this.auth.get(stream);
    if (!group) return [];
    if (!group.sorted) {
      group.events.sort((a, b) => a.at - b.at || authOrder(a) - authOrder(b));
      group.sorted = true;
    }
    return group.events;
  }

  completionsFor(responseId: string): Completion[] {
    return this.completions.get(responseId) ?? [];
  }

  /** Successful summaries for the model whose end lies within tolerance of `end`. */
  summariesNear(model: string, end: number): RequestSummary[] {
    return bucketsAround(end).flatMap((bucket) => this.summaries.get(`${model}\n${bucket}`) ?? []);
  }
}

/** Billed requests by model and end time, for checking that a summary matches one request only. */
class PeerIndex {
  private readonly bills = new Map<string, Map<string, UsageRecord>>();

  add(key: string, record: UsageRecord): void {
    const request = record.debugRequest;
    if (!request) return;
    const bucket = timeBucket(record.model, record.timestamp.getTime() + request.durationMs);
    const group = this.bills.get(bucket) ?? new Map<string, UsageRecord>();
    group.set(key, record);
    this.bills.set(bucket, group);
  }

  matching(summary: RequestSummary): Set<string> {
    const keys = new Set<string>();
    for (const model of new Set(summary.model.split(' -> '))) {
      for (const bucket of bucketsAround(summary.at)) {
        for (const [key, record] of this.bills.get(`${model}\n${bucket}`) ?? []) {
          if (matchesSummary(record, summary)) keys.add(key);
        }
      }
    }
    return keys;
  }
}

function push<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

function timeBucket(model: string, at: number): string {
  return `${model}\n${Math.floor(at / 1000)}`;
}

function bucketsAround(at: number): number[] {
  const first = Math.floor((at - SUMMARY_TOLERANCE_MS) / 1000);
  const last = Math.floor((at + SUMMARY_TOLERANCE_MS) / 1000);
  return first === last ? [first] : [first, last];
}

function attributeIndexedRequest(
  record: UsageRecord, sessionStart: number | undefined,
  evidence: EvidenceIndex, now: number, peers: PeerIndex,
): Attribution {
  const request = record.debugRequest;
  if (!request) return { pending: 'Request correlation fields are missing.' };
  const start = record.timestamp.getTime();
  const end = start + request.durationMs;
  if (now < end + SETTLE_MS) return { pending: 'Waiting for complete request logs.' };
  const completions = evidence.completionsFor(request.responseId)
    .filter((entry) => Math.abs(entry.at - end) <= MATCH_TOLERANCE_MS);
  let streams = [...new Set(completions.map((entry) => entry.stream))];
  if (!streams.length) {
    // Some transports omit request-done. Their successful ccreq summary still
    // reports the measured request interval and model. Require a unique match
    // in both directions, never merely the nearest request or current account.
    const summaries = [...new Map(evidence.summariesNear(record.model, end)
      .filter((entry) => matchesSummary(record, entry)).map((entry) => [entryKey(entry), entry])).values()];
    if (summaries.length > 1) return { pending: 'Request matches more than one successful request summary.' };
    if (summaries.length === 1) {
      if (peers.matching(summaries[0]).size !== 1) return { pending: 'Successful request summary matches more than one billed request.' };
      streams = [summaries[0].stream];
    }
  }
  if (streams.length !== 1) return { pending: streams.length === 0
    ? 'No matching window request log is available.'
    : 'Request matches more than one window.' };
  const events = evidence.authFor(streams[0]);
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
    // A lost or reset token followed by the same account is a renewal, not a switch.
    if (previous && event.account && event.account !== previous) lastSwitch = event.at;
    if (event.account) previous = event.account;
  }
  if (lastSwitch !== -Infinity && (sessionStart === undefined || sessionStart <= lastSwitch + MATCH_TOLERANCE_MS)) {
    return { excluded: 'Account ownership is uncertain for a chat continued after a switch.' };
  }
  return { account };
}

function isAuth(entry: Entry): entry is AuthEvent {
  return entry.kind === 'login' || entry.kind === 'token' || entry.kind === 'unknown';
}

function isSaved(entry: Entry): entry is Saved {
  return entry.kind === 'bill' || entry.kind === 'rollup';
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

function visibleTo(decision: Attribution, account: string | undefined): boolean {
  return !account || ('account' in decision && decision.account === account);
}

/** A saved entry's record with its retained title time, as the aggregator expects it. */
function titledRecord(entry: Saved): UsageRecord {
  return entry.titleTimestamp === undefined ? entry.record :
    { ...entry.record, titleTimestamp: new Date(entry.titleTimestamp), titleModifiedAt: entry.titleModifiedAt };
}

interface FileState {
  /** Byte offset of the last complete line already loaded. */
  loaded: number;
  torn: number;
  ino: number;
  /** Earliest freezable request or evidence time loaded from this file. */
  oldest: number;
  lines: number;
  expectedLines?: number;
  /** Keys with a line in this file, while the file can still be frozen. */
  keys?: Set<string>;
}

type FileMode = 'snapshot' | 'legacy' | 'settled' | 'growing' | 'live';

interface StorageView {
  /** Files read to their end that the next snapshot may absorb. */
  absorbable: Absorbed[];
  /** False when a listed file vanished mid-read; a freeze then waits for the next refresh. */
  stable: boolean;
  problems: string[];
}

interface FrozenAggregate {
  revision: number;
  account: string | undefined;
  day: string;
  summary: UsageSummary;
  byChat: Map<string, UsageRecord[]>;
  models: Map<string, ModelUsage>;
}

/**
 * Local-only ledger. Every extension process appends whole lines to one shared
 * live ledger; readers deduplicate events and requests and recompute account
 * decisions, so delayed or conflicting evidence cannot permanently stamp a
 * guessed account. Once the live ledger holds requests older than FREEZE_MS,
 * a window renames it aside, waits for in-flight appends to settle, and writes
 * a snapshot: old requests become per-day rollups with their final decision,
 * their request evidence is dropped, auth history and younger lines are copied.
 * Shared files change only by rename or by adding a whole file, and every
 * window discards files the newest snapshot lists as absorbed. Older
 * per-process observer journals are read until the first snapshot absorbs them.
 */
export class AccountUsagePoc {
  private readonly entries = new Map<string, Entry>();
  /** Saved entry keys by chat, for retained titles and the scanner's retained set. */
  private readonly chats = new Map<string, Set<string>>();
  private chatIds: string[] | undefined;
  private readonly frozenRecords = new WeakSet<UsageRecord>();
  private index = new EvidenceIndex();
  private peers = new PeerIndex();
  private readonly files = new Map<string, FileState>();
  private snapshot: string | undefined;
  private snapshotAt = -Infinity;
  private absorbed = new Map<string, number>();
  private readonly frozenKeys = new Set<string>();
  // Snapshots written before request IDs were retained cannot identify older replays.
  private legacyBefore = -Infinity;
  private frozen: FrozenAggregate | undefined;
  private revision = 0;
  private readonly offsets = new Map<string, { size: number; modified: number }>();
  private readonly sessionStarts = new Map<string, number | undefined>();
  private readonly ledger: string;
  private cutoff = -Infinity;
  private startedAt = 0;
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: string, private readonly currentStream: string, private readonly logRoots: string[]) {
    this.ledger = join(storage, LIVE_LEDGER);
  }

  getRetainedChatIds(): string[] {
    return this.chatIds ??= [...this.chats.keys()];
  }

  refresh(summary: UsageSummary, now = new Date(), titleMetadata: UsageRecord[] = []): Promise<AccountPocView> {
    const work = this.queue.then(() => this.refreshOnce(summary, now, titleMetadata));
    this.queue = work.catch(() => undefined);
    return work;
  }

  private async refreshOnce(summary: UsageSummary, now: Date, titleMetadata: UsageRecord[]): Promise<AccountPocView> {
    await this.initialize(now.getTime());
    this.cutoff = now.getTime() - FREEZE_MS;
    const storage = await this.readStorage(now.getTime());
    const additions: Entry[] = [];
    const replaced = new Map<string, Entry | undefined>();
    const readProblems = [...storage.problems];
    const logFiles = await this.discoverLogs(readProblems);
    for (const file of logFiles) {
      try {
        const text = await this.readChanged(file);
        if (text === undefined) continue;
        for (const entry of parseAccountEvidence(text, resolve(dirname(file)))) {
          // Request evidence older than the freeze window can no longer resolve anything.
          if (isAuth(entry) || (entry.at >= this.startedAt && entry.at >= this.cutoff)) this.add(entry, additions, replaced);
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
    const metadata = titleMetadata.filter((record) => record.metadataOnly === true);
    const retainedTitles = metadata.length ? aggregateUsage([
      ...this.savedRecords(new Set(metadata.map((record) => record.chatId))), ...metadata,
    ], now).chats : [];
    for (const chat of [...summary.chats, ...retainedTitles]) {
      for (const record of chat.records) {
        if (this.frozenRecords.has(record) || record.timestamp.getTime() < this.startedAt || record.metadataOnly ||
          record.hiddenFromExplorer || !(record.billing?.aiCredits)) continue;
        const previous = this.entries.get(billKey(record, true));
        // A request this old may already be inside a rollup; only known bills keep updating.
        if (!previous && record.timestamp.getTime() < Math.max(this.cutoff, this.legacyBefore)) continue;
        const key = billKey(record);
        const sessionStart = previous?.kind === 'bill' ? previous.sessionStart : await this.readSessionStart(record.filePath);
        const savedRecord = { ...record, title: chat.title, titlePriority: chat.titlePriority ?? record.titlePriority };
        // The journal stores title time on the bill, never as part of request data.
        delete savedRecord.titleTimestamp;
        delete savedRecord.titleModifiedAt;
        this.add({ kind: 'bill', key, record: savedRecord, sessionStart,
          titleTimestamp: chat.titleTimestamp?.getTime(), titleModifiedAt: chat.titleModifiedAt }, additions, replaced);
      }
      // Frozen chats keep following renames; the rollup line is rewritten like a bill.
      for (const key of this.chats.get(chat.chatId) ?? []) {
        const entry = this.entries.get(key);
        if (entry?.kind !== 'rollup') continue;
        this.add({ ...entry, record: { ...entry.record, title: chat.title, titlePriority: chat.titlePriority ?? entry.record.titlePriority },
          titleTimestamp: chat.titleTimestamp?.getTime(), titleModifiedAt: chat.titleModifiedAt }, additions, replaced);
      }
    }
    if (additions.length) {
      // Another window may have saved the same entries while this refresh ran.
      // Drop what it wrote identically or superseded, so a request is normally
      // stored once per machine.
      const fresh = await this.readJournal(LIVE_LEDGER, 'live') ?? new Map<string, string>();
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
        // Incremental indexes must forget the same unsaved entries as the ledger.
        const retained = [...this.entries.values()];
        this.resetEntries();
        for (const entry of retained) this.add(entry);
        for (const file of logFiles) this.offsets.delete(file);
        throw error;
      }
    }
    const account = authAt(this.index.authFor(pathIdentity(this.currentStream)), now.getTime());
    // Historical usage stays in the ordinary display without entering the
    // account ledger. Only newer requests are filtered by account.
    const records: UsageRecord[] = summary.chats.flatMap((chat) => chat.records
      .filter((record) => record.timestamp.getTime() < this.startedAt)
      .map((record) => ({ ...record, title: chat.title, titlePriority: chat.titlePriority ?? record.titlePriority,
        titleTimestamp: chat.titleTimestamp, titleModifiedAt: chat.titleModifiedAt })));
    let attributed = 0;
    let excluded = 0;
    let pending = 0;
    let freezable = 0;
    const reasons = new Map<string, number>();
    const decisions = new Map<string, Attribution>();
    const count = (decision: Attribution, requests: number) => {
      if ('account' in decision) {
        if (decision.account === account) attributed += requests;
      } else {
        const reason = 'excluded' in decision ? decision.excluded : decision.pending;
        if ('excluded' in decision) excluded += requests; else pending += requests;
        reasons.set(reason, (reasons.get(reason) ?? 0) + requests);
      }
    };
    for (const [key, entry] of this.entries) {
      if (entry.kind === 'bill') {
        const decision = attributeIndexedRequest(entry.record, entry.sessionStart, this.index, now.getTime(), this.peers);
        decisions.set(key, decision);
        if (visibleTo(decision, account)) records.push(titledRecord(entry));
        count(decision, 1);
        if (entry.record.timestamp.getTime() < this.cutoff && !this.blocked(key)) freezable++;
      } else if (entry.kind === 'rollup') {
        count(entry.decision, entry.requests);
      }
    }
    const young = aggregateUsage(records, now);
    const frozen = this.frozenAggregate(account, now);
    const merged = frozen ? mergeUsage(frozen, young, records, now) : young;
    if (storage.stable) {
      const live = this.files.get(LIVE_LEDGER);
      if (live && live.oldest < this.cutoff) await this.roll(now.getTime(), readProblems);
      // Batch bills aging out of an existing snapshot instead of rewriting it
      // for each request that crosses the cutoff between polls.
      if (storage.absorbable.length || (freezable && now.getTime() - this.snapshotAt >= ROLL_SETTLE_MS)) {
        await this.freeze(now.getTime(), decisions, storage.absorbable);
      }
    }
    // Retained usage can outlive the window logs needed to identify its owner.
    // Such requests are diagnostic gaps, not active work the user can wait for.
    // Keep retrying their evidence without replacing or decorating known usage.
    const problem = readProblems[0];
    const torn = [...this.files.values()].reduce((total, file) => total + file.torn, 0);
    const diagnostics = [
      `Account POC: ${account ?? 'unknown'}`,
      `Tracking began: ${new Date(this.startedAt).toLocaleString()}`,
      `Attributed requests for this account: ${attributed}`,
      ...(!account ? ['Current account unavailable; showing combined local usage.'] : []),
      `Excluded switch requests: ${excluded}; unresolved requests: ${pending}`,
      ...[...reasons].map(([reason, count]) => `${count}: ${reason}`),
      ...readProblems,
      ...(torn ? [`Skipped unreadable ledger lines: ${torn}`] : []),
      `Local ledger: ${this.storage}`,
    ].join('\n');
    return { summary: merged, account, startedAt: new Date(this.startedAt), excluded, pending, problem, diagnostics };
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

  private savedRecords(chatIds: Set<string>): UsageRecord[] {
    const records: UsageRecord[] = [];
    for (const chatId of chatIds) {
      for (const key of this.chats.get(chatId) ?? []) {
        const entry = this.entries.get(key);
        if (entry && isSaved(entry)) records.push(titledRecord(entry));
      }
    }
    return records;
  }

  private add(entry: Entry, additions?: Entry[], replaced?: Map<string, Entry | undefined>): void {
    const key = entryKey(entry);
    if (entry.kind === 'bill' && this.frozenKeys.has(key)) return;
    const previous = this.entries.get(key);
    if (previous) {
      if (!isSaved(previous) || !isSaved(entry) || previous.kind !== entry.kind) return;
      const merged = mergeSaved(previous, entry);
      if (!merged) return;
      if (merged.entry.kind === 'rollup') {
        this.frozenRecords.add(merged.entry.record);
        this.revision++;
      }
      if (merged.sameLabel) {
        this.entries.set(key, merged.entry);
        return;
      }
      entry = merged.entry;
    } else if (isSaved(entry)) {
      const chat = this.chats.get(entry.record.chatId);
      if (chat) chat.add(key);
      else {
        this.chats.set(entry.record.chatId, new Set([key]));
        this.chatIds = undefined;
      }
      if (entry.kind === 'bill') this.peers.add(key, entry.record);
      else {
        this.frozenRecords.add(entry.record);
        this.revision++;
      }
    } else {
      this.index.add(entry);
    }
    // A request older than the freeze window is never appended as a bill: its
    // lines are already on disk or it is being rolled up, and a new line would
    // count it twice. Its title still updates in memory.
    const persist = additions !== undefined && !(entry.kind === 'bill' && entry.record.timestamp.getTime() < this.cutoff);
    if (persist && replaced && !replaced.has(key)) replaced.set(key, previous);
    this.entries.set(key, entry);
    if (persist) additions!.push(entry);
  }

  /** Whether a saved line still lives in a file the next snapshot cannot absorb. */
  private blocked(key: string): boolean {
    for (const state of this.files.values()) if (state.keys?.has(key)) return true;
    return false;
  }

  private resetEntries(): void {
    this.entries.clear();
    this.chats.clear();
    this.chatIds = undefined;
    this.index = new EvidenceIndex();
    this.peers = new PeerIndex();
    this.frozen = undefined;
    this.revision++;
  }

  private reset(): void {
    this.resetEntries();
    this.files.clear();
    this.absorbed = new Map();
    this.snapshotAt = -Infinity;
    this.frozenKeys.clear();
    this.legacyBefore = -Infinity;
  }

  /**
   * Loads the newest snapshot, then every file it does not list as absorbed:
   * legacy journals, rolled ledgers, and the live ledger. A newer snapshot
   * replaces everything loaded before, so the state is rebuilt from disk.
   */
  private async readStorage(now: number): Promise<StorageView> {
    const problems: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const names = await readdir(this.storage);
      const legacy = names.filter((name) => LEGACY_JOURNAL.test(name));
      if (legacy.length > MAX_JOURNALS) throw new Error('Account POC has too many observer journals. Tracking data was left untouched.');
      const snapshots = names.filter((name) => SNAPSHOT.test(name)).sort(compareSnapshots).reverse();
      const newest = snapshots[0];
      if (newest !== this.snapshot) {
        this.reset();
        this.snapshot = newest;
      }
      if (newest && !await this.readJournal(newest, 'snapshot')) {
        if (attempt < 2) continue;
        throw new Error('Account POC snapshot changed while it was being read.');
      }
      for (const name of names) {
        const bytes = this.absorbed.get(name);
        if (bytes !== undefined) await this.retire(name, bytes, problems);
        else if ((SNAPSHOT.test(name) && name !== newest) || (SNAPSHOT_TEMP.test(name) && now - Number(SNAPSHOT_TEMP.exec(name)![1]) > STALE_TEMP_MS)) {
          await unlink(join(this.storage, name)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') problems.push(`Cannot remove superseded account snapshot: ${name}`);
          });
        }
      }
      let stable = true;
      const absorbable: Absorbed[] = [];
      for (const name of legacy) {
        if (this.absorbed.has(name)) continue;
        if (await this.readJournal(name, 'legacy')) absorbable.push({ name, bytes: this.files.get(name)!.loaded });
        else stable = false;
      }
      const rolled = names.filter((name) => ROLLED_LEDGER.test(name) && !this.absorbed.has(name))
        .sort((a, b) => rolledAt(a) - rolledAt(b));
      // A rolled ledger this window has not seen means another window replaced
      // the live ledger; reread the new one from its start whatever its file id.
      if (rolled.some((name) => !this.files.has(name))) this.files.delete(LIVE_LEDGER);
      for (const name of rolled) {
        const settled = now - rolledAt(name) >= ROLL_SETTLE_MS;
        if (!await this.readJournal(name, settled ? 'settled' : 'growing')) stable = false;
        else if (settled) absorbable.push({ name, bytes: this.files.get(name)!.loaded });
      }
      await this.readJournal(LIVE_LEDGER, 'live');
      return { absorbable, stable, problems };
    }
  }

  /**
   * Resumes after the last complete line. A line that is not JSON is a torn
   * write from a window that failed mid-append; it is skipped and counted, never
   * repaired. A parsed entry that fails validation still fails every refresh.
   * Returns the lines loaded by this call, by entry key, or undefined when the
   * file no longer exists.
   */
  private async readJournal(name: string, mode: FileMode): Promise<Map<string, string> | undefined> {
    const fresh = new Map<string, string>();
    let handle;
    try {
      handle = await open(join(this.storage, name), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      let state = this.files.get(name);
      // A different file under the live name means the ledger was rolled.
      if (!state || state.ino !== info.ino || info.size < state.loaded) {
        state = { loaded: 0, torn: 0, ino: info.ino, oldest: Infinity, lines: 0,
          keys: mode === 'live' || mode === 'growing' ? new Set() : undefined };
        this.files.set(name, state);
      } else if (mode === 'settled') {
        // Settled files are absorbed by the next snapshot, so their lines no longer block freezing.
        state.keys = undefined;
      }
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      let pending = Buffer.alloc(0);
      let position = state.loaded;
      let first = state.loaded === 0;
      while (position < info.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        const complete = pending.lastIndexOf(10) + 1;
        if (complete === 0) {
          // A line this long cannot be an entry. Drop its bytes; whatever
          // remains before its newline is counted when it fails to parse.
          if (pending.length > MAX_LINE_BYTES) {
            if (mode === 'snapshot') throw new Error('Invalid account POC snapshot. Tracking data was left untouched.');
            state.loaded = position;
            pending = Buffer.alloc(0);
          }
          continue;
        }
        for (const line of pending.toString('utf8', 0, complete).split('\n')) {
          if (!line) continue;
          let parsed;
          try { parsed = JSON.parse(line); }
          catch {
            if (mode === 'snapshot') throw new Error('Invalid account POC snapshot. Tracking data was left untouched.');
            if (mode === 'legacy') throw new Error('Invalid account POC evidence journal. Tracking data was left untouched.');
            state.torn++;
            continue;
          }
          if (parsed?.kind === 'snapshot') {
            if (mode !== 'snapshot' || !first) throw new Error('Invalid account POC snapshot. Tracking data was left untouched.');
            const header = validateSnapshot(parsed);
            this.snapshotAt = header.at;
            this.absorbed = new Map(header.absorbed.map((file) => [file.name, file.bytes]));
            state.expectedLines = header.lines;
            this.legacyBefore = header.version === 1 ? header.at - LEGACY_FREEZE_MS : header.legacyBefore ?? -Infinity;
            first = false;
            continue;
          }
          if (mode === 'snapshot' && first) throw new Error('Invalid account POC snapshot. Tracking data was left untouched.');
          state.lines++;
          if (parsed?.kind === 'frozen-keys') {
            if (mode !== 'snapshot' || !Array.isArray(parsed.keys) ||
              parsed.keys.some((key: unknown) => typeof key !== 'string' || !/^[a-f\d]{64}$/.test(key))) {
              throw new Error('Invalid account POC snapshot. Tracking data was left untouched.');
            }
            for (const key of parsed.keys) this.frozenKeys.add(key);
            continue;
          }
          const entry = validateEntry(parsed);
          const key = entryKey(entry);
          if (entry.kind === 'bill' && mode !== 'snapshot' && !this.entries.has(key) &&
            entry.record.timestamp.getTime() < this.legacyBefore) continue;
          state.keys?.add(key);
          if (entry.kind === 'bill') state.oldest = Math.min(state.oldest, entry.record.timestamp.getTime());
          else if (entry.kind === 'completion' || entry.kind === 'request-summary') state.oldest = Math.min(state.oldest, entry.at);
          fresh.set(key, line);
          this.add(entry);
        }
        state.loaded += complete;
        pending = Buffer.from(pending.subarray(complete));
      }
      // Snapshots are published as complete immutable files. A missing header
      // or unfinished line must not authorize retiring their source journals.
      if (mode === 'snapshot' && (first || pending.length > 0 || position < info.size ||
        (state.expectedLines !== undefined && state.lines !== state.expectedLines))) {
        throw new Error('Invalid account POC snapshot. Tracking data was left untouched.');
      }
      // A trailing fragment in a legacy journal or settled rolled ledger is
      // final: count it once instead of rereading it.
      if (mode !== 'live' && mode !== 'growing' && state.loaded < info.size) {
        if (pending.length) state.torn++;
        state.loaded = info.size;
      }
    } catch (error) {
      // A snapshot authorizes retiring source journals only after every byte
      // validates. Discard partial entries and offsets so every retry starts
      // with its header, including files containing only blank lines.
      if (mode === 'snapshot') this.reset();
      throw error;
    } finally {
      await handle.close();
    }
    return fresh;
  }

  /**
   * Removes a file the loaded snapshot absorbed. Whole lines appended after the
   * snapshot read it, by a window whose append was already in flight when the
   * ledger was rolled, are moved to the live ledger first.
   */
  private async retire(name: string, bytes: number, problems: string[]): Promise<void> {
    const path = join(this.storage, name);
    try {
      const handle = await open(path, 'r');
      try {
        const size = (await handle.stat()).size;
        if (size > bytes) {
          const tail = Buffer.alloc(size - bytes);
          let read = 0;
          while (read < tail.length) {
            const { bytesRead } = await handle.read(tail, read, tail.length - read, bytes + read);
            if (bytesRead === 0) break;
            read += bytesRead;
          }
          const lines = tail.toString('utf8', 0, read).split('\n');
          lines.pop();
          const late = lines.filter((line) => {
            if (!line) return false;
            try { JSON.parse(line); return true; }
            catch { return false; }
          });
          if (late.length) await appendLines(this.ledger, late);
        }
      } finally {
        await handle.close();
      }
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Cannot remove absorbed ledger file: ${name}`);
    }
  }

  /** Moves the live ledger aside so its old requests can be frozen once appends settle. */
  private async roll(now: number, problems: string[]): Promise<void> {
    const name = `ledger-${now}-${randomUUID()}.jsonl`;
    try {
      await rename(this.ledger, join(this.storage, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Cannot roll the account ledger: ${name}`);
      return;
    }
    const state = this.files.get(LIVE_LEDGER);
    if (state) {
      this.files.set(name, state);
      this.files.delete(LIVE_LEDGER);
    }
  }

  /**
   * Writes the next snapshot from memory: rollups for every request older than
   * the freeze window whose lines are all in absorbable files, auth history,
   * and every younger line. Published by exclusive hard link after fsync;
   * readers rebuild from it and retire the files it absorbed.
   */
  private async freeze(now: number, decisions: Map<string, Attribution>, absorbable: Absorbed[]): Promise<void> {
    // Another window may have published meanwhile; its snapshot supersedes this state.
    const names = await readdir(this.storage);
    if (names.filter((name) => SNAPSHOT.test(name)).sort(compareSnapshots).reverse()[0] !== this.snapshot) return;
    const rollups = new Map<string, Rollup>();
    const frozenKeys = new Set(this.frozenKeys);
    const lines: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.kind === 'rollup') {
        rollups.set(key, entry);
      } else if (entry.kind === 'bill') {
        if (entry.record.timestamp.getTime() < this.cutoff && !this.blocked(key)) {
          fold(rollups, entry, decisions.get(key) ?? { pending: 'Frozen before its request logs were read.' }, now);
          frozenKeys.add(key);
        } else {
          lines.push(JSON.stringify(entry));
        }
      } else if (isAuth(entry) || entry.at >= this.cutoff || this.blocked(key)) {
        lines.push(JSON.stringify(entry));
      }
    }
    const carried = [...this.absorbed].filter(([name]) => names.includes(name)).map(([name, bytes]) => ({ name, bytes }));
    const keyLines: string[] = [];
    let keys: string[] = [];
    for (const key of frozenKeys) {
      keys.push(key);
      if (keys.length === 1_024) {
        keyLines.push(JSON.stringify({ kind: 'frozen-keys', keys }));
        keys = [];
      }
    }
    if (keys.length) keyLines.push(JSON.stringify({ kind: 'frozen-keys', keys }));
    const body = [...keyLines, ...[...rollups.values()].map((entry) => JSON.stringify(entry)), ...lines];
    const header: SnapshotHeader = { kind: 'snapshot', version: 2, at: now, absorbed: [...carried, ...absorbable],
      lines: body.length, ...(Number.isFinite(this.legacyBefore) ? { legacyBefore: this.legacyBefore } : {}) };
    const text = [JSON.stringify(header), ...body].join('\n') + '\n';
    const id = `${now}-${randomUUID()}`;
    const temp = join(this.storage, `snapshot-${id}.tmp`);
    // Every writer based on the same snapshot competes for the same successor.
    // A stale publisher can never replace it, even if its clock or UUID sorts later.
    const generation = this.snapshot ? Number(SNAPSHOT.exec(this.snapshot)![1]) + 1 : 1;
    const target = join(this.storage, `snapshot-${generation}-${SNAPSHOT_WRITER}.jsonl`);
    try {
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try { await link(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  private frozenAggregate(account: string | undefined, now: Date): FrozenAggregate | undefined {
    const day = localDayKey(now.getTime());
    if (this.frozen && this.frozen.revision === this.revision && this.frozen.account === account && this.frozen.day === day) {
      return this.frozen.byChat.size ? this.frozen : undefined;
    }
    const records: UsageRecord[] = [];
    const byChat = new Map<string, UsageRecord[]>();
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'rollup' || !visibleTo(entry.decision, account)) continue;
      const record = titledRecord(entry);
      records.push(record);
      push(byChat, record.chatId, record);
    }
    this.frozen = { revision: this.revision, account, day, summary: aggregateUsage(records, now), byChat, models: collectModelUsage(records) };
    return byChat.size ? this.frozen : undefined;
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

/**
 * Applies a later saved line to the entry in memory. Copilot rewrites the chat
 * file on every message, so title times move while the label stays. Those move
 * in memory only; a ledger line is worth writing for a changed label, priority,
 * or session start. Returns undefined when nothing changed.
 */
function mergeSaved(previous: Saved, entry: Saved): { entry: Saved; sameLabel: boolean } | undefined {
  const priority = entry.record.titlePriority ?? TITLE_PRIORITY.record;
  const previousPriority = previous.record.titlePriority ?? TITLE_PRIORITY.record;
  const newerTitle = hasNewerTitle(previous, entry);
  let merged: Saved = previous;
  let sessionChanged = false;
  let newerTotals = false;
  if (previous.kind === 'bill' && entry.kind === 'bill') {
    const sessionStart = previous.sessionStart ?? entry.sessionStart;
    sessionChanged = sessionStart !== previous.sessionStart;
    merged = { ...previous, sessionStart };
  } else if (previous.kind === 'rollup' && entry.kind === 'rollup' && entry.frozenAt > previous.frozenAt) {
    // A rollup from a later snapshot carries more requests under the same key.
    newerTotals = true;
    merged = { ...previous, requests: entry.requests, frozenAt: entry.frozenAt, record: { ...previous.record,
      tokens: entry.record.tokens, billing: entry.record.billing, timestamp: entry.record.timestamp, filePath: entry.record.filePath } };
  }
  if (!newerTitle && !sessionChanged && !newerTotals) return undefined;
  const sameLabel = !sessionChanged && entry.record.title === previous.record.title && priority === previousPriority;
  if (newerTitle) {
    merged = { ...merged, record: { ...merged.record, title: entry.record.title, titlePriority: entry.record.titlePriority },
      titleTimestamp: entry.titleTimestamp, titleModifiedAt: entry.titleModifiedAt };
  }
  return { entry: merged, sameLabel };
}

function hasNewerTitle(previous: Saved, entry: Saved): boolean {
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
  return !legacyFallback && entry.titleTimestamp !== undefined && (previous.titleTimestamp === undefined ||
    priority > previousPriority || (priority === previousPriority && (priority === TITLE_PRIORITY.prompt
      ? entry.titleTimestamp < previous.titleTimestamp : laterTitle)));
}

/** Adds a frozen bill to the rollup for its chat, model, local day, and decision. */
function fold(rollups: Map<string, Rollup>, bill: Bill, decision: Attribution, frozenAt: number): void {
  const record = bill.record;
  const day = localDayKey(record.timestamp.getTime());
  const key = rollupKey(record.chatId, record.model, day, record.tokens.source, decision);
  const previous = rollups.get(key);
  if (!previous) {
    rollups.set(key, { kind: 'rollup', key, day, requests: 1, decision, frozenAt,
      record: { chatId: record.chatId, title: record.title, titlePriority: record.titlePriority, timestamp: record.timestamp,
        model: record.model, tokens: { ...record.tokens }, billing: { aiCredits: record.billing!.aiCredits, source: 'copilot-debug-log' },
        filePath: record.filePath },
      titleTimestamp: bill.titleTimestamp, titleModifiedAt: bill.titleModifiedAt });
    return;
  }
  const later = record.timestamp > previous.record.timestamp;
  const tokens = previous.record.tokens;
  const merged: Rollup = { ...previous, requests: previous.requests + 1, record: { ...previous.record,
    timestamp: later ? record.timestamp : previous.record.timestamp,
    filePath: later ? record.filePath : previous.record.filePath,
    tokens: { input: tokens.input + record.tokens.input, cachedInput: tokens.cachedInput + record.tokens.cachedInput,
      output: tokens.output + record.tokens.output, cacheWriteInput: tokens.cacheWriteInput + record.tokens.cacheWriteInput,
      total: tokens.total + record.tokens.total, source: tokens.source },
    billing: { aiCredits: previous.record.billing!.aiCredits + record.billing!.aiCredits, source: 'copilot-debug-log' } } };
  rollups.set(key, hasNewerTitle(previous, bill) ? { ...merged, titleTimestamp: bill.titleTimestamp, titleModifiedAt: bill.titleModifiedAt,
    record: { ...merged.record, title: record.title, titlePriority: record.titlePriority } } : merged);
}

/**
 * Combines the cached aggregate of frozen usage with this refresh's aggregate
 * of younger records, giving the same result as aggregating them together.
 * Frozen records are days old, so only chats, models, and period totals meet.
 */
function mergeUsage(frozen: FrozenAggregate, young: UsageSummary, youngRecords: UsageRecord[], now: Date): UsageSummary {
  const overlap = new Map<string, ChatUsageSummary>();
  const youngChats = young.chats.map((chat) => {
    const frozenRecords = frozen.byChat.get(chat.chatId);
    if (!frozenRecords) return chat;
    const merged = aggregateUsage([...frozenRecords, ...chat.records], now).chats[0];
    overlap.set(chat.chatId, merged);
    return merged;
  }).sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
  const frozenChats = overlap.size ? frozen.summary.chats.filter((chat) => !overlap.has(chat.chatId)) : frozen.summary.chats;
  const chats: ChatUsageSummary[] = [];
  for (let f = 0, y = 0; f < frozenChats.length || y < youngChats.length;) {
    if (y >= youngChats.length || (f < frozenChats.length && frozenChats[f].timestamp >= youngChats[y].timestamp)) chats.push(frozenChats[f++]);
    else chats.push(youngChats[y++]);
  }
  const youngModels = collectModelUsage(youngRecords);
  const models: [string, { sessions: number; tokens: number; githubCopilot: CopilotCostEstimate }][] = [];
  for (const [model, usage] of frozen.models) {
    const extra = youngModels.get(model);
    models.push([model, {
      sessions: usage.chatIds.size + (extra ? [...extra.chatIds].filter((chatId) => !usage.chatIds.has(chatId)).length : 0),
      tokens: usage.tokens + (extra?.tokens ?? 0),
      githubCopilot: extra ? mergeCostEstimates(usage.githubCopilot, extra.githubCopilot) : usage.githubCopilot,
    }]);
  }
  for (const [model, usage] of youngModels) {
    if (!frozen.models.has(model)) models.push([model, { sessions: usage.chatIds.size, tokens: usage.tokens, githubCopilot: usage.githubCopilot }]);
  }
  const retitle = (chat: ChatUsageSummary | undefined) => {
    const merged = chat && overlap.get(chat.chatId);
    return merged ? { ...chat, title: merged.title, titlePriority: merged.titlePriority,
      titleTimestamp: merged.titleTimestamp, titleModifiedAt: merged.titleModifiedAt } : chat;
  };
  return {
    today: mergeUsageTotals(frozen.summary.today, young.today),
    week: mergeUsageTotals(frozen.summary.week, young.week),
    month: mergeUsageTotals(frozen.summary.month, young.month),
    allTime: mergeUsageTotals(frozen.summary.allTime, young.allTime),
    chats,
    topModels: rankModelUsage(models),
    highestSessionToday: retitle(young.highestSessionToday),
    mostExpensiveSessionToday: retitle(young.mostExpensiveSessionToday),
  };
}

type SnapshotHeader = { kind: 'snapshot'; version: 1 | 2; at: number; absorbed: Absorbed[]; lines?: number; legacyBefore?: number };

function validateSnapshot(header: SnapshotHeader): SnapshotHeader {
  if (![1, 2].includes(header.version) || !Number.isFinite(header.at) || !Array.isArray(header.absorbed) ||
    header.absorbed.some((file) => typeof file?.name !== 'string' ||
      (!ROLLED_LEDGER.test(file.name) && !LEGACY_JOURNAL.test(file.name)) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) ||
    new Set(header.absorbed.map((file) => file.name)).size !== header.absorbed.length ||
    (header.version === 2 && (!Number.isSafeInteger(header.lines) || header.lines! < 0)) ||
    (header.legacyBefore !== undefined && !Number.isFinite(header.legacyBefore))) {
    throw new Error('Invalid account POC snapshot. Tracking data was left untouched.');
  }
  return header;
}

function validateEntry(entry: Entry): Entry {
  if (typeof entry !== 'object' || entry === null) throw new Error('Invalid account POC evidence journal. Tracking data was left untouched.');
  if (entry.kind === 'bill' || entry.kind === 'rollup') {
    if (typeof entry.record !== 'object' || entry.record === null) throw new Error('Invalid account POC request journal. Tracking data was left untouched.');
    entry.record.timestamp = new Date(entry.record.timestamp);
    const expectedKey = entry.kind === 'bill' ? billKey(entry.record) : validRollup(entry)
      ? rollupKey(entry.record.chatId, entry.record.model, entry.day, entry.record.tokens.source, entry.decision) : undefined;
    if (!Number.isFinite(entry.record.timestamp.getTime()) || entry.key !== expectedKey ||
      typeof entry.record.billing?.aiCredits !== 'number' || !Number.isFinite(entry.record.billing.aiCredits) || entry.record.billing.aiCredits <= 0) {
      throw new Error('Invalid account POC request journal. Tracking data was left untouched.');
    }
    if ((entry.titleTimestamp !== undefined && (!Number.isFinite(entry.titleTimestamp) || !Number.isFinite(entry.record.titlePriority))) ||
      (entry.titleModifiedAt !== undefined && !Number.isFinite(entry.titleModifiedAt))) {
      throw new Error('Invalid account POC title journal. Tracking data was left untouched.');
    }
  } else if (!['login', 'token', 'unknown', 'completion', 'request-summary'].includes(entry.kind) || !Number.isFinite(entry.at) || typeof entry.stream !== 'string') {
    throw new Error('Invalid account POC evidence journal. Tracking data was left untouched.');
  } else {
    entry.stream = pathIdentity(entry.stream);
  }
  return entry;
}

function validRollup(entry: Rollup): boolean {
  const record = entry.record;
  const decision = entry.decision;
  const tokens = record.tokens;
  return typeof record.chatId === 'string' && typeof record.model === 'string' && typeof entry.day === 'string' &&
    Number.isInteger(entry.requests) && entry.requests > 0 && Number.isFinite(entry.frozenAt) &&
    typeof tokens === 'object' && tokens !== null && ['recorded', 'missing'].includes(tokens.source) &&
    [tokens.input, tokens.cachedInput, tokens.output, tokens.cacheWriteInput, tokens.total].every(Number.isFinite) &&
    typeof decision === 'object' && decision !== null && Object.keys(decision).length === 1 &&
    ('account' in decision ? typeof decision.account === 'string' : 'excluded' in decision ? typeof decision.excluded === 'string' :
      'pending' in decision && typeof decision.pending === 'string');
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
      await appendLiveBatch(file, `\n${group}`);
      group = '';
      bytes = 0;
    }
    group += `${line}\n`;
    bytes += size;
  }
  if (bytes) await appendLiveBatch(file, `\n${group}`);
}

/** A rolled file may be retired while a slow appender still holds it open. */
async function appendLiveBatch(file: string, batch: string): Promise<void> {
  for (;;) {
    // Pin the original inode until the check, so a replacement cannot reuse it.
    const pinned = await open(file, 'a');
    try {
      const before = await pinned.stat({ bigint: true });
      await appendFile(file, batch, 'utf8');
      try {
        const after = await stat(file, { bigint: true });
        if (after.ino === before.ino) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Replaying a whole batch is safe: readers deduplicate saved entry keys.
    } finally {
      await pinned.close();
    }
  }
}

function billKey(record: UsageRecord, canonical = false): string {
  return createHash('sha256').update(JSON.stringify([
    canonical ? pathIdentity(record.filePath) : resolve(record.filePath), record.timestamp.getTime(), record.debugRequest?.spanId,
    record.debugRequest?.responseId, record.debugRequest?.durationMs, record.model,
  ])).digest('hex');
}

function rollupKey(chatId: string, model: string, day: string, source: string, decision: Attribution): string {
  const [state, value] = Object.entries(decision)[0];
  return createHash('sha256').update(JSON.stringify(['rollup', chatId, model, day, source, state, value])).digest('hex');
}

function entryKey(entry: Entry): string {
  // Keep validating the original saved key, but collapse path aliases in memory.
  if (entry.kind === 'bill') return billKey(entry.record, true);
  if (entry.kind === 'rollup') return entry.key;
  return JSON.stringify({ ...entry, stream: pathIdentity(entry.stream) });
}

function localDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function rolledAt(name: string): number {
  return Number(ROLLED_LEDGER.exec(name)![1]);
}

function compareSnapshots(left: string, right: string): number {
  return Number(SNAPSHOT.exec(left)![1]) - Number(SNAPSHOT.exec(right)![1]) || left.localeCompare(right);
}
