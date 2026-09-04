import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const watchers = vi.hoisted(
  () =>
    [] as Array<{
      pattern: { baseUri: { fsPath: string }; pattern: string };
      handlers: Array<() => void>;
    }>,
);

vi.mock('vscode', () => ({
  EventEmitter: class {
    private readonly listeners: Array<() => void> = [];

    readonly event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };

    fire(): void {
      for (const listener of [...this.listeners]) {
        listener();
      }
    }

    dispose(): void {
      this.listeners.length = 0;
    }
  },
  RelativePattern: class {
    constructor(
      readonly baseUri: { fsPath: string },
      readonly pattern: string,
    ) {}
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: {
    createFileSystemWatcher: (pattern: { baseUri: { fsPath: string }; pattern: string }) => {
      const handlers: Array<() => void> = [];
      watchers.push({ pattern, handlers });
      const subscribe = (handler: () => void) => {
        handlers.push(handler);
        return { dispose: () => undefined };
      };
      return { onDidCreate: subscribe, onDidChange: subscribe, dispose: () => undefined };
    },
  },
}));

const { copilotChatLogPath, CopilotAccountWatcher, lastLoginInLog } = await import(
  '../src/core/copilotAccount'
);

const READ_DELAY_MS = 500;

function line(login: string, level = 'info'): string {
  return `2026-09-04 11:36:12.345 [${level}] Logged in as ${login}\n`;
}

describe('lastLoginInLog', () => {
  it('returns the login Copilot Chat logged last', () => {
    const text = `${line('octocat')}2026-09-04 11:36:13.000 [info] Got Copilot token for octocat\n${line('hubot')}`;

    expect(lastLoginInLog(text)).toBe('hubot');
    expect(lastLoginInLog('2026-09-04 11:36:12.345 [info] activationBlocker from 0ms\n')).toBeUndefined();
  });
});

describe('copilotChatLogPath', () => {
  it('points at the Copilot Chat log beside this extension log folder', () => {
    const extensionLog = join('logs', 'window1', 'exthost', 'leonbjorklund.copilot-usage-extension');

    expect(copilotChatLogPath(extensionLog)).toBe(
      join('logs', 'window1', 'exthost', 'GitHub.copilot-chat', 'GitHub Copilot Chat.log'),
    );
  });
});

describe('CopilotAccountWatcher', () => {
  const roots: string[] = [];
  let extensionLog: string;
  let copilotLog: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    watchers.length = 0;
    const root = await mkdtemp(join(tmpdir(), 'copilot-usage-account-'));
    roots.push(root);
    extensionLog = join(root, 'exthost', 'leonbjorklund.copilot-usage-extension');
    copilotLog = join(root, 'exthost', 'GitHub.copilot-chat', 'GitHub Copilot Chat.log');
    await mkdir(join(root, 'exthost', 'GitHub.copilot-chat'), { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function logWritten(): Promise<void> {
    for (const handler of watchers[0].handlers) {
      handler();
    }
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS);
  }

  it('reads the login at start and watches the Copilot Chat log folder', async () => {
    await writeFile(copilotLog, `${line('octocat')}${line('hubot')}`);

    const watcher = new CopilotAccountWatcher(extensionLog);

    expect(await watcher.currentLogin()).toBe('hubot');
    expect(watchers[0].pattern).toEqual({
      baseUri: { fsPath: join(roots[0], 'exthost', 'GitHub.copilot-chat') },
      pattern: 'GitHub Copilot Chat.log',
    });
    watcher.dispose();
  });

  it('reads a log with Windows line endings, which is what VS Code writes', async () => {
    const crlf = (login: string) => line(login).replace('\n', '\r\n');
    await writeFile(copilotLog, crlf('octocat'));
    const watcher = new CopilotAccountWatcher(extensionLog);
    expect(await watcher.currentLogin()).toBe('octocat');

    await appendFile(copilotLog, crlf('hubot'));
    await logWritten();

    expect(await watcher.currentLogin()).toBe('hubot');
    watcher.dispose();
  });

  it('fires once when Copilot switches account and not for other log lines', async () => {
    await writeFile(copilotLog, line('octocat'));
    const watcher = new CopilotAccountWatcher(extensionLog);
    const changes = vi.fn();
    watcher.onDidChange(changes);
    await watcher.currentLogin();
    // The first login found counts as a change, so a quota read that started
    // before the log was written catches up.
    expect(changes).toHaveBeenCalledTimes(1);

    await appendFile(copilotLog, '2026-09-04 11:40:00.000 [info] ccreq:abc | success\n');
    await logWritten();
    await watcher.currentLogin();
    expect(changes).toHaveBeenCalledTimes(1);

    await appendFile(copilotLog, line('hubot'));
    await logWritten();
    expect(await watcher.currentLogin()).toBe('hubot');
    expect(changes).toHaveBeenCalledTimes(2);

    // Copilot logging the same account again is not a switch.
    await appendFile(copilotLog, line('hubot'));
    await logWritten();
    await watcher.currentLogin();
    expect(changes).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it('waits for a line that is still being written', async () => {
    await writeFile(copilotLog, line('octocat'));
    const watcher = new CopilotAccountWatcher(extensionLog);
    await watcher.currentLogin();

    const next = line('hubot');
    await appendFile(copilotLog, next.slice(0, -4));
    await logWritten();
    expect(await watcher.currentLogin()).toBe('octocat');

    await appendFile(copilotLog, next.slice(-4));
    await logWritten();
    expect(await watcher.currentLogin()).toBe('hubot');
    watcher.dispose();
  });

  it('starts over when the log is replaced by a shorter one', async () => {
    await writeFile(copilotLog, `${line('octocat')}${line('octocat')}${line('octocat')}`);
    const watcher = new CopilotAccountWatcher(extensionLog);
    await watcher.currentLogin();

    await writeFile(copilotLog, line('hubot'));
    await logWritten();

    expect(await watcher.currentLogin()).toBe('hubot');
    watcher.dispose();
  });

  it('reports no login while Copilot Chat has written no log', async () => {
    const watcher = new CopilotAccountWatcher(extensionLog);

    expect(await watcher.currentLogin()).toBeUndefined();

    await writeFile(copilotLog, line('octocat'));
    await logWritten();
    expect(await watcher.currentLogin()).toBe('octocat');
    watcher.dispose();
  });

  it('drops a pending read when disposed', async () => {
    await writeFile(copilotLog, line('octocat'));
    const watcher = new CopilotAccountWatcher(extensionLog);
    await watcher.currentLogin();

    for (const handler of watchers[0].handlers) {
      handler();
    }
    watcher.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
