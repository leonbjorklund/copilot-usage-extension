import { open, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import * as vscode from 'vscode';
import { parseCopilotQuota, type CopilotQuota } from './quota';
import type { QuotaHistory, QuotaObservation } from './quotaHistory';

export type QuotaState =
  | { kind: 'idle' }
  | { kind: 'waiting'; reason?: string }
  // `account` is absent when the log lost this window's account lines.
  | { kind: 'quota'; quota: CopilotQuota; account?: string; observedAt: number };

const POLL_MS = 2_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
class LogChangedDuringRead extends Error {}

async function readBytes(file: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) throw new LogChangedDuringRead();
    offset += bytesRead;
  }
  return buffer;
}

interface LogState {
  account?: string;
  previousAccount?: string;
  tokenChanged: boolean;
  // A lost span may contain a switch, even if the next token names the same account.
  hasReadGap?: boolean;
  unverifiedQuota?: boolean;
  snapshot?: Extract<QuotaState, { kind: 'quota' }>;
  /**
   * Log content was lost after this window verified an account. Quota stays
   * visible without an owner until an auth or token line, and is never journaled.
   */
  lost?: boolean;
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Any message from Copilot's sign-in or token handling, which can belong to an account change.
const AUTH_ACTIVITY = /\] (?:Logged in as |Got Copilot token for |Getting CopilotToken |Got CopilotToken |GitHub login failed|Auth state changed|Minted a new CopilotToken|Handling CopilotToken refresh|AuthenticationService: firing |onDidCopilotTokenChange )/;

/**
 * Quota records lack account IDs. After a switch, trust only token-derived
 * snapshots. Every accepted percentage is also collected into `observations`
 * for the daily history, even when a later line retracts the current state.
 */
export function quotaFromLog(
  text: string, now = Date.now(), seenAccounts = new Set<string>(), observations?: QuotaObservation[],
): Extract<QuotaState, { kind: 'quota' }> | undefined {
  return consumeLog(text, now, seenAccounts, { tokenChanged: false }, observations);
}

function consumeLog(text: string, now: number, seenAccounts: Set<string>, state: LogState,
  observations?: QuotaObservation[]): Extract<QuotaState, { kind: 'quota' }> | undefined {
  let { account, previousAccount, tokenChanged, snapshot, lost } = state;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const at = new Date(line.slice(0, 23)).getTime();
    // Account lines apply even if the clock moved back; a skipped line is never reread.
    if (!Number.isFinite(at)) continue;
    const auth = /\] (Logged in as |Got Copilot token for )(\S+)/.exec(line);
    if (lost && AUTH_ACTIVITY.test(line)) {
      // The lost lines may have held an account change. Wait for a named token.
      lost = false;
      snapshot = undefined;
    }
    if (auth) {
      const login = auth[2].toLowerCase();
      if (!/^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(login) || login === 'devdeviceid') {
        account = snapshot = undefined;
        tokenChanged = false;
        continue;
      }
      // Two distinct accounts prove a switch, including across a read gap.
      if (seenAccounts.size < 2) seenAccounts.add(login);
      if (login !== previousAccount) { account = undefined; snapshot = undefined; tokenChanged = false; }
      previousAccount = login;
      if (auth[1].startsWith('Got')) { account = login; state.unverifiedQuota = false; }
    } else if (/GitHub login failed|AuthenticationService: firing onDidAuthenticationChange .*Has token: false|onDidCopilotTokenChange .*token lost|onDidCopilotTokenChange .*resetCopilotToken/.test(line)) {
      account = undefined;
      snapshot = undefined;
      tokenChanged = false;
    } else if (/Auth state changed \(identity change\)/.test(line)) {
      // Startup can reauthenticate the same account. Hide its snapshot until a
      // successful token confirms it; a different login still discards it above.
      account = undefined;
      tokenChanged = false;
    }
    if (/\] AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken\.$/.test(line)) {
      tokenChanged = true;
    } else if (/\] (?:Minted a new CopilotToken\.|Finished handling auth change event\.|AuthenticationService: firing onDidAuthenticationChange )/.test(line)) {
      // The synchronous token listeners have finished. A later user-info
      // snapshot can belong to an asynchronous refresh for the old account.
      tokenChanged = false;
    }
    const match = /\[trace\] \[ChatQuota\] (processQuotaHeaders|processQuotaSnapshots|processUserInfoQuotaSnapshot): (.*)$/.exec(line);
    if (!match) continue;
    if (!account && !lost) { state.unverifiedQuota = true; continue; }
    const tokenSnapshot = tokenChanged && match[1] === 'processUserInfoQuotaSnapshot';
    tokenChanged = false;
    // Anonymous percentages carry no ownership claim. Named percentages after a
    // switch or read gap need a token snapshot, not a possibly delayed response.
    if (at > now || (!lost && (seenAccounts.size > 1 || state.hasReadGap) && !tokenSnapshot)) continue;
    snapshot = undefined;
    try {
      const quota = parseCopilotQuota(JSON.parse(match[2]));
      if (quota) {
        // Without account lines, show Copilot's quota but never name or journal an owner.
        snapshot = { kind: 'quota', quota, account: lost ? undefined : account, observedAt: at };
        if (snapshot.account && !quota.unlimited && quota.entitlement > 0) {
          observations?.push({ account: snapshot.account, at, percentRemaining: quota.percentRemaining,
            ...(quota.resetDate ? { resetDate: quota.resetDate.toISOString() } : {}) });
        }
      }
    } catch { /* Changed formats stay unavailable. */ }
  }
  Object.assign(state, { account, previousAccount, tokenChanged, snapshot, lost });
  return account && snapshot?.account === account ? snapshot : undefined;
}

