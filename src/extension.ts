import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import * as vscode from 'vscode';

import { DARK, hoverMarkdown, LIGHT } from './hover';
import { loadTally, saveTally, scanDebugLogs, topModels } from './models';
import { addReadings, assignAccounts, currentAccount, loadRecords, readLogs, statusText, type LogState, type Records } from './quota';

const MODELS_KEY = 'models';
// The debug-log settings already turned on, or found with a user value.
const DEBUG_LOGS_KEY = 'debugLogs';
const POLL_MS = 2_000;
// Copilot writes its debug logs every 4 seconds, and Model use can wait a little longer.
const SCAN_MS = 10_000;

export function activate(context: vscode.ExtensionContext): void {
  void removeOldData(context);
  // Copilot writes no debug logs before VS Code restarts, so the hover says so until model use shows.
  let modelsNeedRestart = false;
  void enableDebugLog(context.globalState).then((turnedOn) => { modelsNeedRestart = turnedOn; });

  // Every window reads every window's Copilot Chat log of this VS Code session.
  // logUri is <logs>/<session>/window<N>/exthost/<extension id>.
  const windowFolder = dirname(dirname(context.logUri.fsPath));
  const windowName = basename(windowFolder);
  const session = dirname(windowFolder);
  const logs: LogState = { windows: new Map(), logins: [] };
  // globalStorageUri is <User>/globalStorage/<extension id> in every profile, while globalState is
  // kept per profile, so windows of all profiles share this file.
  const recordsFile = join(context.globalStorageUri.fsPath, 'records.json');
  let records = readRecords(recordsFile);
  // What the file holds, so a failed save is tried again on the next poll.
  let saved = JSON.stringify(records);
  const user = dirname(dirname(context.globalStorageUri.fsPath));
  const tally = loadTally(context.globalState.get(MODELS_KEY), Date.now());
  const read = new Map<string, number>();
  let scanned = 0;
  // A reload keeps appending to the same log, so only lines since this extension host started
  // show the level of this window's Copilot Chat channel.
  const hostStart = Date.now() - process.uptime() * 1000;
  const ownLogWritten = () => {
    const own = logs.windows.get(windowName);
    return own !== undefined && own.size > 0 && (own.modified ?? 0) >= hostStart;
  };

  // The window that switched Copilot Chat to Trace needs no restart, even before its next Trace line.
  // Unset until this extension host's Copilot Chat channel has written to the log.
  let trace: Awaited<ReturnType<typeof enableTrace>> | undefined;

  // Copilot's own item sits right of the language mode (100.1); this lands directly right of it.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100.05);
  const render = () => {
    const now = Date.now();
    const login = logs.windows.get(windowName)?.login;
    // Prefer this window's account once it has quota; otherwise keep the latest account shown.
    const displayRecords = login && Object.hasOwn(records, login) ? { [login]: records[login] } : records;
    const noTrace = trace !== 'switched' && ownLogWritten() && (logs.windows.get(windowName)!.traceAt ?? 0) < hostStart;
    const text = statusText(displayRecords, now, noTrace ? (trace === 'other' ? 'trace' : 'restart') : undefined);
    if (item.text !== text) item.text = text;
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    const markdown = hoverMarkdown(displayRecords, now, light ? LIGHT : DARK, topModels(tally), modelsNeedRestart);
    // Each assignment sends the window an update, so only a changed hover is sent.
    if ((item.tooltip as vscode.MarkdownString | undefined)?.value !== markdown) {
      item.tooltip = markdown === undefined
        ? undefined
        : Object.assign(new vscode.MarkdownString(markdown, true), { supportHtml: true });
    }
  };
  render();
  item.show();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const poll = async () => {
    try {
      const found = await readLogs(session, logs);
      // A Copilot Chat channel created after the switch would start at the old level, so wait until
      // this extension host's channel has written to the log.
      if (trace === undefined && ownLogWritten()) trace = await enableTrace();
      // A reading older than the latest saved one was saved when it was new. Read again without an account
      // line of its own, as from a log Copilot Chat emptied, it would take a guessed account.
      const latestSaved = Math.max(0, ...Object.values(records).map((readings) => readings.at(-1)!.at));
      const fresh = found.filter(({ login, reading }) => login !== undefined || reading.at > latestSaved);
      records = addReadings(records, assignAccounts(fresh, logs.logins, currentAccount(records)), Date.now());
      const json = JSON.stringify(records);
      if (json !== saved) {
        await saveRecords(recordsFile, json);
        saved = json;
      }
    } catch {
      // The next poll tries again; the numbers shown stay.
    }
    // The debug-log scan can take seconds, so the numbers show first; new model use shows next poll.
    render();
    try {
      if (Date.now() - scanned >= SCAN_MS) {
        scanned = Date.now();
        if (await scanDebugLogs(user, tally, read, scanned)) {
          await context.globalState.update(MODELS_KEY, saveTally(tally));
        }
      }
    } catch {
      // The next scan tries again.
    }
    if (!disposed) timer = setTimeout(poll, POLL_MS);
  };
  void poll();

  context.subscriptions.push(item, new vscode.Disposable(() => {
    disposed = true;
    clearTimeout(timer);
  }));
}

