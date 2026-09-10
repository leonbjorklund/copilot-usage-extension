import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import * as vscode from 'vscode';

/**
 * Copilot Chat logs `Logged in as <login>` every time it resolves its GitHub
 * account, including after a switch. VS Code tells no extension which account
 * another one uses, so this line in Copilot Chat's own log for the window is
 * the only way the quota row can follow. Only the login is read from it.
 */
/** Copilot writes several lines per request, so a burst becomes one read. */
const READ_DELAY_MS = 500;
/** Windows may defer file notifications while Copilot keeps its log open. */
const POLL_INTERVAL_MS = 2_000;
const MAX_LOG_BYTES = 32 * 1024 * 1024;

type LogSnapshot = { size: number; modified: number };

/** Copilot Chat's log sits beside this extension's own log folder. */
export function copilotChatLogPath(extensionLogPath: string): string {
  return join(dirname(extensionLogPath), 'GitHub.copilot-chat', 'GitHub Copilot Chat.log');
}

export function lastLoginInLog(text: string): string | undefined {
  let login: string | undefined;
  for (const match of text.matchAll(/\] Logged in as (\S+)/g)) {
    login = match[1];
  }

  return login;
}

export interface CopilotAccountSource extends vscode.Disposable {
  /** Fires when the login changes. */
  readonly onDidChange: vscode.Event<void>;
  /** Copilot's current login, once the log has been read. */
  currentLogin(): Promise<string | undefined>;
}

export class CopilotAccountWatcher implements CopilotAccountSource {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly logPath: string;
  private snapshot: LogSnapshot | undefined;
  private login: string | undefined;
  private reading: Promise<void>;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  readonly onDidChange = this.changeEmitter.event;

  constructor(extensionLogPath: string) {
    this.logPath = copilotChatLogPath(extensionLogPath);
    // VS Code watches a folder that does not exist yet and starts reporting
    // once it is created, so one non-recursive watch on the log folder is enough.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirname(this.logPath)), basename(this.logPath)),
    );
    this.disposables.push(
      this.changeEmitter,
      watcher,
      watcher.onDidCreate(() => this.scheduleRead()),
      watcher.onDidChange(() => this.scheduleRead()),
    );
    this.reading = this.read();
    this.schedulePoll();
  }

  async currentLogin(): Promise<string | undefined> {
    await this.reading;
    return this.login;
  }

  dispose(): void {
    this.disposed = true;
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private scheduleRead(): void {
    if (this.disposed) {
      return;
    }
    if (this.readTimer) {
      clearTimeout(this.readTimer);
    }

    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      this.reading = this.reading.then(() => this.read());
    }, READ_DELAY_MS);
  }

  private schedulePoll(): void {
    if (this.disposed) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.reading = this.reading.then(() => this.read());
      // Check only this local log. An unchanged login emits no quota request.
      // Wait for the read to finish so slow disk access cannot build a queue.
      void this.reading.then(() => this.schedulePoll());
    }, POLL_INTERVAL_MS);
  }

  private async read(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const changed = await readChangedLines(this.logPath, this.snapshot);
      if (this.disposed) {
        return;
      }
      if (!changed) return;
      this.snapshot = changed.snapshot;
      const login = lastLoginInLog(changed.text);
      if (login !== undefined && login !== this.login) {
        this.login = login;
        this.changeEmitter.fire();
      }
    } catch {
      // No log yet, or Copilot Chat is not running in this window. Nothing may
      // reject here, or the read chain would stay broken for the session.
    }
  }
}

/**
 * Reads complete lines from a changed log. A replacement can grow past the old
 * offset, so reread its bounded contents instead of assuming every write appends.
 * Unchanged polls only stat the file; partial snapshots are retried.
 */
async function readChangedLines(
  filePath: string,
  previous: LogSnapshot | undefined,
): Promise<{ text: string; snapshot?: LogSnapshot } | undefined> {
  const file = await open(filePath, 'r');
  try {
    const info = await file.stat();
    if (info.size === previous?.size && info.mtimeMs === previous.modified) return undefined;
    if (info.size > MAX_LOG_BYTES) throw new Error('Copilot account log exceeds its read limit.');
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead);
    const end = chunk.lastIndexOf(10) + 1;
    return { text: chunk.toString('utf8', 0, end),
      snapshot: end === info.size ? { size: info.size, modified: info.mtimeMs } : undefined };
  } finally {
    await file.close();
  }
}