export class CopilotQuotaService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private state: QuotaState = { kind: 'waiting' };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private disposed = false;
  // Survives log rotation and read failures for this service's lifetime.
  private readonly seenAccounts = new Set<string>();
  private cached: { size: number; modified: number; inode: number; digest: string; state: LogState } | undefined;
  readonly onDidChange = this.emitter.event;

  constructor(private readonly extensionLogPath: string, private readonly history?: Pick<QuotaHistory, 'record'>) {}

  getState(): QuotaState { return this.state; }

  private scheduleRefresh(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refreshNow();
    }, POLL_MS);
  }

  refreshNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.readStable().catch(() => {
      // Keep the checkpoint so a transient read failure can recover, but only
      // after its exact consumed prefix is found in the same current file.
      this.setState({ kind: 'waiting', reason: 'The Copilot quota log could not be read. Run "Copilot Token Cost: Refresh". If this persists, run "Developer: Reload Window".' });
    }).finally(() => { this.inFlight = undefined; this.scheduleRefresh(); });
    return this.inFlight;
  }

  private async readStable(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.read(); }
      catch (error) {
        if (attempt >= 2 || !(error instanceof LogChangedDuringRead || (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      }
    }
  }

  private async read(): Promise<void> {
    const path = join(dirname(this.extensionLogPath), 'GitHub.copilot-chat', 'GitHub Copilot Chat.log');
    const currentInfo = await stat(path);
    const previous = this.cached;
    if (previous?.size === currentInfo.size && previous.modified === currentInfo.mtimeMs && previous.inode === currentInfo.ino) {
      this.setState(this.quotaState(previous.state));
      return;
    }

    const file = await open(path, 'r');
    let capture;
    try {
      const info = await file.stat();
      if (info.size > MAX_LOG_BYTES) throw new Error('Copilot log exceeds quota read limit.');
      const buffer = await readBytes(file, info.size);
      // Appends are safe, but a truncate/regrow between short reads can splice
      // old account lines onto new quota. Verify the captured prefix itself.
      if (!buffer.equals(await readBytes(file, info.size))) {
        throw new LogChangedDuringRead();
      }
      capture = { info, buffer };
    } finally { await file.close(); }
    const { info, buffer } = capture;
    const after = await stat(path);
    if (after.ino !== info.ino || after.size < info.size) {
      throw new LogChangedDuringRead();
    }
    const end = buffer.lastIndexOf(10) + 1;
    // Only the same current file can prove continuity. An old backup can survive
    // while a failed later rotation erases an account switch in the newer file.
    const continuous = previous !== undefined && previous.size > 0 && info.ino === previous.inode
      && end >= previous.size && digest(buffer.subarray(0, previous.size)) === previous.digest;
    // After verified account evidence is lost, keep quota visible without an owner.
    const lost = !continuous && !!(previous?.state.account || previous?.state.lost);
    const state: LogState = continuous ? { ...previous!.state }
      : lost ? { ...previous!.state, account: undefined, tokenChanged: false, lost: true }
      : { tokenChanged: false };
    // Keep the ambiguity after recovery and after any later parser reset.
    state.hasReadGap = previous?.state.hasReadGap || (previous !== undefined && !continuous);
    const observations: QuotaObservation[] = [];
    consumeLog(buffer.toString('utf8', continuous ? previous!.size : 0, end), Date.now(), this.seenAccounts, state, observations);
    // Journal before committing the checkpoint, so failed appends are retried.
    await this.history?.record(observations);
    // Retain only parsed evidence and a digest, never prompts or credentials.
    this.cached = { size: end, modified: info.mtimeMs, inode: info.ino,
      digest: digest(buffer.subarray(0, end)), state };
    if (this.disposed) return;
    this.setState(this.quotaState(state));
  }

  private quotaState(state: LogState): QuotaState {
    const { snapshot } = state;
    if (snapshot && state.lost) {
      return { kind: 'quota', quota: snapshot.quota, observedAt: snapshot.observedAt };
    }
    if (state.account && snapshot?.account === state.account) return snapshot;
    return state.unverifiedQuota
      ? { kind: 'waiting', reason: 'The Copilot log cannot verify which account owns this quota. Run "Developer: Reload Window" to capture fresh account and quota evidence.' }
      : { kind: 'waiting' };
  }

  private setState(state: QuotaState): void {
    if (this.disposed || JSON.stringify(this.state) === JSON.stringify(state)) return;
    this.state = state;
    this.emitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
