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
  private offset = 0;
  private login: string | undefined;
  private reading: Promise<void>;
  private readTimer: ReturnType<typeof setTimeout> | undefined;

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
  }

  async currentLogin(): Promise<string | undefined> {
    await this.reading;
    return this.login;
  }

  dispose(): void {
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private scheduleRead(): void {
    if (this.readTimer) {
      clearTimeout(this.readTimer);
    }

    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      this.reading = this.reading.then(() => this.read());
    }, READ_DELAY_MS);
  }

  private async read(): Promise<void> {
    try {
      const appended = await readAppendedLines(this.logPath, this.offset);
      this.offset = appended.nextOffset;
      const login = lastLoginInLog(appended.text);
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
 * Reads the complete lines written after `offset`. A line still being written
 * is left for the next read, and a log that shrank is read from the start.
 */
async function readAppendedLines(
  filePath: string,
  offset: number,
): Promise<{ text: string; nextOffset: number }> {
  const file = await open(filePath, 'r');
  try {
    const size = (await file.stat()).size;
    const start = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const chunk = buffer.subarray(0, bytesRead);
    const end = chunk.lastIndexOf(10) + 1;
    return { text: chunk.toString('utf8', 0, end), nextOffset: start + end };
  } finally {
    await file.close();
  }
}
