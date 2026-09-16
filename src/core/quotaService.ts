import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import * as vscode from 'vscode';
import { parseCopilotQuota, type CopilotQuota } from './quota';
import type { QuotaHistory, QuotaObservation } from './quotaHistory';

export type QuotaState =
  | { kind: 'idle' }
  | { kind: 'waiting' }
  | { kind: 'quota'; quota: CopilotQuota; account: string; observedAt: number };

const POLL_MS = 2_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Quota records lack account IDs. After a switch, trust only token-derived
 * snapshots. Every accepted percentage is also collected into `observations`
 * for the daily history, even when a later line retracts the current state.
 */
export function quotaFromLog(
  text: string, now = Date.now(), seenAccounts = new Set<string>(), observations?: QuotaObservation[],
): Extract<QuotaState, { kind: 'quota' }> | undefined {
  let account: string | undefined;
  let previousAccount: string | undefined;
  let tokenChanged = false;
  let snapshot: Extract<QuotaState, { kind: 'quota' }> | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const at = new Date(line.slice(0, 23)).getTime();
    if (!Number.isFinite(at) || at > now) continue;
    const auth = /\] (Logged in as |Got Copilot token for )(\S+)/.exec(line);
    if (auth) {
      const login = auth[2].toLowerCase();
      if (!/^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(login) || login === 'devdeviceid') {
        account = snapshot = undefined;
        tokenChanged = false;
        continue;
      }
      // Two distinct accounts prove a switch. Retain only that bounded history,
      // never reuse it as authentication evidence for a replacement log.
      if (seenAccounts.size < 2) seenAccounts.add(login);
      if (login !== previousAccount) { account = undefined; snapshot = undefined; tokenChanged = false; }
      previousAccount = login;
      if (auth[1].startsWith('Got')) account = login;
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
    if (!match || !account) continue;
    const tokenSnapshot = tokenChanged && match[1] === 'processUserInfoQuotaSnapshot';
    tokenChanged = false;
    if (seenAccounts.size > 1 && !tokenSnapshot) continue;
    snapshot = undefined;
    try {
      const quota = parseCopilotQuota(JSON.parse(match[2]));
      if (quota) {
        snapshot = { kind: 'quota', quota, account, observedAt: at };
        if (!quota.unlimited && quota.entitlement > 0) {
          observations?.push({ account, at, percentRemaining: quota.percentRemaining,
            ...(quota.resetDate ? { resetDate: quota.resetDate.toISOString() } : {}) });
        }
      }
    } catch { /* Changed formats stay unavailable. */ }
  }
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
  private cached: { size: number; modified: number; inode: number; quota?: Extract<QuotaState, { kind: 'quota' }> } | undefined;
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
    this.inFlight = this.read().catch(() => {
      this.cached = undefined;
      this.setState({ kind: 'waiting' });
    }).finally(() => { this.inFlight = undefined; this.scheduleRefresh(); });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    const file = await open(join(dirname(this.extensionLogPath), 'GitHub.copilot-chat', 'GitHub Copilot Chat.log'), 'r');

    try {
      const info = await file.stat();
      if (info.size > MAX_LOG_BYTES) throw new Error('Copilot log exceeds quota read limit.');
      if (this.cached?.size !== info.size || this.cached.modified !== info.mtimeMs || this.cached.inode !== info.ino) {
        const buffer = Buffer.alloc(info.size);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const chunk = buffer.subarray(0, bytesRead);
        const end = chunk.lastIndexOf(10) + 1;
        const text = chunk.toString('utf8', 0, end);
        const observations: QuotaObservation[] = [];
        const quota = quotaFromLog(text, Date.now(), this.seenAccounts, observations);
        // Cache only quota and capture metadata, never prompt bodies or other log content.
        this.cached = { quota, size: end, modified: info.mtimeMs, inode: info.ino };
        // Journal before announcing the state so the tooltip sees the new day value.
        await this.history?.record(observations);
      }
    } finally { await file.close(); }
    const quota = this.cached?.quota;
    if (this.disposed) return;
    this.setState(quota ?? { kind: 'waiting' });
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
