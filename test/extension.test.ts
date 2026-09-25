import { access, appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { item, executeCommand, env, theme, configuration } = vi.hoisted(() => {
  let text = '';
  let tooltip: unknown;
  return {
    item: {
      /** Counts text and tooltip assignments; each one sends the window an update. */
      sets: 0,
      get text() { return text; },
      set text(value: string) { text = value; this.sets++; },
      get tooltip() { return tooltip; },
      set tooltip(value: unknown) { tooltip = value; this.sets++; },
      show: vi.fn(),
      dispose: vi.fn(),
    },
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
    env: { appRoot: '' },
    theme: { kind: 2 },
    configuration: {
      inspect: vi.fn((_key: string): { globalValue?: boolean } | undefined => ({})),
      update: vi.fn(async (..._args: unknown[]) => undefined),
    },
  };
});

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  LogLevel: { Off: 0, Trace: 1 },
  Disposable: class {
    constructor(private readonly callback: () => void) {}
    dispose() { this.callback(); }
  },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  MarkdownString: class {
    supportHtml = false;
    constructor(public value: string, public supportThemeIcons: boolean) {}
  },
  window: {
    createStatusBarItem: vi.fn(() => item),
    get activeColorTheme() { return { kind: theme.kind }; },
  },
  commands: { executeCommand },
  workspace: { getConfiguration: vi.fn(() => configuration) },
  ConfigurationTarget: { Global: 1 },
  env,
}));

import * as vscode from 'vscode';

import { activate, enableDebugLog, enableTrace, hasCopilotLogLevel } from '../src/extension';
import { DARK, hoverMarkdown, LIGHT } from '../src/hover';

const RESET = '2026-10-01T00:00:00.000Z';
const FAR_RESET = '2999-01-01T00:00:00.000Z';
const roots: string[] = [];
const contexts: Array<{ subscriptions: Array<{ dispose(): void }> }> = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) for (const subscription of context.subscriptions) subscription.dispose();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  item.text = '';
  item.tooltip = undefined;
  item.sets = 0;
  theme.kind = 2;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copilot-credits-'));
  roots.push(root);
  return root;
}

interface Start {
  records?: unknown;
  /** This window's Copilot Chat log; `null` leaves it missing. */
  logs?: string | null;
  /** The log's modification time, to look written before this extension host started. */
  modified?: Date;
  argv?: string;
  storage?: string;
  state?: { [key: string]: unknown };
  /** Chats' debug logs, by their path under the VS Code user folder. */
  debugLogs?: { [path: string]: string };
  /** The profile folder under the VS Code user folder, like `profiles/builtin/agents`. */
  profile?: string;
}

async function start(options: Start = {}) {
  const root = await folder();
  for (const [path, text] of Object.entries(options.debugLogs ?? {})) {
    await mkdir(join(root, 'User', path, '..'), { recursive: true });
    await writeFile(join(root, 'User', path), text);
  }
  const session = join(root, 'logs', '20260923T093308');
  const copilot = join(session, 'window1', 'exthost', 'GitHub.copilot-chat');
  const log = join(copilot, 'GitHub Copilot Chat.log');
  await mkdir(copilot, { recursive: true });
  if (options.logs !== null) await writeFile(log, options.logs ?? '');
  if (options.modified) await utimes(log, options.modified, options.modified);
  env.appRoot = join(root, 'app');
  vi.stubEnv('VSCODE_PORTABLE', root);
  await writeFile(join(root, 'argv.json'), options.argv ?? '{ "log-level": ["github.copilot-chat=trace"] }');
  const state = new Map<string, unknown>(Object.entries(options.state ?? {}));
  if (options.records) state.set('records', options.records);
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    globalStorageUri: { fsPath: options.storage ??
      join(root, 'User', options.profile ?? '', 'globalStorage', 'leonbjorklund.copilot-usage-extension') },
    logUri: { fsPath: join(session, 'window1', 'exthost', 'leonbjorklund.copilot-usage-extension') },
    globalState: {
      get: (key: string) => state.get(key),
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      }),
    },
  };
  contexts.push(context);
  activate(context as unknown as vscode.ExtensionContext);
  return { state, log, context, root };
}