/** The saved readings; none while the file is missing or unreadable. */
function readRecords(file: string): Records {
  try {
    return loadRecords(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/** Writes a new file and renames it over the old one, so a window that starts meanwhile never reads half of it. */
async function saveRecords(file: string, json: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}`;
  await writeFile(temp, json);
  await rename(temp, file);
}

/** The old build's history and caches. Old windows still running recreate them until they reload. */
async function removeOldData(context: vscode.ExtensionContext): Promise<void> {
  const storage = context.globalStorageUri.fsPath;
  await Promise.all(['account-tracking', 'quota-history.jsonl', 'scan-cache'].map((name) =>
    rm(join(storage, name), { recursive: true, force: true }).catch(() => undefined)));
  if (context.globalState.get('copilotUsage.sortMode') !== undefined) {
    await context.globalState.update('copilotUsage.sortMode', undefined);
  }
}

/**
 * Model use comes from Copilot's debug logs, which a window writes from its next start after the
 * first setting is on, and from VS Code's agent session usage logs, written at once after the
 * second. Each setting is turned on once: a user value, on or off, stays, and so does a later
 * change, which the Settings editor saves as no value when it matches the default of off.
 * Resolves to whether it turned the first one on.
 */
export async function enableDebugLog(state: vscode.Memento): Promise<boolean> {
  let copilotTurnedOn = false;
  for (const setting of ['github.copilot.chat.agentDebugLog.fileLogging.enabled', 'chat.agentHost.agentDebugLog.enabled']) {
    const done = state.get<string[]>(DEBUG_LOGS_KEY) ?? [];
    if (done.includes(setting)) continue;
    try {
      const settings = vscode.workspace.getConfiguration();
      if (settings.inspect(setting)?.globalValue === undefined) {
        await settings.update(setting, true, vscode.ConfigurationTarget.Global);
        if (setting.startsWith('github.')) copilotTurnedOn = true;
      }
      await state.update(DEBUG_LOGS_KEY, [...done, setting]);
    } catch {
      // Model use misses these logs until the user turns the setting on.
    }
  }
  return copilotTurnedOn;
}

/**
 * Copilot Chat logs quota only at Trace. VS Code saves the default in argv.json, which every window
 * reads at VS Code's next start, and switches this window's running Copilot Chat channel at once.
 * An existing Copilot entry is Trace already or the user's own choice, so it stays. Resolves to
 * `switched`, to `kept` for a Trace entry, and to `other` for an entry of another level or a failed
 * switch, which a restart would not change. VS Code reads only lowercase levels.
 */
export async function enableTrace(): Promise<'switched' | 'kept' | 'other'> {
  try {
    const portable = process.env.VSCODE_PORTABLE;
    const argv = portable
      ? join(portable, 'argv.json')
      : join(homedir(), JSON.parse(await readFile(join(vscode.env.appRoot, 'product.json'), 'utf8')).dataFolderName, 'argv.json');
    const level = copilotLogLevel(await readFile(argv, 'utf8').catch(() => ''));
    if (level !== undefined) return level === 'trace' ? 'kept' : 'other';
    await vscode.commands.executeCommand('workbench.action.setDefaultLogLevel', vscode.LogLevel.Trace, 'github.copilot-chat');
    return 'switched';
  } catch {
    // Copilot Chat keeps its level.
    return 'other';
  }
}

/** The level of argv.json's `github.copilot-chat` log-level entry, if it has one. argv.json allows comments. */
export function copilotLogLevel(argv: string): string | undefined {
  for (const [, text] of argv.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"\\\n]|\\.)*)"/g)) {
    const level = /^github\.copilot-chat[:=](.+)/i.exec(text ?? '')?.[1];
    if (level) return level;
  }
}
