import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import * as vscode from 'vscode';

import {
  addReadings, assignAccounts, currentAccount, loadRecords, readLogs, statusText, type LogState,
} from './quota';

const RECORDS_KEY = 'records';
const POLL_MS = 2_000;

export function activate(context: vscode.ExtensionContext): void {
  void removeOldData(context);

  // Every window reads every window's Copilot Chat log of this VS Code session.
  // logUri is <logs>/<session>/window<N>/exthost/<extension id>.
  const windowFolder = dirname(dirname(context.logUri.fsPath));
  const windowName = basename(windowFolder);
  const session = dirname(windowFolder);
  const logs: LogState = { windows: new Map(), logins: [] };
  let records = loadRecords(context.globalState.get(RECORDS_KEY));
  // A reload keeps appending to the same log, so only lines since this extension host started
  // show the level of this window's Copilot Chat channel.
  const hostStart = Date.now() - process.uptime() * 1000;
  const ownLogWritten = () => {
    const own = logs.windows.get(windowName);
    return own !== undefined && own.size > 0 && (own.modified ?? 0) >= hostStart;
  };

  // The window that switched Copilot Chat to Trace needs no restart, even before its next Trace line.
  let switched = false;

  // Copilot's own item sits right of the language mode (100.1); this lands directly right of it.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100.05);
  const render = () => {
    const needsRestart = !switched && ownLogWritten() && (logs.windows.get(windowName)!.traceAt ?? 0) < hostStart;
    const text = statusText(records, Date.now(), needsRestart);
    if (item.text !== text) item.text = text;
  };
  render();
  item.show();

  let traceChecked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const poll = async () => {
    try {
      const found = await readLogs(session, logs);
      // A Copilot Chat channel created after the switch would start at the old level, so wait until
      // this extension host's channel has written to the log.
      if (!traceChecked && ownLogWritten()) {
        traceChecked = true;
        void enableTrace().then((ran) => { switched = ran; });
      }
      const next = addReadings(records, assignAccounts(found, logs.logins, currentAccount(records)), Date.now());
      if (JSON.stringify(next) !== JSON.stringify(records)) {
        records = next;
        await context.globalState.update(RECORDS_KEY, records);
      }
    } catch {
      // The next poll tries again; the numbers shown stay.
    }
    if (disposed) return;
    timer = setTimeout(poll, POLL_MS);
    render();
  };
  void poll();

  context.subscriptions.push(item, new vscode.Disposable(() => {
    disposed = true;
    clearTimeout(timer);
  }));
}

/** The old build's history and caches. Old windows still running recreate them until they reload. */
async function removeOldData(context: vscode.ExtensionContext): Promise<void> {
  const storage = context.globalStorageUri.fsPath;
  await Promise.all(['account-tracking', 'account-poc', 'quota-history.jsonl', 'scan-cache'].map((name) =>
    rm(join(storage, name), { recursive: true, force: true }).catch(() => undefined)));
  if (context.globalState.get('copilotUsage.sortMode') !== undefined) {
    await context.globalState.update('copilotUsage.sortMode', undefined);
  }
}

/**
 * Copilot Chat logs quota only at Trace. VS Code saves the default in argv.json, which every window
 * reads at VS Code's next start, and switches this window's running Copilot Chat channel at once.
 * An existing Copilot entry is Trace already or the user's own choice, so it stays. Resolves to
 * whether it switched.
 */
export async function enableTrace(): Promise<boolean> {
  try {
    const portable = process.env.VSCODE_PORTABLE;
    const argv = portable ? join(portable, 'argv.json') : join(homedir(),
      JSON.parse(await readFile(join(vscode.env.appRoot, 'product.json'), 'utf8')).dataFolderName, 'argv.json');
    if (hasCopilotLogLevel(await readFile(argv, 'utf8').catch(() => ''))) return false;
    await vscode.commands.executeCommand('workbench.action.setDefaultLogLevel', vscode.LogLevel.Trace, 'github.copilot-chat');
    return true;
  } catch {
    // Copilot Chat keeps its level.
    return false;
  }
}

/** argv.json has a `github.copilot-chat` log-level entry. argv.json allows comments. */
export function hasCopilotLogLevel(argv: string): boolean {
  for (const [token] of argv.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"/g)) {
    if (!token.startsWith('"')) continue;
    try {
      if (/^github\.copilot-chat[:=]./i.test(JSON.parse(token))) return true;
    } catch {
      // A malformed string is not an entry.
    }
  }
  return false;
}