function reading(at: number, percentRemaining: number, resetDate = RESET) {
  return { at, quota: 80000, percentRemaining, resetDate, unlimited: false };
}

/** A log line stamped in local time, `offset` ms from now. */
function line(message: string, offset = 0): string {
  const date = new Date(Date.now() + offset);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ${message}\r\n`;
}

const quota = (percentRemaining: number, offset = 0) => line(`[trace] [ChatQuota] processQuotaHeaders: ${JSON.stringify({
  quota: 80000, unlimited: false, hasQuota: true, percentRemaining, additionalUsageUsed: 0, additionalUsageEnabled: true,
  resetDate: FAR_RESET })}`, offset);

const exists = (path: string) => access(path).then(() => true, () => false);
const hover = () => (item.tooltip as { value: string } | undefined)?.value ?? '';

/** Fakes the clock and the timer between polls, so `nextPoll` runs a poll at once instead of 2 seconds later. */
const fakeTimers = (now = new Date()) => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now });
/** Waits until the running poll has finished and set the timer for the next one. */
const settled = () => vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
/** Waits for the running poll, then runs the next one to its end. */
async function nextPoll(): Promise<void> {
  await settled();
  await vi.advanceTimersByTimeAsync(2000);
  await settled();
}

describe('status bar', () => {
  it('shows the saved numbers and their hover at once, on the right', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 23, 16));
    const records = { leon: [
      reading(new Date(2026, 8, 22, 23).getTime(), 26.6), reading(new Date(2026, 8, 23, 15).getTime(), 23.5),
    ] };
    await start({ records });
    expect(item.text).toBe('3.1% • 76.5/100%');
    expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(vscode.StatusBarAlignment.Right, 100.05);
    expect(item.show).toHaveBeenCalled();
    expect(item.tooltip).toEqual({ value: hoverMarkdown(records, Date.now(), DARK, []), supportThemeIcons: true, supportHtml: true });
  });

  it('draws the graph in light colors for light themes, and follows a theme change', async () => {
    fakeTimers(new Date(2026, 8, 23, 16));
    const records = { leon: [reading(new Date(2026, 8, 23, 15).getTime(), 23.5)] };
    theme.kind = 4;
    await start({ records });
    expect(hover()).toBe(hoverMarkdown(records, Date.now(), LIGHT, []));
    theme.kind = 3;
    await nextPoll();
    expect(hover()).toBe(hoverMarkdown(records, Date.now(), DARK, []));
    theme.kind = 1;
    await nextPoll();
    expect(hover()).toBe(hoverMarkdown(records, Date.now(), LIGHT, []));
  });

  it('removes the hover once every saved reading is older than 35 days', async () => {
    fakeTimers(new Date(2026, 8, 23, 16));
    await start({ records: { leon: [reading(new Date(2026, 8, 23, 15).getTime(), 23.5)] } });
    expect(item.tooltip).toBeDefined();
    vi.setSystemTime(new Date(2026, 9, 30, 16));
    await nextPoll();
    expect(item.text).toBe('Waiting for Copilot');
    expect(item.tooltip).toBeUndefined();
  });

  it("asks for a restart while this window's Copilot Chat channel writes no Trace lines", async () => {
    fakeTimers();
    const { log } = await start({ logs: line('[info] Logged in as leon-work') });
    await vi.waitFor(() => expect(item.text).toBe('Restart to see Credit usage'));
    await appendFile(log, line('[trace] detail'));
    await nextPoll();
    expect(item.text).toBe('Waiting for Copilot');
  });

  it('keeps asking for a restart when the only Trace lines came before this extension host started', async () => {
    await start({ logs: line('[trace] before a reload', -86_400_000) + line('[info] after the reload') });
    await vi.waitFor(() => expect(item.text).toBe('Restart to see Credit usage'));
  });

  it('names readings from a log without account lines after the saved account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 23, 16));
    const now = Date.now();
    const saved = reading(now - 86_400_000, 26.6, FAR_RESET);
    const { state } = await start({ records: { leon: [saved] }, logs: quota(23.5) });
    await vi.waitFor(() => expect(item.text).toBe('3.1% • 76.5/100%'));
    expect(state.get('records')).toEqual({ leon: [saved, reading(now, 23.5, FAR_RESET)] });
  });

  it('keeps polling after a failed save', async () => {
    fakeTimers(new Date(2026, 8, 23, 16));
    const { log, context } = await start({ logs: line('[info] Got Copilot token for leon-work', -2000) + quota(26.6, -1000) });
    context.globalState.update.mockRejectedValueOnce(new Error('storage closed'));
    await vi.waitFor(() => expect(item.text).toBe('0% • 73.4/100%'));
    await appendFile(log, quota(26.5));
    await nextPoll();
    expect(item.text).toBe('0.1% • 73.5/100%');
  });

  it('saves and redraws only on a change, and stops polling once disposed', async () => {
    fakeTimers();
    const { log, context } = await start({ logs: line('[info] Got Copilot token for leon-work') + quota(26.6) });
    await vi.waitFor(() => expect(item.text).toBe('0% • 73.4/100%'));
    expect(context.globalState.update).toHaveBeenCalledOnce();
    const sets = item.sets;
    await nextPoll();
    expect(context.globalState.update).toHaveBeenCalledOnce();
    expect(item.sets).toBe(sets);
    for (const subscription of context.subscriptions) subscription.dispose();
    await appendFile(log, quota(26.5));
    expect(vi.getTimerCount()).toBe(0);
    expect(context.globalState.update).toHaveBeenCalledOnce();
  });

  it('stops a poll that is running when disposed', async () => {
    fakeTimers();
    const request = JSON.stringify({ ts: Date.now(), spanId: '1', type: 'llm_request', attrs: { model: 'm', copilotUsageNanoAiu: 1e9 } });
    const { context } = await start({ debugLogs: { [join('workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', 'a', 'main.jsonl')]: `${request}\n` } });
    for (const subscription of context.subscriptions) subscription.dispose();
    // The running poll ends by saving what its debug-log scan counted.
    await vi.waitFor(() => expect(context.globalState.update).toHaveBeenCalledWith('models', expect.anything()));
    await new Promise((resolve) => setImmediate(resolve));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('old data', () => {
  it('removes the old build\'s stored data and nothing else', async () => {
    const storage = join(await folder(), 'globalStorage');
    for (const path of ['account-tracking/ledger.jsonl', 'scan-cache/usage-index.cache']) {
      await mkdir(join(storage, path, '..'), { recursive: true });
      await writeFile(join(storage, path), 'old');
    }
    await writeFile(join(storage, 'quota-history.jsonl'), 'old');
    await writeFile(join(storage, 'keep.json'), 'new');
    const { state } = await start({ storage, state: { 'copilotUsage.sortMode': 'cost', other: 'kept' } });
    await vi.waitFor(async () => {
      for (const name of ['account-tracking', 'scan-cache', 'quota-history.jsonl']) {
        expect(await exists(join(storage, name))).toBe(false);
      }
      expect(state.has('copilotUsage.sortMode')).toBe(false);
    });
    expect(await exists(join(storage, 'keep.json'))).toBe(true);
    expect(state.get('other')).toBe('kept');
  });
});

describe('Trace setup', () => {
  async function argv(text?: string): Promise<void> {
    const root = await folder();
    vi.stubEnv('VSCODE_PORTABLE', root);
    if (text !== undefined) await writeFile(join(root, 'argv.json'), text);
  }

  it('sets Copilot Chat\'s default log level to Trace when argv.json has no Copilot entry', async () => {
    const texts = [undefined, '{}',
      '{\n  // "log-level": ["github.copilot-chat=info"]\n  "log-level": ["debug", "my.github.copilot-chat=info"]\n}'];
    for (const text of texts) {
      executeCommand.mockClear();
      await argv(text);
      expect(await enableTrace()).toBe(true);
      expect(executeCommand).toHaveBeenCalledExactlyOnceWith('workbench.action.setDefaultLogLevel', 1, 'github.copilot-chat');
    }
  });

  it('leaves an existing Copilot entry alone', async () => {
    for (const level of ['trace', 'info', 'off']) {
      await argv(`{ /* comment */ "log-level": ["warn", "GitHub.copilot-chat=${level}"], }`);
      expect(await enableTrace()).toBe(false);
    }
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reads argv.json from the home folder that product.json names outside portable mode', async () => {
    const home = await folder();
    const app = await folder();
    env.appRoot = app;
    await writeFile(join(app, 'product.json'), JSON.stringify({ dataFolderName: '.copilot-credits-test' }));
    await mkdir(join(home, '.copilot-credits-test'));
    await writeFile(join(home, '.copilot-credits-test', 'argv.json'), '{ "log-level": ["github.copilot-chat=info"] }');
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('VSCODE_PORTABLE', '');
    expect(await enableTrace()).toBe(false);
    expect(executeCommand).not.toHaveBeenCalled();
    await rm(join(home, '.copilot-credits-test', 'argv.json'));
    expect(await enableTrace()).toBe(true);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith('workbench.action.setDefaultLogLevel', 1, 'github.copilot-chat');
  });

  it('shrugs off a rejected switch', async () => {
    await argv('{}');
    executeCommand.mockRejectedValueOnce(new Error('argv.json has errors'));
    await expect(enableTrace()).resolves.toBe(false);
  });

  it("switches once, after this window's Copilot Chat channel writes its log", async () => {
    fakeTimers();
    const { log } = await start({ logs: null, argv: '{}' });
    await settled();
    expect(executeCommand).not.toHaveBeenCalled();
    await writeFile(log, line('[info] started'));
    await nextPoll();
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith('workbench.action.setDefaultLogLevel', 1, 'github.copilot-chat');
    // The window that switched shows no restart prompt, not even until its next poll.
    expect(item.text).toBe('Waiting for Copilot');
    await nextPoll();
    expect(executeCommand).toHaveBeenCalledOnce();
    expect(item.text).toBe('Waiting for Copilot');
  });

  it('saves Trace for the next start even when this window already logs at Trace', async () => {
    await start({ logs: line('[trace] detail'), argv: '{}' });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledExactlyOnceWith(
      'workbench.action.setDefaultLogLevel', 1, 'github.copilot-chat'));
  });

  it('waits after a reload until the new Copilot Chat channel writes to the old log', async () => {
    fakeTimers();
    const hourAgo = new Date(Date.now() - 3_600_000);
    const { log } = await start({ logs: line('[info] before the reload', -3_600_000), modified: hourAgo, argv: '{}' });
    await settled();
    expect(executeCommand).not.toHaveBeenCalled();
    await appendFile(log, line('[info] after the reload'));
    await nextPoll();
    expect(executeCommand).toHaveBeenCalledOnce();
  });

  it('reads the entry past comments and escaped quotes', () => {
    expect(hasCopilotLogLevel('{ "log-level": "github.copilot-chat:debug" }')).toBe(true);
    expect(hasCopilotLogLevel('{ /* "github.copilot-chat=off" */ "url": "https://example.com//x" }')).toBe(false);
    expect(hasCopilotLogLevel('{ "log-level": ["my.github.copilot-chat=info"] }')).toBe(false);
    expect(hasCopilotLogLevel('{ "enable-proposed-api": ["GitHub.copilot-chat"] }')).toBe(false);
    expect(hasCopilotLogLevel('{ "log-level": ["github.copilot-chat="] }')).toBe(false);
    expect(hasCopilotLogLevel('')).toBe(false);
    expect(hasCopilotLogLevel(String.raw`{ "x": "a // b \" c", "log-level": ["github.copilot-chat=info"] }`)).toBe(true);
  });
});

describe('model use', () => {
  const request = (credits: number, model = 'claude-opus-5') => `${JSON.stringify({ ts: Date.now(), spanId: '0000000000000001',
    type: 'llm_request', attrs: { model, copilotUsageNanoAiu: credits * 1e9 } })}\n`;
  const chat = (name: string) => join('workspaceStorage', 'abc', 'GitHub.copilot-chat', 'debug-logs', name, 'main.jsonl');

  it("turns on Copilot's and VS Code's agent debug logs, leaving each setting the user set", async () => {
    const [copilot, agentHost] = ['github.copilot.chat.agentDebugLog.fileLogging.enabled', 'chat.agentHost.agentDebugLog.enabled'];
    await enableDebugLog();
    // Full setting names only work on the unsectioned configuration.
    expect(vi.mocked(vscode.workspace.getConfiguration).mock.calls).toEqual([[], []]);
    expect(configuration.inspect.mock.calls).toEqual([[copilot], [agentHost]]);
    expect(configuration.update.mock.calls).toEqual([[copilot, true, 1], [agentHost, true, 1]]);
    configuration.update.mockClear();
    configuration.inspect.mockReturnValueOnce({ globalValue: false });
    await enableDebugLog();
    expect(configuration.update.mock.calls).toEqual([[agentHost, true, 1]]);
    configuration.update.mockClear();
    configuration.inspect.mockReturnValueOnce({}).mockReturnValueOnce({ globalValue: true });
    await enableDebugLog();
    expect(configuration.update.mock.calls).toEqual([[copilot, true, 1]]);
    // A setting that fails to save leaves the other one.
    configuration.update.mockClear();
    configuration.update.mockRejectedValueOnce(new Error('settings.json has errors'));
    await expect(enableDebugLog()).resolves.toBeUndefined();
    expect(configuration.update.mock.calls).toEqual([[copilot, true, 1], [agentHost, true, 1]]);
  });

  it('counts debug-log requests into a saved tally that a restart shows at once', async () => {
    fakeTimers();
    const records = { leon: [reading(Date.now() - 1000, 23.5)] };
    const first = await start({ records, debugLogs: { [chat('a')]: request(4) } });
    expect(configuration.update).toHaveBeenCalledWith('github.copilot.chat.agentDebugLog.fileLogging.enabled', true, 1);
    const section = '<tr><td>1. claude-opus-5</td><td align="right">1 session · 100%</td></tr>';
    await nextPoll();
    expect(hover()).toContain(section);
    const saved = first.state.get('models');
    for (const subscription of first.context.subscriptions) subscription.dispose();
    item.tooltip = undefined;
    await start({ records, state: { models: JSON.parse(JSON.stringify(saved)) } });
    expect(hover()).toContain(section);
  });

  it('finds every folder\'s chats from another profile, and that profile\'s chats without a folder', async () => {
    fakeTimers();
    const profile = join('profiles', 'builtin', 'agents');
    await start({ records: { leon: [reading(Date.now() - 1000, 23.5)] }, profile, debugLogs: {
      [chat('a')]: request(4),
      [join(profile, 'globalStorage', 'github.copilot-chat', 'debug-logs', 'b', 'main.jsonl')]: request(1, 'gpt-6-astra'),
    } });
    await nextPoll();
    expect(hover()).toContain('<tr><td>1. claude-opus-5</td><td align="right">1 session · 80%</td></tr>');
    expect(hover()).toContain('<tr><td>2. gpt-6-astra</td><td align="right">1 session · 20%</td></tr>');
  });

  it('reads new debug-log lines on a later scan, and keeps polling after a failed save', async () => {
    fakeTimers();
    const { root, log, context } = await start({ logs: line('[info] Got Copilot token for leon-work', -2000) +
      quota(26.6, -1000), debugLogs: { [chat('a')]: request(4) } });
    context.globalState.update.mockImplementation(async (key: string) => {
      if (key === 'models') throw new Error('storage closed');
    });
    await nextPoll();
    expect(hover()).toContain('1. claude-opus-5');
    await mkdir(join(root, 'User', chat('b'), '..'), { recursive: true });
    await writeFile(join(root, 'User', chat('b')), request(4, 'gpt-6-astra'));
    await appendFile(log, quota(26.5));
    await nextPoll();
    await nextPoll();
    expect(item.text).toBe('0.1% • 73.5/100%');
    expect(hover()).not.toContain('gpt-6-astra');
    // The scan runs every 10 seconds, and its counts show from the next poll.
    vi.setSystemTime(Date.now() + 10_000);
    await nextPoll();
    await nextPoll();
    expect(hover()).toContain('2. gpt-6-astra');
  });
});
