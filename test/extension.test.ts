import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  locateCopilotDataPaths,
  readConfig,
  usageIndexInstances,
  watcherRegistrations,
  state,
} = vi.hoisted(() => ({
  locateCopilotDataPaths: vi.fn(),
  readConfig: vi.fn(),
  usageIndexInstances: [] as Array<{
    restore: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    rebuild: ReturnType<typeof vi.fn>;
    poll: ReturnType<typeof vi.fn>;
    applyChanges: ReturnType<typeof vi.fn>;
    getWatchFolders: ReturnType<typeof vi.fn>;
  }>,
  watcherRegistrations: [] as Array<{
    pattern: unknown;
    watcher: {
      dispose: ReturnType<typeof vi.fn>;
    };
    handlers: {
      change: Array<(uri: { fsPath: string }) => void>;
      create: Array<(uri: { fsPath: string }) => void>;
      delete: Array<(uri: { fsPath: string }) => void>;
    };
  }>,
  state: {
    usageIndexResult: undefined as unknown,
    restoredResult: undefined as unknown,
    pollResults: [] as unknown[],
    rebuildResults: [] as unknown[],
    watchFolders: [] as string[],
    copilotFileLoggingEnabled: true,
  },
}));

vi.mock("vscode", () => ({
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  MarkdownString: class {
    isTrusted?: boolean | { enabledCommands: string[] };
    supportHtml?: boolean;
    supportThemeIcons?: boolean;

    constructor(
      public value: string,
      supportThemeIcons?: boolean,
    ) {
      this.supportThemeIcons = supportThemeIcons;
    }

    appendMarkdown(value: string): this {
      this.value += value;
      return this;
    }
  },
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath, scheme: "file" })),
  },
  RelativePattern: class {
    constructor(
      readonly baseUri: { fsPath: string },
      readonly pattern: string,
    ) {}
  },
  StatusBarAlignment: {
    Right: 2,
  },
  EventEmitter: class {
    private readonly listeners: Array<(value: unknown) => void> = [];
    event = (listener: (value: unknown) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire = (value?: unknown) => {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    };
    dispose = vi.fn();
  },
  ThemeIcon: class {
    constructor(readonly id: string) {}
  },
  authentication: {
    getSession: vi.fn(async () => undefined),
    getAccounts: vi.fn(async () => []),
    onDidChangeSessions: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    activeColorTheme: { kind: 2 },
    onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
    createStatusBarItem: vi.fn(),
    registerTreeDataProvider: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(),
  },
  workspace: {
    onDidChangeConfiguration: vi.fn(),
    createFileSystemWatcher: vi.fn((pattern: unknown) => {
      const handlers = { change: [], create: [], delete: [] } as {
        change: Array<(uri: { fsPath: string }) => void>;
        create: Array<(uri: { fsPath: string }) => void>;
        delete: Array<(uri: { fsPath: string }) => void>;
      };
      const watcher = {
        onDidChange: vi.fn((callback: (uri: { fsPath: string }) => void) => {
          handlers.change.push(callback);
          return { dispose: vi.fn() };
        }),
        onDidCreate: vi.fn((callback: (uri: { fsPath: string }) => void) => {
          handlers.create.push(callback);
          return { dispose: vi.fn() };
        }),
        onDidDelete: vi.fn((callback: (uri: { fsPath: string }) => void) => {
          handlers.delete.push(callback);
          return { dispose: vi.fn() };
        }),
        dispose: vi.fn(),
      };
      watcherRegistrations.push({ pattern, watcher, handlers });
      return watcher;
    }),
    getConfiguration: vi.fn(() => ({
      get: vi.fn((setting: string, fallback: unknown) =>
        setting === "github.copilot.chat.agentDebugLog.fileLogging.enabled"
          ? state.copilotFileLoggingEnabled
          : fallback,
      ),
    })),
  },
  Disposable: class {
    constructor(readonly dispose: () => void) {}
  },
}));

import * as vscode from "vscode";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

vi.mock("../src/core/locator", () => ({ locateCopilotDataPaths }));
vi.mock("../src/core/quotaLogging", () => ({
  enableQuotaLogging: vi.fn(async () => ({ requested: true, reason: "Copilot Trace saved." })),
}));
vi.mock("../src/core/config", () => ({
  COPILOT_FILE_LOGGING_SETTING: "github.copilot.chat.agentDebugLog.fileLogging.enabled",
  isCopilotFileLoggingEnabled: vi.fn(() => state.copilotFileLoggingEnabled),
  readConfig,
}));
vi.mock("../src/core/usageIndex", () => ({
  UsageIndex: vi.fn().mockImplementation(function () {
    const instance = {
      restore: vi.fn(() => Promise.resolve(state.restoredResult)),
      save: vi.fn(async () => {}),
      rebuild: vi.fn(() => Promise.resolve(state.rebuildResults.shift() ?? state.usageIndexResult)),
      poll: vi.fn(() => Promise.resolve(state.pollResults.shift() ?? state.usageIndexResult)),
      applyChanges: vi.fn(() => Promise.resolve(state.usageIndexResult)),
      getWatchFolders: vi.fn(() => state.watchFolders),
    };
    usageIndexInstances.push(instance);
    return instance;
  }),
}));

import type {
  ChatUsageSummary,
  CopilotCostEstimate,
  ExtensionConfig,
  UsageDiagnostics,
  UsageRecord,
  UsageSummary,
} from "../src/core/types";
import { activate, formatStatusBarSummary, formatStatusBarTooltip } from "../src/extension";
import { aggregateUsage } from "../src/core/aggregator";
import { dailyUsage } from "../src/core/quotaHistory";
import { CopilotQuotaService } from "../src/core/quotaService";
import { AccountUsagePoc } from "../src/dev/accountUsagePoc";
import type { UsageNode } from "../src/ui/usageTreeProvider";

const activatedContexts: vscode.ExtensionContext[] = [];

describe("formatStatusBarTooltip", () => {
  it("renders account credit use and timestamp-based projection together after today's sessions", () => {
    const observedAt = Date.parse('2026-09-16T00:00:00Z');
    const quotaState = {
      kind: 'quota' as const, account: 'octocat', observedAt,
      quota: { entitlement: 60_000, percentRemaining: 72.4, unlimited: false, hasQuota: true,
        resetDate: new Date('2026-10-01T00:00:00Z') },
    };
    const tooltip = formatStatusBarTooltip(createEmptySummary(), quotaState, observedAt);
    const text = tooltip.value.replaceAll('&nbsp;', ' ');
    expect(text).toContain('27.6% / 100%  (16\u00a0560 / 60\u00a0000 credits)');
    expect(text).toContain('<td align="right">  1.84% / day · 55.2% monthly pace</td>');
    expect(text.indexOf('Monthly Credits')).toBeGreaterThan(text.indexOf('Top sessions today'));
    const oldMonth = formatStatusBarTooltip(createEmptySummary(), quotaState, Date.parse('2026-10-01T00:00:00Z'));
    expect(oldMonth.value.replaceAll('&nbsp;', ' ')).toContain('27.6% / 100%  (16\u00a0560 / 60\u00a0000 credits)');
    expect(oldMonth.value.replaceAll('&nbsp;', ' ')).toContain('Pace unavailable');
    const tiny = formatStatusBarTooltip(createEmptySummary(), {
      ...quotaState, quota: { ...quotaState.quota, percentRemaining: 99.9999 },
    }, observedAt);
    expect(tiny.value).toContain('&lt;1');
  });

  it("draws the daily usage graph beneath Monthly Credits only when history is supplied", () => {
    const now = Date.parse('2026-09-16T12:00:00');
    const observations = [4, 6].map((hour) => ({ account: 'octocat', at: Date.parse(`2026-09-16T0${hour}:00:00`),
      percentRemaining: hour === 4 ? 72.4 : 70.4, resetDate: '2026-10-01T00:00:00.000Z' }));
    const history = dailyUsage(observations, now);
    const tooltip = formatStatusBarTooltip(createEmptySummary(), { kind: 'waiting' }, now, history).value;
    const credits = tooltip.indexOf('Monthly Credits');
    expect(credits).toBeGreaterThan(0);
    const graph = tooltip.slice(credits);
    expect(graph.match(/<img /g)).toHaveLength(30);
    expect(graph).toContain('title="16 Sep · 2% recorded · Incomplete"');
    expect(graph).toContain('title="15 Sep · Not tracked"');
    expect(graph).toContain('>18 Aug</span>');
    expect(graph.indexOf('<img ')).toBeGreaterThan(graph.indexOf('Waiting for Copilot quota'));
    // Hover content stays open under the mouse only while it contains a link.
    expect(tooltip).toContain('</a>');
    expect(formatStatusBarTooltip(createEmptySummary(), { kind: 'waiting' }, now).value).not.toContain('<img ');
  });

  it("keeps quota waiting, zero allowance, and unlimited states explicit", () => {
    expect(formatStatusBarTooltip(createEmptySummary()).value.replaceAll('&nbsp;', ' '))
      .toContain('Waiting for Copilot quota');
    for (const [entitlement, unlimited, label] of [
      [0, false, 'Copilot allowance exhausted'], [-1, true, 'Unlimited Copilot quota'],
    ] as const) {
      const tooltip = formatStatusBarTooltip(createEmptySummary(), {
        kind: 'quota', account: 'octocat', observedAt: Date.parse('2026-09-16T00:00:00Z'),
        quota: { entitlement, unlimited, hasQuota: unlimited, percentRemaining: 0 },
      });
      expect(tooltip.value.replaceAll('&nbsp;', ' ')).toContain(label);
      expect(tooltip.value).not.toContain('% monthly pace');
    }
  });

  it("formats expanded status bar tooltip", () => {
    const mostExpensiveSessionToday: ChatUsageSummary = {
      chatId: "chat-3",
      title: "Cost audit",
      model: "Claude opus 4.7",
      timestamp: new Date(2026, 4, 28, 10, 30),
      tokens: 315_586,
      githubCopilot: createCost(4.83),
      records: [],
    };
    const summary: UsageSummary = {
      today: createTotal(1_200_000, 8.4),
      week: createTotal(3_400_000, 18.2),
      month: createTotal(8_900_000, 21.59),
      allTime: createTotal(22_000_000, 42.15),
      topModels: [
        {
          model: "Claude opus 4.6",
          sessions: 12,
          tokens: 5_200_000,
          githubCopilot: createCost(8.4),
        },
        {
          model: "model",
          sessions: 8,
          tokens: 2_100_000,
          githubCopilot: createCost(3.2),
        },
      ],
      highestSessionToday: {
        chatId: "chat-1",
        title: "Feature work",
        model: "Claude opus 4.6",
        timestamp: new Date(2026, 4, 28, 9, 30),
        tokens: 420_000,
        githubCopilot: createCost(2.1),
        records: [],
      },
      mostExpensiveSessionToday,
      chats: [
        {
          chatId: "chat-1",
          title: "Feature work",
          model: "Claude opus 4.6",
          timestamp: new Date(2026, 4, 28, 9, 30),
          tokens: 420_000,
          githubCopilot: createCost(2.1),
          records: [],
        },
        {
          chatId: "chat-2",
          title: "Smaller work",
          model: "model",
          timestamp: new Date(2026, 4, 28, 11, 30),
          tokens: 120_000,
          githubCopilot: createCost(0.8),
          records: [],
        },
      ],
    };

    const tooltip = formatStatusBarTooltip(summary);

    expect(tooltip).toBeInstanceOf(vscode.MarkdownString);
    expect(tooltip.supportHtml).toBe(true);
    expect(tooltip.supportThemeIcons).toBe(true);
    expect(tooltip.value).not.toContain("<pre>");
    expect(formatStatusBarSummary(summary)).toBe("1.2M | 8.4$");
    expect(tooltip.value.startsWith('<table width="430">\n<tr><td align="left"><strong>Today:</strong>')).toBe(true);
    expect(tooltip.value).toContain('</td><td align="right"><a href="https://docs.github.com/en/copilot/');
    expect(tooltip.value).toContain('href="https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals"');
    expect(tooltip.value).toContain('title="USD is estimated from AI Credits using GitHub Copilot usage-based billing">$(info)</a>');
    expect(tooltip.value).not.toContain("Cost is based on");
    expect(tooltip.value).not.toContain("## Today:");
    expect(tooltip.value).not.toContain("Week:");
    expect(tooltip.value).toContain(
      "<strong>Today:</strong> 1.2M (8.4$) &nbsp;|&nbsp; <strong>Month:</strong> 8.9M (21.6$) &nbsp;|&nbsp; <strong>All time:</strong> 22M (42.2$)",
    );
    expect(tooltip.value).toContain("---");
    expect(tooltip.value).toContain('<tr><td colspan="2"><strong>Model use</strong></td></tr>');
    expect(tooltip.value).not.toContain('<strong>Model usage:</strong>');
    expect(tooltip.value).not.toContain('<strong>Top models:</strong>');
    expect(tooltip.value).toContain(
      '<td>1. Claude opus 4.6</td><td align="right">12 sessions · 5.2M (8.4$)</td>',
    );
    expect(tooltip.value).not.toContain("<em>Claude opus 4.6</em>");
    expect(tooltip.value).toContain(
      '<tr><td colspan="2"><strong>Top sessions today</strong></td></tr>',
    );
    expect(tooltip.value).toContain(
      '<td>Feature work <span style="color:var(--vscode-descriptionForeground);">Claude opus 4.6</span></td><td align="right">420k (2.1$)</td>',
    );
    expect(tooltip.value).not.toContain("Most tokens today:");
    expect(tooltip.value).not.toContain("Most expensive today:");
    expect(tooltip.value.indexOf("Cost audit")).toBeLessThan(tooltip.value.indexOf("Feature work"));
    expect(tooltip.value.match(/---/g)).toHaveLength(3);
    expect(tooltip.value).toContain(
      '<td>Cost audit <span style="color:var(--vscode-descriptionForeground);">Claude opus 4.7</span></td><td align="right">316k (4.8$)</td>',
    );
    expect(tooltip.value).not.toContain("<thead>");
    expect(tooltip.value).not.toContain("<small>");
  });

  it("formats top models fallback when no model usage exists", () => {
    const summary: UsageSummary = {
      today: createTotal(0),
      week: createTotal(0),
      month: createTotal(0),
      allTime: createTotal(0),
      topModels: [],
      highestSessionToday: {
        chatId: "chat-1",
        title: "Feature work",
        model: "Claude opus 4.6",
        timestamp: new Date(2026, 4, 28, 9, 30),
        tokens: 420_000,
        githubCopilot: createCost(0),
        records: [],
      },
      chats: [],
    };

    expect(formatStatusBarTooltip(summary).value).toContain(
      [
        '<table width="430">',
        '<tr><td colspan="2"><strong>Model use</strong></td></tr>',
        '<tr><td colspan="2">No sessions yet.</td></tr>',
        "</table>",
      ].join("\n"),
    );
  });

  it("omits GitHub Copilot cost when AI Credit data is missing", () => {
    const summary: UsageSummary = {
      today: {
        tokens: 1_200,
        githubCopilot: {
          available: false,
          usd: 1.2,
          aiCredits: 120,
        },
      },
      week: createTotal(0),
      month: createTotal(0),
      allTime: createTotal(0),
      topModels: [],
      highestSessionToday: undefined,
      chats: [],
    };

    expect(formatStatusBarSummary(summary)).toBe("1k");
    expect(formatStatusBarTooltip(summary).value).toContain("<strong>Today:</strong> 1k &nbsp;|");
    expect(formatStatusBarTooltip(summary).value).not.toContain("1.2$");
  });

  it('shows sub-cent costs as plain status text and escaped tooltip HTML', () => {
    const summary = createEmptySummary();
    summary.today = createTotal(1_000, 0.004);
    expect(formatStatusBarSummary(summary)).toBe('1k | <0.01$');
    expect(formatStatusBarTooltip(summary).value).toContain('<strong>Today:</strong> 1k (&lt;0.01$)');
  });

  it("omits zero-credit cost from status text and tooltip", () => {
    const summary: UsageSummary = {
      today: {
        tokens: 1_200,
        githubCopilot: {
          available: true,
          usd: 0,
          aiCredits: 0,
        },
      },
      week: createTotal(0),
      month: createTotal(0),
      allTime: createTotal(0),
      topModels: [],
      highestSessionToday: undefined,
      chats: [],
    };

    expect(formatStatusBarSummary(summary)).toBe("1k");
    expect(formatStatusBarTooltip(summary).value).toContain("<strong>Today:</strong> 1k");
    expect(formatStatusBarTooltip(summary).value).not.toContain("0$");
  });

  it('shows billed usage when a request has no uncached tokens', () => {
    const summary = createEmptySummary();
    summary.today = createTotal(0, 0.1);
    expect(formatStatusBarSummary(summary)).toBe('0 | 0.1$');
    expect(formatStatusBarTooltip(summary).value).toContain('<strong>Today:</strong> 0 (0.1$)');
  });

  it("formats status bar as no sessions today when today has no tokens or credits", () => {
    const summary: UsageSummary = {
      today: createTotal(0),
      week: createTotal(0),
      month: createTotal(0),
      allTime: createTotal(0),
      topModels: [],
      highestSessionToday: undefined,
      chats: [],
    };

    expect(formatStatusBarSummary(summary)).toBe("No sessions today");
    expect(formatStatusBarTooltip(summary).value).toContain(
      "<strong>Today:</strong> No session &nbsp;|&nbsp; <strong>Month:</strong> 0 &nbsp;|&nbsp; <strong>All time:</strong> 0",
    );
  });

  it("formats today fallback when no session exists today", () => {
    const summary: UsageSummary = {
      today: createTotal(0),
      week: createTotal(0),
      month: createTotal(0),
      allTime: createTotal(0),
      topModels: [
        {
          model: "Claude opus 4.6",
          sessions: 1,
          tokens: 420_000,
          githubCopilot: createCost(2.1),
        },
      ],
      highestSessionToday: undefined,
      chats: [],
    };

    expect(formatStatusBarTooltip(summary).value).toContain(
      '<strong>Top sessions today</strong></td></tr>\n<tr><td colspan="2">No sessions today</td></tr>',
    );
  });

  it("escapes tooltip table values", () => {
    const summary: UsageSummary = {
      today: createTotal(1),
      week: createTotal(1),
      month: createTotal(1),
      allTime: createTotal(1),
      topModels: [
        { model: "model <alpha>", sessions: 1, tokens: 1, githubCopilot: createCost(0) },
      ],
      highestSessionToday: {
        chatId: "chat-1",
        title: "Fix <parser>",
        model: "model <alpha>",
        timestamp: new Date(2026, 4, 28, 9, 30),
        tokens: 1,
        githubCopilot: createCost(0),
        records: [],
      },
      chats: [],
    };

    const tooltip = formatStatusBarTooltip(summary);

    expect(tooltip.value).toContain(
      '<td>1. model &lt;alpha&gt;</td><td align="right">1 session · 1</td>',
    );
    expect(tooltip.value).not.toContain("<em>model &lt;alpha&gt;</em>");
    expect(tooltip.value).toContain("Fix &lt;parser&gt;");
    expect(tooltip.value).not.toContain("model <alpha>");
    expect(tooltip.value).not.toContain("Fix <parser>");
  });

  it("shows a session only once when it leads both highlights", () => {
    const summary = createEmptySummary();
    summary.highestSessionToday = {
      chatId: "same", title: "Only highlight", model: "model", timestamp: new Date(),
      tokens: 2_100_000, githubCopilot: createCost(8.29), records: [],
    };
    summary.mostExpensiveSessionToday = summary.highestSessionToday;
    expect(formatStatusBarTooltip(summary).value.match(/Only highlight/g)).toHaveLength(1);
  });

  it("adds the account period share separately from today's local totals", () => {
    const summary = createEmptySummary();
    summary.today = createTotal(2_100_000, 8.29);
    const quota = {
      entitlement: 1500, percentRemaining: 56.1,
      unlimited: false, hasQuota: true, resetDate: new Date("2026-10-01"),
    };
    expect(formatStatusBarSummary(summary, quota)).toBe("2.1M | 8.3$ • 43.9/100%");
    expect(formatStatusBarSummary(summary)).toBe("2.1M | 8.3$");
    summary.today = createTotal(0);
    expect(formatStatusBarSummary(summary, quota)).toBe("No sessions today • 43.9/100%");
  });

});

describe("activate", () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue(join(tmpdir(), "copilot-usage-extension-test-home-missing"));
    vi.useRealTimers();
    usageIndexInstances.length = 0;
    watcherRegistrations.length = 0;
    state.usageIndexResult = { summary: createEmptySummary(), diagnostics: createDiagnostics() };
    state.restoredResult = undefined;
    state.pollResults = [];
    state.rebuildResults = [];
    state.watchFolders = ["root"];
    state.copilotFileLoggingEnabled = true;
    vi.mocked(vscode.window.createStatusBarItem).mockReturnValue({
      show: vi.fn(),
    } as unknown as vscode.StatusBarItem);
    vi.mocked(vscode.commands.registerCommand).mockImplementation(
      (_command: string, callback: (...args: unknown[]) => unknown) =>
        ({ dispose: vi.fn(), callback }) as unknown as vscode.Disposable,
    );
    vi.mocked(vscode.window.registerTreeDataProvider).mockReturnValue({
      dispose: vi.fn(),
    } as unknown as vscode.Disposable);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({
      dispose: vi.fn(),
    } as unknown as vscode.Disposable);
    readConfig.mockReturnValue(createConfig());
    locateCopilotDataPaths.mockResolvedValue(["root"]);
  });

  afterEach(async () => {
    for (const context of activatedContexts.splice(0)) {
      for (const disposable of context.subscriptions.splice(0)) disposable.dispose?.();
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
    // Every activation/command/account-switch scenario must stay out of VS Code auth.
    for (const api of Object.values(vscode.authentication)) {
      expect(api).not.toHaveBeenCalled();
    }
  });

  it("registers every command declared by the manifest", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      contributes: { commands: Array<{ command: string }> };
    };
    await activateExtension();

    for (const { command } of manifest.contributes.commands) {
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(command, expect.any(Function));
    }
  });


  it("shows setup action and skips scanning when Copilot file logging is disabled", async () => {
    state.copilotFileLoggingEnabled = false;
    const statusBar = {
      show: vi.fn(),
    } as unknown as vscode.StatusBarItem;
    vi.mocked(vscode.window.createStatusBarItem).mockReturnValue(statusBar);

    await activateExtension();

    expect(statusBar.text).toBe("Enable Copilot logs to see token use");
    expect(statusBar.tooltip).toBeUndefined();
    expect(statusBar.command).toBe("copilotUsage.openCopilotLoggingSetting");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "copilotUsage.setupNeeded",
      true,
    );
    expect(usageIndexInstances[0].rebuild).not.toHaveBeenCalled();
    expect(usageIndexInstances[0].restore).not.toHaveBeenCalled();
    expect(usageIndexInstances[0].save).not.toHaveBeenCalled();
    expect(locateCopilotDataPaths).not.toHaveBeenCalled();
    expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled();
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();
  });

  it("clears the setup context after a scan completes", async () => {
    await activateExtension();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "copilotUsage.setupNeeded",
      false,
    );
  });

  it("expires only the projection on a presentation tick without rescanning and disposes the timer", async () => {
    vi.useFakeTimers();
    const observedAt = Date.parse('2026-09-16T00:00:00Z');
    vi.setSystemTime(Date.parse('2026-09-30T23:59:30Z'));
    const getState = vi.spyOn(CopilotQuotaService.prototype, 'getState').mockReturnValue({
      kind: 'quota', account: 'octocat', observedAt,
      quota: { entitlement: 60_000, percentRemaining: 72.4, unlimited: false, hasQuota: true,
        resetDate: new Date('2026-10-01T00:00:00Z') },
    });
    const refresh = vi.spyOn(CopilotQuotaService.prototype, 'refreshNow').mockResolvedValue();
    const context = createContext();
    try {
      await activateExtension(context);
      const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      const index = usageIndexInstances[0];
      const before = [index.rebuild.mock.calls.length, index.poll.mock.calls.length, refresh.mock.calls.length];
      expect(status.tooltip.value.replaceAll('&nbsp;', ' ')).toContain('1.84% / day · 55.2% monthly pace');
      const statusText = status.text;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(status.tooltip.value.replaceAll('&nbsp;', ' ')).toContain('Pace unavailable'));
      expect(status.tooltip.value).toContain('16\u00a0560');
      expect(status.text).toBe(statusText);
      expect([index.rebuild.mock.calls.length, index.poll.mock.calls.length, refresh.mock.calls.length]).toEqual(before);
      for (const disposable of context.subscriptions.splice(0)) disposable.dispose?.();
      const lastTooltip = status.tooltip;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(status.tooltip).toBe(lastTooltip);
    } finally {
      getState.mockRestore();
      refresh.mockRestore();
    }
  });

  it("shows saved sessions while startup reconciliation is still running", async () => {
    state.restoredResult = { summary: createSummaryWithTokens(1200), diagnostics: createDiagnostics() };
    state.usageIndexResult = { summary: createSummaryWithTokens(2400), diagnostics: createDiagnostics() };
    let finishPoll!: (value: unknown) => void;
    state.pollResults = [new Promise((resolve) => { finishPoll = resolve; })];
    const context = createContext();

    await activateExtension(context);

    const index = usageIndexInstances[0];
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    try {
      await vi.waitFor(() => expect(index.poll).toHaveBeenCalledTimes(1));
      expect(index.restore).toHaveBeenCalledWith(
        expect.objectContaining({ roots: ["root"], config: createConfig() }),
        join(context.globalStorageUri.fsPath, "scan-cache"),
      );
      expect(status.text).toBe("1k");
      expect(index.rebuild).not.toHaveBeenCalled();
      expect(index.save).not.toHaveBeenCalled();
    } finally {
      finishPoll(state.usageIndexResult);
      await settle();
    }
    await vi.waitFor(() => expect(status.text).toBe("2k"));
    expect(index.save).toHaveBeenCalledWith(join(context.globalStorageUri.fsPath, "scan-cache"));
  });

  it("rebuilds and saves sessions when no startup cache exists", async () => {
    const context = createContext();
    await activateExtension(context);

    const index = usageIndexInstances[0];
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
    expect(index.restore).toHaveBeenCalledTimes(1);
    expect(index.rebuild).toHaveBeenCalledTimes(1);
    expect(index.poll).not.toHaveBeenCalled();
    expect(index.save).toHaveBeenCalledWith(join(context.globalStorageUri.fsPath, "scan-cache"));
  });

  it("falls back to a full scan when restoring the startup cache fails", async () => {
    state.restoredResult = Promise.reject(new Error("cache is unreadable"));
    await activateExtension();

    const index = usageIndexInstances[0];
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
    expect(index.rebuild).toHaveBeenCalledTimes(1);
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    expect(status.text).toBe("No sessions today");
  });

  it("keeps scanned results usable when saving the cache fails", async () => {
    let finishRebuild!: (value: unknown) => void;
    state.rebuildResults = [new Promise((resolve) => { finishRebuild = resolve; })];
    await activateExtension();
    const index = usageIndexInstances[0];
    index.save.mockRejectedValue(new Error("cache folder is read-only"));
    finishRebuild({ summary: createSummaryWithTokens(1200), diagnostics: createDiagnostics() });

    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
    expect(status.text).toBe("1k");
    const refresh = commandCallback("copilotUsage.refresh");
    await refresh();
    expect(status.text).toBe("No sessions today");
    expect(index.rebuild).toHaveBeenCalledTimes(2);
  });

  it("manual refresh rebuilds after restoring startup sessions", async () => {
    state.restoredResult = state.usageIndexResult;
    await activateExtension();
    const index = usageIndexInstances[0];
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));

    await commandCallback("copilotUsage.refresh")();

    expect(index.restore).toHaveBeenCalledTimes(1);
    expect(index.poll).toHaveBeenCalledTimes(1);
    expect(index.rebuild).toHaveBeenCalledTimes(1);
    expect(index.save).toHaveBeenCalledTimes(2);
  });

  it("rejects a delayed startup cache after the scan configuration changes", async () => {
    let finishRestore!: (value: unknown) => void;
    state.restoredResult = new Promise((resolve) => { finishRestore = resolve; });
    await activateExtension();
    const index = usageIndexInstances[0];
    await vi.waitFor(() => expect(index.restore).toHaveBeenCalledTimes(1));
    readConfig.mockReturnValue(createConfig("new-root"));
    locateCopilotDataPaths.mockResolvedValue(["new-root"]);
    const configurationChanged = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls[0][0];
    configurationChanged({ affectsConfiguration: (section: string) => section === "copilotUsage" });
    finishRestore({ summary: createSummaryWithTokens(999000), diagnostics: createDiagnostics() });

    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
    expect(index.poll).not.toHaveBeenCalled();
    expect(index.rebuild).toHaveBeenCalledWith(expect.objectContaining({
      roots: ["new-root"], config: createConfig("new-root"),
    }));
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    expect(status.text).toBe("No sessions today");
  });

  it("does not publish a delayed startup cache after the extension is disposed", async () => {
    let finishRestore!: (value: unknown) => void;
    state.restoredResult = new Promise((resolve) => { finishRestore = resolve; });
    const context = createContext();
    await activateExtension(context);
    const index = usageIndexInstances[0];
    await vi.waitFor(() => expect(index.restore).toHaveBeenCalledTimes(1));
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    const beforeDispose = status.text;
    for (const disposable of context.subscriptions.splice(0)) disposable.dispose?.();
    finishRestore({ summary: createSummaryWithTokens(999000), diagnostics: createDiagnostics() });
    await settle();

    expect(status.text).toBe(beforeDispose);
    expect(index.poll).not.toHaveBeenCalled();
    expect(index.rebuild).not.toHaveBeenCalled();
    expect(index.save).not.toHaveBeenCalled();
  });

  it("does not persist cached requests or cached titles before checking source files", async () => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start.getTime() + 30_000);
    const root = await mkdtemp(join(tmpdir(), "copilot-cache-ledger-"));
    roots.push(root);
    vi.stubEnv("APPDATA", join(root, "roaming"));
    const host = join(root, "logs", "20260921T120000", "window1", "exthost");
    const logFolder = join(host, "GitHub.copilot-chat");
    await mkdir(logFolder, { recursive: true });
    await writeFile(join(logFolder, "GitHub Copilot Chat.log"),
      "2026-09-21 12:00:00.000 [info] Logged in as alice\n" +
      "2026-09-21 12:00:00.100 [info] Got Copilot token for alice\n" +
      "2026-09-21 12:00:06.000 [info] request done: requestId: [saved-request]\n" +
      "2026-09-21 12:00:11.000 [info] request done: requestId: [deleted-request]\n");
    const storage = join(root, "storage");
    const ledger = join(storage, "account-poc");
    await mkdir(ledger, { recursive: true });
    const savedStart = JSON.stringify({ version: 1, startedAt: start.getTime() });
    await writeFile(join(ledger, "start.json"), savedStart);
    const savedRecord: UsageRecord = {
      ...createUsageRecord(join(root, "missing", "main.jsonl"), new Date(start.getTime() + 5_000)),
      title: "Saved title", titlePriority: 1,
      tokens: { input: 800, cachedInput: 0, output: 200, cacheWriteInput: 0, total: 1000, source: "recorded" },
      billing: { aiCredits: 20, source: "copilot-debug-log" },
      debugRequest: { responseId: "saved-request", spanId: "saved-span", durationMs: 1000 },
    };
    const savedSummary = aggregateUsage([savedRecord], new Date());
    const seed = new AccountUsagePoc(ledger, logFolder, [join(root, "logs")]);
    await seed.refresh(savedSummary, new Date());
    const deletedRecord: UsageRecord = {
      ...savedRecord, chatId: "deleted-chat", title: "Deleted cached request",
      timestamp: new Date(start.getTime() + 10_000),
      debugRequest: { responseId: "deleted-request", spanId: "deleted-span", durationMs: 1000 },
    };
    const cachedTitle: UsageRecord = {
      ...savedRecord, title: "Stale cached rename", titlePriority: 5, metadataOnly: true,
      timestamp: new Date(start.getTime() + 15_000),
    };
    state.restoredResult = {
      summary: aggregateUsage([savedRecord, deletedRecord, cachedTitle], new Date()),
      titleMetadata: [cachedTitle], diagnostics: createDiagnostics(),
    };
    let finishPoll!: (value: unknown) => void;
    state.pollResults = [new Promise((resolve) => { finishPoll = resolve; })];
    const context = { ...createContext(), extensionMode: vscode.ExtensionMode.Production,
      logUri: vscode.Uri.file(join(host, "leonbjorklund.copilot-usage-extension")),
      globalStorageUri: vscode.Uri.file(storage) };
    await activateExtension(context);
    const index = usageIndexInstances[0];
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    try {
      await vi.waitFor(() => expect(index.poll).toHaveBeenCalledTimes(1));
      expect(status.text).toBe("1k | 0.2$");
      expect(status.tooltip.value).toContain("Saved title");
      expect(status.tooltip.value).not.toContain("Stale cached rename");
      expect(status.tooltip.value).not.toContain("Deleted cached request");
    } finally {
      // The source files were deleted before reload, so reconciliation finds none.
      finishPoll(state.usageIndexResult);
    }
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
    expect(status.text).toBe("1k | 0.2$");
    expect(status.tooltip.value).toContain("Saved title");
    const journalNames = (await readdir(ledger)).filter((name) => name.endsWith(".jsonl"));
    expect(journalNames).toEqual(["ledger.jsonl"]);
    const journals = await readFile(join(ledger, "ledger.jsonl"), "utf8");
    expect(journals).toContain('"Saved title"');
    expect(journals).not.toContain('"chatId":"deleted-chat"');
    expect(journals).not.toContain("Stale cached rename");
    expect(await readFile(join(ledger, "start.json"), "utf8")).toBe(savedStart);
    const tooltipBefore = status.tooltip;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(2));
    expect(index.poll).toHaveBeenCalledTimes(2);
    expect(status.text).toBe("1k | 0.2$");
    // An unchanged poll must not reassign the tooltip, or an open hover redraws.
    expect(status.tooltip).toBe(tooltipBefore);
  });

  it("withholds cached totals when account storage fails but accepts a fresh local scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "copilot-cache-damaged-ledger-"));
    roots.push(root);
    vi.stubEnv("APPDATA", join(root, "roaming"));
    const ledger = join(root, "storage", "account-poc");
    await mkdir(ledger, { recursive: true });
    const savedStart = JSON.stringify({ version: 1, startedAt: Date.now() - 60_000 });
    await writeFile(join(ledger, "start.json"), savedStart);
    await writeFile(join(ledger, "observer-abcdef.jsonl"), "broken\n");
    state.restoredResult = { summary: createSummaryWithTokens(999000), diagnostics: createDiagnostics() };
    state.usageIndexResult = { summary: createSummaryWithTokens(1000), diagnostics: createDiagnostics() };
    let finishPoll!: (value: unknown) => void;
    state.pollResults = [new Promise((resolve) => { finishPoll = resolve; })];
    await activateExtension({ ...createContext(), extensionMode: vscode.ExtensionMode.Production,
      globalStorageUri: vscode.Uri.file(join(root, "storage")),
      logUri: vscode.Uri.file(join(root, "logs", "window1", "exthost", "copilot-usage-extension")) });
    const index = usageIndexInstances[0];
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    try {
      await vi.waitFor(() => expect(index.poll).toHaveBeenCalledTimes(1));
      expect(status.text).not.toContain("999k");
    } finally {
      finishPoll(state.usageIndexResult);
    }
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
    expect(status.text).toBe("1k");
    expect((await registeredTreeProvider().getChildren())?.some((row) => row.kind === "error")).toBe(true);
    expect(await readFile(join(ledger, "observer-abcdef.jsonl"), "utf8")).toBe("broken\n");
    expect(await readFile(join(ledger, "start.json"), "utf8")).toBe(savedStart);
  });

  it("uses current account evidence for cached startup and keeps historical usage unassigned", async () => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start.getTime() + 30_000);
    const root = await mkdtemp(join(tmpdir(), "copilot-cache-account-switch-"));
    roots.push(root);
    vi.stubEnv("APPDATA", join(root, "roaming"));
    const host = join(root, "logs", "20260921T120000", "window1", "exthost");
    const logFolder = join(host, "GitHub.copilot-chat");
    await mkdir(logFolder, { recursive: true });
    await writeFile(join(logFolder, "GitHub Copilot Chat.log"),
      "2026-09-21 12:00:00.000 [info] Got Copilot token for alice\n" +
      "2026-09-21 12:00:06.000 [info] request done: requestId: [alice-request]\n" +
      "2026-09-21 12:00:10.000 [info] Got Copilot token for bob\n" +
      "2026-09-21 12:00:16.000 [info] request done: requestId: [bob-request]\n");
    const storage = join(root, "storage");
    const ledger = join(storage, "account-poc");
    await mkdir(ledger, { recursive: true });
    await writeFile(join(ledger, "start.json"), JSON.stringify({ version: 1, startedAt: start.getTime() }));
    const makeRecord = (chatId: string, offset: number, tokens: number): UsageRecord => ({
      ...createUsageRecord(join(root, "usage", chatId, "main.jsonl"), new Date(start.getTime() + offset)),
      chatId, title: chatId,
      tokens: { input: tokens, cachedInput: 0, output: 0, cacheWriteInput: 0, total: tokens, source: "recorded" },
      billing: { aiCredits: 1, source: "copilot-debug-log" },
      debugRequest: { responseId: `${chatId}-request`, spanId: `${chatId}-span`, durationMs: 1000 },
    });
    const alice = makeRecord("alice", 5_000, 1000);
    const bob = makeRecord("bob", 15_000, 100);
    const historical = makeRecord("historical", -5_000, 10);
    for (const record of [alice, bob]) {
      await mkdir(join(root, "usage", record.chatId), { recursive: true });
      await writeFile(record.filePath, JSON.stringify({ type: "session_start", ts: record.timestamp.getTime() - 1_000 }) + "\n");
    }
    const seed = new AccountUsagePoc(ledger, logFolder, [join(root, "logs")]);
    await seed.refresh(aggregateUsage([alice, bob], new Date()), new Date());
    state.restoredResult = { summary: aggregateUsage([historical, alice, bob], new Date()), diagnostics: createDiagnostics() };
    let finishPoll!: (value: unknown) => void;
    state.pollResults = [new Promise((resolve) => { finishPoll = resolve; })];
    await activateExtension({ ...createContext(), extensionMode: vscode.ExtensionMode.Production,
      globalStorageUri: vscode.Uri.file(storage),
      logUri: vscode.Uri.file(join(host, "leonbjorklund.copilot-usage-extension")) });
    const index = usageIndexInstances[0];
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    try {
      await vi.waitFor(() => expect(index.poll).toHaveBeenCalledTimes(1));
      expect(status.text).toBe(`${formatStatusBarSummary(aggregateUsage([historical, bob], new Date()))}`);
      expect(status.tooltip.value).toContain("bob");
      expect(status.tooltip.value).not.toContain("alice");
      const rows = await registeredTreeProvider().getChildren();
      const titles = rows?.flatMap((row) => row.kind === "bucket" ? row.bucket.chats.map((chat) => chat.title) : []);
      expect(titles).toEqual(expect.arrayContaining(["bob", "historical"]));
      expect(titles).not.toContain("alice");
    } finally {
      finishPoll(state.usageIndexResult);
    }
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
  });

  it("keeps cached totals visible when quota changes during startup reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 21, 12, 0, 30));
    const quotaRefresh = vi.spyOn(CopilotQuotaService.prototype, "refreshNow");
    const root = await mkdtemp(join(tmpdir(), "copilot-cache-quota-"));
    roots.push(root);
    const logFolder = join(root, "GitHub.copilot-chat");
    await mkdir(logFolder);
    const log = join(logFolder, "GitHub Copilot Chat.log");
    await writeFile(log, "2026-09-21 12:00:00.000 [info] Got Copilot token for alice\n");
    state.restoredResult = { summary: createSummaryWithTokens(1000), diagnostics: createDiagnostics() };
    let finishPoll!: (value: unknown) => void;
    state.pollResults = [new Promise((resolve) => { finishPoll = resolve; })];
    await activateExtension({ ...createContext(), logUri: vscode.Uri.file(join(root, "copilot-usage-extension")) });
    const index = usageIndexInstances[0];
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    try {
      await vi.waitFor(() => expect(index.poll).toHaveBeenCalledTimes(1));
      expect(status.text).toBe("1k");
      // The quota timer starts after its real filesystem read finishes.
      // Complete that read before appending and advancing the fake clock.
      await quotaRefresh.mock.results[0].value;
      await appendFile(log,
        "2026-09-21 12:00:30.000 [trace] [ChatQuota] processUserInfoQuotaSnapshot: " +
        JSON.stringify({ quota: 1500, unlimited: false, hasQuota: true, percentRemaining: 56.1,
          resetDate: "2026-10-01T00:00:00.000Z" }) + "\n");
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(status.text).toContain("43.9/100%"));
      expect(status.tooltip.value.replaceAll('&nbsp;', ' ')).toContain('43.9% / 100%  (659 / 1\u00a0500 credits)');
      expect(status.tooltip.value).toContain("Showing saved sessions");
      expect(index.save).not.toHaveBeenCalled();
    } finally {
      quotaRefresh.mockRestore();
      finishPoll(state.usageIndexResult);
    }
    await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
    expect(status.tooltip.value).not.toContain("Showing saved sessions");
  });

  it("reports reconciliation failure instead of presenting cached sessions as current", async () => {
    state.restoredResult = { summary: createSummaryWithTokens(1000), diagnostics: createDiagnostics() };
    let failPoll!: (reason: Error) => void;
    state.pollResults = [new Promise((_resolve, reject) => { failPoll = reject; })];
    await activateExtension();
    const index = usageIndexInstances[0];
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    await vi.waitFor(() => expect(index.poll).toHaveBeenCalledTimes(1));
    expect(status.tooltip.value).toContain("Showing saved sessions");
    failPoll(new Error("source folder unavailable"));
    await vi.waitFor(() => expect(status.text).toBe("Scan Failed"));
    expect(status.tooltip).toBe("source folder unavailable");
    expect(index.save).not.toHaveBeenCalled();
    const rows = await registeredTreeProvider().getChildren();
    expect(rows?.some((row) => row.kind === "error")).toBe(true);
    expect(rows?.some((row) => row.kind === "bucket")).toBe(false);
  });

  it("opens the exact Copilot file logging setting", async () => {
    const openSetting = await activatedCommand("copilotUsage.openCopilotLoggingSetting");
    await openSetting();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "@id:github.copilot.chat.agentDebugLog.fileLogging.enabled",
    );
  });

  it("opens the usage activity view directly from the status bar command", async () => {
    const openView = await activatedCommand("copilotUsage.openView");
    await openView();

    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("copilotUsage.views.usage.focus");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.view.explorer");
  });

  it("restores persisted cost sorting for registered tree provider", async () => {
    state.usageIndexResult = {
      summary: createSummaryWithChats([
        createChatSummary("newer-cheaper", new Date(2026, 4, 28, 11, 0), 900, 1),
        createChatSummary("older-expensive", new Date(2026, 4, 28, 8, 0), 100, 3),
      ]),
      diagnostics: createDiagnostics(),
    };

    await activateExtension(createContext("cost"));

    const provider = registeredTreeProvider();
    const rootChildren = (await provider.getChildren()) ?? [];
    const bucket = rootChildren.find((node) => node.kind === "bucket");
    const chatChildren = (await provider.getChildren(bucket)) ?? [];
    expect(chatChildren.map((node) => node.kind === "chat" && node.chat.chatId)).toEqual([
      "older-expensive",
      "newer-cheaper",
    ]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "copilotUsage.sortMode",
      "cost",
    );
  });

  it("persists cost sorting when the view title command runs", async () => {
    const context = createContext();
    await activateExtension(context);
    vi.mocked(vscode.commands.executeCommand).mockClear();
    const sortByCost = commandCallback("copilotUsage.sortSessionsByCost");

    await sortByCost();

    expect(context.globalState.update).toHaveBeenCalledWith("copilotUsage.sortMode", "cost");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "copilotUsage.sortMode",
      "cost",
    );
  });

  it("persists time sorting when the view title command runs", async () => {
    const context = createContext("cost");
    await activateExtension(context);
    vi.mocked(vscode.commands.executeCommand).mockClear();
    const sortByTime = commandCallback("copilotUsage.sortSessionsByTime");

    await sortByTime();

    expect(context.globalState.update).toHaveBeenCalledWith("copilotUsage.sortMode", "time");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "copilotUsage.sortMode",
      "time",
    );
  });

  it("opens the newest source log for a usage tree chat", async () => {
    const openSourceLog = await activatedCommand("copilotUsage.openSourceLog");
    vi.mocked(vscode.Uri.file).mockClear();

    await openSourceLog(
      createChatNode([
        ["C:/logs/new.jsonl", new Date(2026, 4, 28, 9, 0)],
        ["C:/logs/new.jsonl", new Date(2026, 4, 28, 10, 0)],
      ]),
    );

    expect(vscode.Uri.file).toHaveBeenCalledWith("C:/logs/new.jsonl");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("vscode.open", {
      fsPath: "C:/logs/new.jsonl",
      scheme: "file",
    });
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it("asks which source log to open when a usage tree chat spans files", async () => {
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async () =>
      createSourceLogPick("C:/logs/new.jsonl"),
    );
    const openSourceLog = await activatedCommand("copilotUsage.openSourceLog");

    await openSourceLog(
      createChatNode([
        ["C:/logs/old.jsonl", new Date(2026, 4, 28, 9, 0)],
        ["C:/logs/new.jsonl", new Date(2026, 4, 28, 10, 0)],
      ]),
    );

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      [
        createSourceLogPick("C:/logs/new.jsonl"),
        createSourceLogPick("C:/logs/old.jsonl"),
      ],
      { placeHolder: "Open source log" },
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("vscode.open", {
      fsPath: "C:/logs/new.jsonl",
      scheme: "file",
    });
  });

  it("creates scoped file watchers for indexed folders and updates one changed file from cache", async () => {
    vi.useFakeTimers();
    state.watchFolders = ["root/GitHub.copilot-chat"];

    await activateExtension();

    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled();
    expect(watcherRegistrations[0].pattern).toMatchObject({
      baseUri: { fsPath: "root/GitHub.copilot-chat" },
      pattern:
        "**/{github.copilot-chat,GitHub.copilot-chat,debug-logs,transcripts,chatSessions,chatsessions,emptyWindowChatSessions,emptywindowchatsessions}/**",
    });

    state.usageIndexResult = {
      summary: createSummaryWithTokens(25),
      diagnostics: createDiagnostics(),
    };
    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/GitHub.copilot-chat/usage.jsonl" });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(usageIndexInstances[0].applyChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        pathsToUpdate: ["root/GitHub.copilot-chat/usage.jsonl"],
      }),
    );
  });

  it("uses broad JSON watchers for the configured custom data path", async () => {
    state.watchFolders = ["C:/custom/copilot-logs"];
    readConfig.mockReturnValue(createConfig("C:/custom/copilot-logs"));

    await activateExtension();

    expect(watcherRegistrations[0].pattern).toMatchObject({
      baseUri: { fsPath: "C:/custom/copilot-logs" },
      pattern: "**/*.{json,jsonl}",
    });
  });

  it("ignores root-level JSON file events outside Copilot usage folders", async () => {
    vi.useFakeTimers();

    await activateExtension();

    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/other-extension-state.json" });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(usageIndexInstances[0].applyChanges).not.toHaveBeenCalled();
  });

  it("keeps existing watchers after processing a changed file", async () => {
    vi.useFakeTimers();

    await activateExtension();
    const firstWatcher = watcherRegistrations[0].watcher;

    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/usage.jsonl" });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(firstWatcher.dispose).not.toHaveBeenCalled();
    expect(watcherRegistrations).toHaveLength(1);
  });

  it("scans a created folder so files written before child watchers exist are indexed", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "copilot-usage-extension-"));
    const usageFolder = join(root, "workspace", "GitHub.copilot-chat", "session");
    roots.push(root);
    await mkdir(usageFolder, { recursive: true });
    state.watchFolders = [root];
    locateCopilotDataPaths.mockResolvedValue([root]);

    await activateExtension();

    watcherRegistrations[0].handlers.create[0]({ fsPath: usageFolder });
    await vi.waitFor(() => {
      expect(usageIndexInstances[0].applyChanges).toHaveBeenCalled();
    });

    expect(usageIndexInstances[0].applyChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        pathsToUpdate: [usageFolder],
      }),
    );
  });

  it("does not schedule folder scans for created non-directories", async () => {
    vi.useFakeTimers();

    await activateExtension();

    watcherRegistrations[0].handlers.create[0]({ fsPath: "root/usage.jsonl" });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(usageIndexInstances[0].applyChanges).not.toHaveBeenCalled();
  });

  it.each(['refresh', 'disposal'])('ignores created folders whose stat finishes after %s', async (change) => {
    vi.useFakeTimers();
    const context = createContext();
    await activateExtension(context);
    let finishStat!: (value: Awaited<ReturnType<typeof stat>>) => void;
    vi.mocked(stat).mockImplementationOnce(() => new Promise((resolve) => { finishStat = resolve; }));
    watcherRegistrations[0].handlers.create[0]({ fsPath: 'root/GitHub.copilot-chat/late-folder' });
    expect(finishStat).toBeTypeOf('function');

    if (change === 'refresh') {
      state.watchFolders = ['new-root'];
      await commandCallback('copilotUsage.refresh')();
    } else {
      for (const disposable of context.subscriptions) disposable.dispose?.();
    }
    const watcherCount = watcherRegistrations.length;
    finishStat({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
    await vi.advanceTimersByTimeAsync(100);

    expect(watcherRegistrations).toHaveLength(watcherCount);
    expect(usageIndexInstances[0].applyChanges).not.toHaveBeenCalled();
    for (const disposable of context.subscriptions) disposable.dispose?.();
  });

  it("removes watchers for folders no longer needed after file events", async () => {
    vi.useFakeTimers();
    state.watchFolders = ["root/GitHub.copilot-chat", "root/GitHub.copilot-chat/session"];

    await activateExtension();
    const staleWatchers = watcherRegistrations
      .filter(
        (registration) =>
          (registration.pattern as { baseUri: { fsPath: string } }).baseUri.fsPath ===
          "root/GitHub.copilot-chat/session",
      )
      .map((registration) => registration.watcher);

    state.watchFolders = ["root/GitHub.copilot-chat"];
    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/GitHub.copilot-chat/usage.jsonl" });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(staleWatchers).toHaveLength(1);
    expect(staleWatchers.every((watcher) => watcher.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("batches changed files into one index update", async () => {
    vi.useFakeTimers();
    state.watchFolders = ["root/GitHub.copilot-chat"];

    await activateExtension();

    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/GitHub.copilot-chat/first.jsonl" });
    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/GitHub.copilot-chat/second.jsonl" });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(usageIndexInstances[0].applyChanges).toHaveBeenCalledTimes(1);
    expect(usageIndexInstances[0].applyChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        pathsToUpdate: [
          "root/GitHub.copilot-chat/first.jsonl",
          "root/GitHub.copilot-chat/second.jsonl",
        ],
      }),
    );
  });

  it("reuses the cached config while processing watcher events", async () => {
    vi.useFakeTimers();
    state.watchFolders = ["root/GitHub.copilot-chat"];

    await activateExtension();
    readConfig.mockClear();

    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/GitHub.copilot-chat/usage.jsonl" });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(readConfig).not.toHaveBeenCalled();
    expect(usageIndexInstances[0].applyChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        config: createConfig(),
      }),
    );
  });

  it("ignores stale refresh failures after a newer refresh starts", async () => {
    const statusBar = {
      show: vi.fn(),
    } as unknown as vscode.StatusBarItem;
    vi.mocked(vscode.window.createStatusBarItem).mockReturnValue(statusBar);
    const firstError = new Error("first failed late");
    let rejectFirst: (error: Error) => void = () => {};
    state.rebuildResults = [
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
      state.usageIndexResult,
    ];

    await activateExtension();

    const refresh = commandCallback("copilotUsage.refresh");
    const refreshing = refresh();
    rejectFirst(firstError);
    await refreshing;
    await settle();

    expect(statusBar.text).not.toBe("Scan Failed");
    expect(statusBar.tooltip).not.toBe(firstError.message);
  });

  it("manual refresh rebuilds the full index and keeps unchanged watchers", async () => {
    await activateExtension();
    const firstWatcher = watcherRegistrations[0].watcher;

    state.watchFolders = ["root", "root/session"];
    const refresh = commandCallback("copilotUsage.refresh");
    await refresh();

    expect(usageIndexInstances[0].rebuild).toHaveBeenCalledTimes(2);
    expect(firstWatcher.dispose).not.toHaveBeenCalled();
    expect(watcherRegistrations).toHaveLength(2);
  });

  it("waits for an active file update before rebuilding the same index", async () => {
    vi.useFakeTimers();
    await activateExtension();
    const index = usageIndexInstances[0];
    let finishUpdate!: (value: unknown) => void;
    index.applyChanges.mockImplementationOnce(() => new Promise((resolve) => { finishUpdate = resolve; }));
    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/GitHub.copilot-chat/usage.jsonl" });
    await vi.advanceTimersByTimeAsync(100);
    expect(index.applyChanges).toHaveBeenCalledTimes(1);
    const refresh = commandCallback("copilotUsage.refresh")();
    try {
      await settle();
      expect(index.rebuild).toHaveBeenCalledTimes(1);
    } finally {
      finishUpdate(state.usageIndexResult);
      await refresh;
    }
    expect(index.rebuild).toHaveBeenCalledTimes(2);
  });

  it("explains a failed scan in the tree instead of leaving it blank", async () => {
    locateCopilotDataPaths.mockRejectedValueOnce(new Error("profile folder is locked"));

    await activateExtension();

    const rootChildren = (await registeredTreeProvider().getChildren()) ?? [];
    expect(rootChildren.map((node) => node.kind)).toContain("error");
  });

  it("waits for Copilot quota at startup without requesting authentication", async () => {
    await activateExtension();
    await vi.waitFor(async () => expect((await registeredTreeProvider().getChildren())?.[0])
      .toMatchObject({ kind: "quota", state: { kind: "waiting" } }));
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith("copilotUsage.connectQuota", expect.anything());
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("includes quota logging failure in diagnostics when session scanning is disabled", async () => {
    const { enableQuotaLogging } = await import('../src/core/quotaLogging');
    vi.mocked(enableQuotaLogging).mockResolvedValueOnce({ requested: false, reason: 'Copilot Trace could not be saved: permission denied' });
    state.copilotFileLoggingEnabled = false;
    await activateExtension();
    await commandCallback('copilotUsage.showDiagnostics')();
    expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0])
      .toContain('Copilot Trace could not be saved: permission denied');
  });

  it.each(['logging disabled', 'scan failed'])("keeps quota available with %s", async (failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 21, 12));
    const root = await mkdtemp(join(tmpdir(), 'copilot-quota-independent-'));
    roots.push(root);
    const logFolder = join(root, 'GitHub.copilot-chat');
    await mkdir(logFolder);
    await writeFile(join(logFolder, 'GitHub Copilot Chat.log'),
      '2026-09-21 12:00:00.000 [info] Got Copilot token for alice\n'
      + '2026-09-21 12:00:00.000 [trace] [ChatQuota] processUserInfoQuotaSnapshot: '
      + JSON.stringify({ quota: 1500, unlimited: false, hasQuota: true, percentRemaining: 56.1,
        resetDate: '2026-10-01T00:00:00.000Z' }) + '\n');
    if (failure === 'logging disabled') state.copilotFileLoggingEnabled = false;
    else locateCopilotDataPaths.mockRejectedValue(new Error('Cannot scan logs'));

    await activateExtension({ ...createContext(), logUri: vscode.Uri.file(join(root, 'copilot-usage-extension')) });

    await vi.waitFor(async () => {
      const rows = await registeredTreeProvider().getChildren();
      expect(rows?.[0]).toMatchObject({ kind: 'quota', state: { kind: 'quota', account: 'alice',
        quota: { entitlement: 1500, percentRemaining: 56.1 } } });
      expect(rows?.[1].kind).toBe(failure === 'logging disabled' ? 'setup' : 'error');
    });
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();
  });

  it("reads a fresh quota after the first normal Copilot chat without authentication", async () => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start);
    const root = await mkdtemp(join(tmpdir(), "copilot-first-chat-quota-"));
    roots.push(root);
    const logFolder = join(root, "GitHub.copilot-chat");
    const logPath = join(logFolder, "GitHub Copilot Chat.log");
    await mkdir(logFolder);
    await writeFile(logPath, "2026-09-21 12:00:00.000 [info] Logged in as octocat\n"
      + "2026-09-21 12:00:00.000 [info] Got Copilot token for octocat\n");
    const context = { ...createContext(), logUri: vscode.Uri.file(join(root, "copilot-usage-extension")) };
    await activateExtension(context);
    await vi.waitFor(async () => expect((await registeredTreeProvider().getChildren())?.[0])
      .toMatchObject({ kind: "quota", state: { kind: "waiting" } }));
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    expect(status.text).toBe("No sessions today");

    vi.setSystemTime(start.getTime() + 500);
    await appendFile(logPath, "2026-09-21 12:00:00.100 [info] ccreq:first | success | model | 10ms | [panel/editAgent]\n"
      + "2026-09-21 12:00:00.200 [trace] [ChatQuota] processQuotaHeaders: "
      + JSON.stringify({ quota: 1500, unlimited: false, hasQuota: true, percentRemaining: 56.1,
        additionalUsageUsed: 0, resetDate: "2026-10-01T00:00:00.000Z" }) + "\n");
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(async () => expect((await registeredTreeProvider().getChildren())?.[0])
      .toMatchObject({ kind: "quota", state: { kind: "quota", account: "octocat",
        quota: { entitlement: 1500, percentRemaining: 56.1 } } }), { timeout: 5_000 });
    expect(status.text).toBe("No sessions today • 43.9/100%");
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

    await appendFile(logPath, "2026-09-21 12:00:02.000 [info] Logged in as hubot\n"
      + "2026-09-21 12:00:02.000 [info] Got Copilot token for hubot\n");
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(status.text).toBe("No sessions today"), { timeout: 5_000 });
    expect((await registeredTreeProvider().getChildren())?.[0])
      .toMatchObject({ kind: "quota", state: { kind: "waiting" } });
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();
  });

  it.each(['fresh install', 'previous release upgrade'])('initializes %s without assigning old usage or inventing daily history', async (scenario) => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start);
    const root = await mkdtemp(join(tmpdir(), 'copilot-release-upgrade-'));
    roots.push(root);
    vi.mocked(homedir).mockReturnValue(root);
    vi.stubEnv('APPDATA', join(root, 'roaming'));
    const host = join(root, 'logs', '20260921T120000', 'window1', 'exthost');
    const logFolder = join(host, 'GitHub.copilot-chat');
    const log = join(logFolder, 'GitHub Copilot Chat.log');
    const dataRoot = join(root, 'usage');
    const storage = join(root, 'storage');
    await mkdir(logFolder, { recursive: true });
    await mkdir(dataRoot);
    await writeFile(log, '2026-09-21 11:59:00.000 [info] Got Copilot token for alice\n');
    // The previous release persisted only sorting; its billed requests remained in Copilot's logs.
    const oldLog = join(dataRoot, 'debug-logs', 'old-chat', 'main.jsonl');
    const oldContents = JSON.stringify({ type: 'llm_request', ts: start.getTime() - 60_000,
      spanId: 'old-span', attrs: { model: 'model', responseId: 'old-request',
        inputTokens: 800, outputTokens: 200, copilotUsageNanoAiu: 20_000_000_000 } }) + '\n';
    if (scenario === 'previous release upgrade') {
      await mkdir(join(dataRoot, 'debug-logs', 'old-chat'), { recursive: true });
      await writeFile(oldLog, oldContents);
      await mkdir(storage);
    }
    const realIndex = await vi.importActual<typeof import('../src/core/usageIndex')>('../src/core/usageIndex');
    const { UsageIndex } = await import('../src/core/usageIndex');
    vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
    locateCopilotDataPaths.mockResolvedValue([dataRoot]);
    const context = { ...createContext(scenario === 'previous release upgrade' ? 'cost' : undefined),
      extensionMode: vscode.ExtensionMode.Production,
      logUri: vscode.Uri.file(join(host, 'leonbjorklund.copilot-usage-extension')),
      globalStorageUri: vscode.Uri.file(storage) };
    activatedContexts.push(context);
    activate(context);
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    const expected = scenario === 'previous release upgrade' ? '1k | 0.2$' : 'No sessions today';
    await vi.waitFor(() => expect(status.text).toBe(expected));
    expect(status.tooltip.value).not.toContain('monthly pace');
    expect(status.tooltip.value).not.toMatch(/title="[^\"]* · [\d<]/);
    const started = await readFile(join(storage, 'account-poc', 'start.json'), 'utf8');
    expect(JSON.parse(started).startedAt).toBeGreaterThanOrEqual(start.getTime());
    expect(JSON.parse(started).startedAt).toBeLessThanOrEqual(Date.now());
    const snapshot = (time: string, remaining: number) => `2026-09-21 ${time} [trace] [ChatQuota] processUserInfoQuotaSnapshot: `
      + JSON.stringify({ quota: 1500, unlimited: false, hasQuota: true, percentRemaining: remaining,
        resetDate: '2026-10-01T00:00:00.000Z' }) + '\n';
    await appendFile(log, snapshot('12:00:00.000', 60));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(status.text).toBe(`${expected} • 40/100%`));
    expect(status.tooltip.value).toContain('21 Sep · 0% recorded · Incomplete');
    expect(status.tooltip.value).toContain('20 Sep · Not tracked');
    await appendFile(log, snapshot('12:00:01.000', 58));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(status.tooltip.value).toContain('21 Sep · 2% recorded · Incomplete'));
    await appendFile(log, '2026-09-21 12:00:03.000 [info] Got Copilot token for bob\n');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(status.text).toBe(expected));
    const journal = await readFile(join(storage, 'account-poc', 'ledger.jsonl'), 'utf8');
    expect(journal.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(entry => entry.kind === 'bill')).toBe(false);
    for (const disposable of context.subscriptions.splice(0)) disposable.dispose?.();
    vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
    vi.mocked(vscode.window.createStatusBarItem).mockReturnValueOnce(status);
    activate(context);
    await vi.waitFor(() => {
      expect(status.text).toBe(expected);
      expect(status.tooltip.value).not.toContain('Showing saved sessions. Checking for changes.');
    });
    expect(await readFile(join(storage, 'account-poc', 'start.json'), 'utf8')).toBe(started);
    if (scenario === 'previous release upgrade') expect(await readFile(oldLog, 'utf8')).toBe(oldContents);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(context.globalState.update).not.toHaveBeenCalled();
  });

  it('hides monthly quota and its graph when account evidence is unavailable', () => {
    const tooltip = formatStatusBarTooltip(createEmptySummary(),
      { kind: 'waiting', reason: 'Account evidence was lost.' }, Date.now(), []).value;
    expect(tooltip).not.toContain('Monthly Credits');
    expect(tooltip).not.toContain('<img ');
    expect(tooltip).toContain('Today:');
  });

  it("journals quota percentages per account and keeps the daily graph across restarts", async () => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start);
    const root = await mkdtemp(join(tmpdir(), "copilot-daily-graph-"));
    roots.push(root);
    const logFolder = join(root, "GitHub.copilot-chat");
    const logPath = join(logFolder, "GitHub Copilot Chat.log");
    await mkdir(logFolder);
    const snapshot = (time: string, percentRemaining: number, method = 'processQuotaHeaders') =>
      `2026-09-21 ${time} [trace] [ChatQuota] ${method}: ` + JSON.stringify({ quota: 1500, unlimited: false,
        hasQuota: true, percentRemaining, additionalUsageUsed: 0, resetDate: "2026-10-01T00:00:00.000Z" }) + "\n";
    await writeFile(logPath, "2026-09-21 11:00:00.000 [info] Logged in as octocat\n"
      + "2026-09-21 11:00:00.000 [info] Got Copilot token for octocat\n"
      + snapshot('11:00:00.100', 60, 'processUserInfoQuotaSnapshot') + snapshot('11:30:00.000', 58.5));
    const storage = join(root, "storage");
    const context = { ...createContext(), logUri: vscode.Uri.file(join(root, "copilot-usage-extension")),
      globalStorageUri: vscode.Uri.file(storage) };
    await activateExtension(context);
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
    await vi.waitFor(() => expect(status.tooltip.value).toContain('title="21 Sep · 1.5% recorded · Incomplete"'), { timeout: 5_000 });
    expect(status.tooltip.value).toContain('title="20 Sep · Not tracked"');
    expect(status.tooltip.value.match(/<img /g)).toHaveLength(30);
    const barFill = () => Buffer.from(/base64,([^"]+)"[^>]*title="21 Sep/.exec(status.tooltip.value)![1], 'base64').toString('utf8');
    expect(barFill()).toContain('fill="#cccccc"');
    const themeListener = vi.mocked(vscode.window.onDidChangeActiveColorTheme).mock.calls[0][0];
    (vscode.window.activeColorTheme as { kind: number }).kind = vscode.ColorThemeKind.Light;
    try {
      themeListener({ kind: vscode.ColorThemeKind.Light } as vscode.ColorTheme);
      expect(barFill()).toContain('fill="#616161"');
    } finally {
      (vscode.window.activeColorTheme as { kind: number }).kind = vscode.ColorThemeKind.Dark;
      themeListener({ kind: vscode.ColorThemeKind.Dark } as vscode.ColorTheme);
    }
    await appendFile(logPath, snapshot('11:45:00.000', 58.5) + snapshot('11:50:00.000', 57));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(status.tooltip.value).toContain('title="21 Sep · 3% recorded · Incomplete"'), { timeout: 5_000 });
    const journal = (await readFile(join(storage, "quota-history.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(journal.map((entry) => [entry.account, entry.percentRemaining])).toEqual([["octocat", 60], ["octocat", 58.5], ["octocat", 57]]);
    // Another account's log never mixes into the graph, and the switch clears the quota row.
    await appendFile(logPath, "2026-09-21 11:55:00.000 [info] Logged in as hubot\n"
      + "2026-09-21 11:55:00.000 [info] Got Copilot token for hubot\n"
      + "2026-09-21 11:55:00.010 [debug] AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken.\n"
      + snapshot('11:55:00.020', 90, 'processUserInfoQuotaSnapshot'));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(status.tooltip.value).toContain('title="21 Sep · 0% recorded · Incomplete"'), { timeout: 5_000 });
    expect(status.text).toBe("No sessions today • 10/100%");
    // Another window's observation reaches this graph on the next minute tick without a local log change.
    await appendFile(join(storage, "quota-history.jsonl"), JSON.stringify({ account: "hubot", at: new Date(2026, 8, 21, 11, 58).getTime(),
      percentRemaining: 89, resetDate: "2026-10-01T00:00:00.000Z" }) + "\n");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(status.tooltip.value).toContain('title="21 Sep · 1% recorded · Incomplete"'), { timeout: 5_000 });
    for (const disposable of context.subscriptions.splice(0)) disposable.dispose?.();

    // A fresh window on the next day reads the journal before any new quota line arrives.
    const nextStatus = { show: vi.fn() } as unknown as vscode.StatusBarItem & { tooltip: vscode.MarkdownString };
    vi.mocked(vscode.window.createStatusBarItem).mockReturnValueOnce(nextStatus);
    vi.setSystemTime(new Date(2026, 8, 22, 9, 1));
    const secondLog = join(root, "next", "GitHub.copilot-chat");
    await mkdir(secondLog, { recursive: true });
    await writeFile(join(secondLog, "GitHub Copilot Chat.log"), "2026-09-22 09:00:00.000 [info] Logged in as octocat\n"
      + "2026-09-22 09:00:00.000 [info] Got Copilot token for octocat\n"
      + snapshot('09:00:00.100', 57, 'processUserInfoQuotaSnapshot').replace('2026-09-21', '2026-09-22'));
    const nextContext = { ...createContext(), subscriptions: [], logUri: vscode.Uri.file(join(root, "next", "copilot-usage-extension")),
      globalStorageUri: vscode.Uri.file(storage) };
    activatedContexts.push(nextContext);
    activate(nextContext);
    await vi.waitFor(() => expect(nextStatus.tooltip.value).toContain('title="22 Sep · 0%"'), { timeout: 5_000 });
    // Yesterday's tail is now proven idle by today's unchanged baseline, but its start stays unknown.
    expect(nextStatus.tooltip.value).toContain('title="21 Sep · 3% recorded · Incomplete"');
    expect(nextStatus.tooltip.value).not.toContain('title="21 Sep · 0%');
  }, 20_000);

  it.each([false, true])("keeps quota visible without an account or history after lost log evidence; ledger saw switch: %s", async (ledgerSawSwitch) => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start);
    const root = await mkdtemp(join(tmpdir(), "copilot-truncated-log-"));
    roots.push(root);
    vi.stubEnv("APPDATA", join(root, "roaming"));
    const host = join(root, "logs", "20260921T110000", "window1", "exthost");
    const logFolder = join(host, "GitHub.copilot-chat");
    const logPath = join(logFolder, "GitHub Copilot Chat.log");
    await mkdir(logFolder, { recursive: true });
    const quota = (time: string, percentRemaining: number, method = "processQuotaHeaders") =>
      `2026-09-21 ${time} [trace] [ChatQuota] ${method}: ` + JSON.stringify({ quota: 1500, unlimited: false,
        hasQuota: true, percentRemaining, additionalUsageUsed: 0, resetDate: "2026-10-01T00:00:00.000Z" }) + "\n";
    const token = (time: string, account = "octocat") => `2026-09-21 ${time} [info] Logged in as ${account}\n2026-09-21 ${time} [info] Got Copilot token for ${account}\n`;
    await writeFile(logPath, token("11:00:00.000") + quota("11:00:00.100", 60) + quota("11:10:00.000", 58.5));
    const dataRoot = join(root, "usage");
    await mkdir(dataRoot);
    const realIndex = await vi.importActual<typeof import("../src/core/usageIndex")>("../src/core/usageIndex");
    const { UsageIndex } = await import("../src/core/usageIndex");
    vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
    locateCopilotDataPaths.mockResolvedValue([dataRoot]);
    const storage = join(root, "storage");
    const context = { ...createContext(), extensionMode: vscode.ExtensionMode.Production,
      logUri: vscode.Uri.file(join(host, "leonbjorklund.copilot-usage-extension")), globalStorageUri: vscode.Uri.file(storage) };
    const quotaRow = async () => (await registeredTreeProvider().getChildren())?.find((row) => row.kind === "quota");
    try {
      activate(context);
      const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      await vi.waitFor(() => expect(status.text).toBe("No sessions today • 41.5/100%"), { timeout: 5_000 });
      expect(status.tooltip.value).toContain('title="21 Sep · 1.5% recorded · Incomplete"');
      const history = () => readFile(join(storage, "quota-history.jsonl"), "utf8");
      const recorded = await history();
      expect(recorded).toContain('"percentRemaining":60');

      if (ledgerSawSwitch) {
        // The independent readers can poll on either side of an account switch.
        const pausedQuota = vi.spyOn(CopilotQuotaService.prototype, "refreshNow").mockResolvedValue();
        try {
          await appendFile(logPath, token("11:20:00.000", "bob"));
          await commandCallback("copilotUsage.refresh")();
          await commandCallback("copilotUsage.showDiagnostics")();
          expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toContain("Account POC: bob");
          // A named quota still cannot be displayed under a different current account.
          expect(status.text).toBe("No sessions today");
          expect(await quotaRow()).toMatchObject({ state: { kind: "waiting" } });
        } finally {
          pausedQuota.mockRestore();
        }
      }

      // Account lines are gone when quota next polls, including any switch in that gap.
      await writeFile(logPath, quota("11:30:00.000", 55));
      await commandCallback("copilotUsage.refresh")();
      await vi.waitFor(() => expect(status.text).toBe("No sessions today • 45/100%"), { timeout: 5_000 });
      const row = await quotaRow();
      expect(row).toMatchObject({ state: { kind: "quota", quota: { percentRemaining: 55 } } });
      expect(row).not.toHaveProperty("state.account");
      expect(status.tooltip.value).toContain("Monthly Credits");
      expect(status.tooltip.value).not.toContain("<img ");
      expect(await history()).toBe(recorded);

      await appendFile(logPath, quota("11:35:00.000", 54.5));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(status.text).toBe("No sessions today • 45.5/100%"), { timeout: 5_000 });
      expect(status.tooltip.value).not.toContain("<img ");
      expect(await history()).toBe(recorded);

      // Copilot names the account again when it mints its next token.
      const recoveredAccount = ledgerSawSwitch ? "bob" : "octocat";
      await appendFile(logPath, token("11:40:00.000", recoveredAccount)
        + "2026-09-21 11:40:00.010 [debug] AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken.\n"
        + quota("11:40:00.020", 54, "processUserInfoQuotaSnapshot"));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(async () => expect(await quotaRow()).toMatchObject({ state: { account: recoveredAccount, quota: { percentRemaining: 54 } } }), { timeout: 5_000 });
      expect(status.tooltip.value).toContain("<img ");
      expect(await history()).toContain('"percentRemaining":54');
      expect(await history()).not.toContain('"percentRemaining":55');
      expect(await history()).not.toContain('"percentRemaining":54.5');
    } finally {
      for (const disposable of context.subscriptions) disposable.dispose?.();
      vi.useRealTimers();
    }
  }, 20_000);

  it('keeps the tree account guard during Refresh while allowing anonymous quota', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 21, 12);
    vi.setSystemTime(now);
    const root = await mkdtemp(join(tmpdir(), 'copilot-refresh-quota-'));
    roots.push(root);
    vi.stubEnv('APPDATA', join(root, 'roaming'));
    const host = join(root, 'logs', '20260921T110000', 'window1', 'exthost');
    const logFolder = join(host, 'GitHub.copilot-chat');
    const logPath = join(logFolder, 'GitHub Copilot Chat.log');
    await mkdir(logFolder, { recursive: true });
    const quota = (percentRemaining: number, method = 'processQuotaHeaders') =>
      '2026-09-21 11:30:00.000 [trace] [ChatQuota] ' + method + ': ' + JSON.stringify({
        quota: 1500, unlimited: false, hasQuota: true, percentRemaining,
      }) + '\n';
    const token = (account: string) => `2026-09-21 11:00:00.000 [info] Got Copilot token for ${account}\n`
      + '2026-09-21 11:00:00.010 [debug] AuthenticationService: firing onDidCopilotTokenChange from getCopilotToken.\n';
    await writeFile(logPath, token('alice') + quota(60, 'processUserInfoQuotaSnapshot'));
    const record = createUsageRecord(join(root, 'usage', 'chat.json'), new Date(2026, 8, 21, 10));
    record.tokens = { ...record.tokens, input: 1000, total: 1000 };
    record.billing = { aiCredits: 1, source: 'copilot-debug-log' };
    state.usageIndexResult = { summary: aggregateUsage([record], now), diagnostics: createDiagnostics() };
    const quotaRefresh = vi.spyOn(CopilotQuotaService.prototype, 'refreshNow');
    const context = { ...createContext(), extensionMode: vscode.ExtensionMode.Production,
      logUri: vscode.Uri.file(join(host, 'leonbjorklund.copilot-usage-extension')),
      globalStorageUri: vscode.Uri.file(join(root, 'storage')) };
    const quotaRow = async () => (await registeredTreeProvider().getChildren())?.find(row => row.kind === 'quota');
    let finishRefresh: ((result: unknown) => void) | undefined;
    let refresh: Promise<unknown> | undefined;
    try {
      await activateExtension(context);
      await vi.waitFor(async () => expect(await quotaRow()).toMatchObject({ state: { account: 'alice' } }));
      const index = usageIndexInstances[0];
      await vi.waitFor(() => expect(index.save).toHaveBeenCalledTimes(1));
      index.rebuild.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
      refresh = commandCallback('copilotUsage.refresh')();
      await vi.waitFor(() => expect(index.rebuild).toHaveBeenCalledTimes(2));

      // Quota reads Bob's token while the session scan still holds Alice's view.
      await appendFile(logPath, token('bob') + quota(80, 'processUserInfoQuotaSnapshot'));
      await vi.advanceTimersByTimeAsync(2_000);
      await quotaRefresh.mock.results.at(-1)?.value;
      await commandCallback('copilotUsage.showDiagnostics')();
      expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toContain('Account POC: alice');
      expect(await quotaRow()).toMatchObject({ state: { kind: 'waiting' } });
      expect((await registeredTreeProvider().getChildren())?.some(row => row.kind === 'bucket')).toBe(true);

      // Losing those lines permits current quota without naming either account.
      await writeFile(logPath, quota(70));
      await vi.advanceTimersByTimeAsync(2_000);
      await quotaRefresh.mock.results.at(-1)?.value;
      expect(await quotaRow()).toMatchObject({ state: { kind: 'quota', quota: { percentRemaining: 70 } } });
      expect(await quotaRow()).not.toHaveProperty('state.account');
    } finally {
      finishRefresh?.(state.usageIndexResult);
      await refresh;
      quotaRefresh.mockRestore();
    }
  });

  it.each(['unknown account', 'known account', 'damaged tracking storage'])(
    'keeps local token and dollar displays without GitHub permission: %s', async (scenario) => {
      vi.useFakeTimers();
      const start = new Date(2026, 8, 21, 12);
      vi.setSystemTime(start.getTime() + 30_000);
      const root = await mkdtemp(join(tmpdir(), 'copilot-local-fallback-'));
      roots.push(root);
      vi.stubEnv('APPDATA', join(root, 'roaming'));
      const host = join(root, 'logs', '20260921T120000', 'window1', 'exthost');
      const logFolder = join(host, 'GitHub.copilot-chat');
      await mkdir(logFolder, { recursive: true });
      await writeFile(join(logFolder, 'GitHub Copilot Chat.log'), scenario === 'known account'
        ? '2026-09-21 12:00:00.000 [info] Logged in as alice\n' +
          '2026-09-21 12:00:00.100 [info] Got Copilot token for alice\n' +
          '2026-09-21 12:00:11.000 [info] request done: requestId: [local-request]\n' : '');
      const dataRoot = join(root, 'usage');
      const chatFolder = join(dataRoot, 'debug-logs', 'local-chat');
      await mkdir(chatFolder, { recursive: true });
      await writeFile(join(chatFolder, 'main.jsonl'), [
        { type: 'session_start', ts: start.getTime() + 5_000 },
        { type: 'llm_request', ts: start.getTime() + 10_000, dur: 1000, spanId: 'local-span',
          attrs: { model: 'model', debugName: 'local-chat', responseId: 'local-request',
            inputTokens: 800, outputTokens: 200, copilotUsageNanoAiu: 20_000_000_000 } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const storage = join(root, 'storage');
      const ledger = join(storage, 'account-poc');
      await mkdir(ledger, { recursive: true });
      const savedStart = JSON.stringify({ version: 1, startedAt: start.getTime() });
      await writeFile(join(ledger, 'start.json'), savedStart);
      if (scenario === 'damaged tracking storage') await writeFile(join(ledger, 'observer-abcdef.jsonl'), 'broken\n');
      const realIndex = await vi.importActual<typeof import('../src/core/usageIndex')>('../src/core/usageIndex');
      const { UsageIndex } = await import('../src/core/usageIndex');
      vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
      locateCopilotDataPaths.mockResolvedValue([dataRoot]);
      const context = { ...createContext(), extensionMode: vscode.ExtensionMode.Production,
        logUri: vscode.Uri.file(join(host, 'leonbjorklund.copilot-usage-extension')),
        globalStorageUri: vscode.Uri.file(storage) };
      try {
        activate(context);
        const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
        await vi.waitFor(() => expect(status.text).toBe('1k | 0.2$'));
        expect(status.tooltip.value).toContain('local-chat');
        expect(status.tooltip.value).not.toMatch(/Waiting for account|excluded around account/);
        const rows = await registeredTreeProvider().getChildren();
        expect(rows?.find(row => row.kind === 'bucket')).toMatchObject({ bucket: { tokens: 1000, githubCopilot: { usd: 0.2 } } });
        expect(rows?.some(row => row.kind === 'error')).toBe(scenario === 'damaged tracking storage');
        if (scenario === 'known account') {
          expect(rows?.find(row => row.kind === 'quota')).toMatchObject({ state: { kind: 'waiting' } });
          expect(vscode.authentication.getSession).not.toHaveBeenCalled();
          expect(status.text).toBe('1k | 0.2$');
        }
        if (scenario === 'damaged tracking storage') {
          await commandCallback('copilotUsage.showDiagnostics')();
          expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toContain('Account tracking:');
          expect(await readFile(join(ledger, 'observer-abcdef.jsonl'), 'utf8')).toBe('broken\n');
        }
        expect(await readFile(join(ledger, 'start.json'), 'utf8')).toBe(savedStart);
      } finally {
        for (const disposable of context.subscriptions) disposable.dispose?.();
        vi.useRealTimers();
      }
    });

  it.each([
    { mode: vscode.ExtensionMode.Development, switchedAccount: 'bob' },
    { mode: vscode.ExtensionMode.Development, switchedAccount: 'bob_company' },
    { mode: vscode.ExtensionMode.Production, switchedAccount: 'bob' },
    { mode: vscode.ExtensionMode.Production, switchedAccount: 'bob_company' },
    { mode: vscode.ExtensionMode.Production, switchedAccount: 'bob', otherEditorBase: '.config' },
    { mode: vscode.ExtensionMode.Production, switchedAccount: 'bob', otherEditorBase: 'Library/Application Support' },
  ])("runs the real account pipeline in mode $mode and switches local usage to $switchedAccount with $otherEditorBase", async ({ mode, switchedAccount, otherEditorBase }) => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start);
    const root = await mkdtemp(join(tmpdir(), "copilot-poc-integration-"));
    vi.mocked(homedir).mockReturnValue(root);
    roots.push(root);
    vi.stubEnv("APPDATA", join(root, "roaming"));
    const host = join(root, "logs", "20260921T120000", "window1", "exthost");
    const logFolder = join(host, "GitHub.copilot-chat");
    await mkdir(logFolder, { recursive: true });
    const log = join(logFolder, "GitHub Copilot Chat.log");
    const stamp = (offset: number, text: string) => {
      const d = new Date(start.getTime() + offset);
      return `2026-09-21 12:00:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')} [info] ${text}\n`;
    };
    await writeFile(log, stamp(0, "Logged in as alice") + stamp(100, "Got Copilot token for alice"));
    let aliceLog = log;
    if (otherEditorBase) {
      const otherFolder = join(root, otherEditorBase, 'Code - Insiders', 'logs', '20260921T120000', 'window1', 'exthost', 'GitHub.copilot-chat');
      await mkdir(otherFolder, { recursive: true });
      aliceLog = join(otherFolder, 'GitHub Copilot Chat.log');
      await writeFile(aliceLog, stamp(0, "Logged in as alice") + stamp(100, "Got Copilot token for alice"));
    }
    const dataRoot = join(root, "usage");
    await mkdir(dataRoot);
    async function writeRequest(chat: string, offset: number, credits: number, id: string) {
      const folder = join(dataRoot, "debug-logs", chat);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "main.jsonl"), [
        { type: "session_start", ts: start.getTime() + offset - 1_000 },
        { type: "llm_request", ts: start.getTime() + offset, dur: 1000, spanId: id, sid: chat,
          attrs: { model: "model", debugName: chat, responseId: id, inputTokens: 80, outputTokens: 20,
            copilotUsageNanoAiu: credits * 1_000_000_000 } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
    await writeRequest("historical", -86_400_000, 99, "old");
    const realIndex = await vi.importActual<typeof import("../src/core/usageIndex")>("../src/core/usageIndex");
    const { UsageIndex } = await import("../src/core/usageIndex");
    vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
    locateCopilotDataPaths.mockResolvedValue([dataRoot]);
    const context = { ...createContext(), extensionMode: mode,
      logUri: vscode.Uri.file(join(host, "leonbjorklund.copilot-usage-extension")),
      globalStorageUri: vscode.Uri.file(join(root, "storage")) };
    try {
      vi.setSystemTime(start.getTime() + 1_000);
      activate(context);
      const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      await vi.waitFor(() => expect(status.text).toBe('No sessions today'));
      await writeRequest('alice-chat', 5_000, 2, 'alice-request');
      await appendFile(aliceLog, stamp(6_000, 'request done: requestId: [alice-request] model deployment ID: []'));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(status.text).toBe('100 | 0.02$'));
      expect(status.tooltip.value).toContain('alice-chat');
      expect(status.tooltip.value).not.toContain('historical');
      expect(status.tooltip.value).not.toContain('Last 30 days');
      await appendFile(log, stamp(10_000, `Logged in as ${switchedAccount}`) + stamp(10_100, `Got Copilot token for ${switchedAccount}`));
      await writeRequest('bob-chat', 14_000, 5, 'bob-request');
      await appendFile(log, stamp(15_000, 'request done: requestId: [bob-request] model deployment ID: []'));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(status.text).toBe('100 | 0.1$'));
      expect(status.tooltip.value).toContain('bob-chat');
      expect(status.tooltip.value).not.toContain('alice-chat');
      const children = await registeredTreeProvider().getChildren();
      expect(children?.[0]).toMatchObject({ kind: 'quota', state: { kind: 'waiting' } });
      expect(children?.[1]).toMatchObject({ kind: 'bucket', bucket: { tokens: 100, githubCopilot: { aiCredits: 5 } } });
      expect(children?.[2]).toMatchObject({ kind: 'bucket', bucket: { label: 'Yesterday', tokens: 100,
        chats: [expect.objectContaining({ title: 'historical' })] } });
      expect(vscode.authentication.getSession).not.toHaveBeenCalled();

      // A delayed completion from Alice must not hide Bob's confirmed usage.
      await writeRequest('alice-delayed', 6_500, 3, 'delayed-request');
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(async () => {
        await commandCallback('copilotUsage.showDiagnostics')();
        expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toContain('unresolved requests: 1');
      });
      expect(status.text).toBe('100 | 0.1$');
      expect(status.tooltip.value).not.toContain('Last 30 days');
      expect(status.tooltip.value).toContain('bob-chat');
      expect(status.tooltip.value).not.toContain('Waiting for account evidence');
      expect((await registeredTreeProvider().getChildren())?.some((row) => row.kind === 'error')).toBe(false);
      expect((await registeredTreeProvider().getChildren())?.some((row) => row.kind === 'bucket')).toBe(true);

      await appendFile(log, stamp(7_500, 'request done: requestId: [delayed-request]'));
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(async () => {
        await commandCallback('copilotUsage.showDiagnostics')();
        expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toContain('unresolved requests: 0');
      });
      expect(status.text).toBe('100 | 0.1$');

      // Switching accounts must restore saved local usage without waiting for quota.
      const switchAt = Date.now() - start.getTime();
      await appendFile(log, stamp(switchAt, 'Logged in as alice') + stamp(switchAt + 100, 'Got Copilot token for alice'));
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(status.text).toBe('200 | 0.1$'));
      expect(status.tooltip.value).toContain('alice-delayed');
      expect(status.tooltip.value).not.toContain('bob-chat');
      const aliceRows = await registeredTreeProvider().getChildren();
      expect(aliceRows?.find((row) => row.kind === 'quota')).toMatchObject({ state: { kind: 'waiting' } });
      const aliceBucket = aliceRows?.find((row) => row.kind === 'bucket');
      expect(aliceBucket?.kind === 'bucket' && aliceBucket.bucket.chats.map((chat) => chat.title).sort()).toEqual(['alice-chat', 'alice-delayed']);
      // A second real pipeline shares the journal but follows its own window.
      const secondHost = join(root, 'logs', '20260921T120000', 'window2', 'exthost');
      const secondLogFolder = join(secondHost, 'GitHub.copilot-chat');
      await mkdir(secondLogFolder, { recursive: true });
      await writeFile(join(secondLogFolder, 'GitHub Copilot Chat.log'),
        stamp(0, `Logged in as ${switchedAccount}`) + stamp(100, `Got Copilot token for ${switchedAccount}`));
      const secondContext = { ...context, subscriptions: [], logUri: vscode.Uri.file(join(secondHost, 'leonbjorklund.copilot-usage-extension')) };
      const secondStatus = { show: vi.fn() } as unknown as vscode.StatusBarItem;
      vi.mocked(vscode.window.createStatusBarItem).mockReturnValueOnce(secondStatus);
      vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
      try {
        activate(secondContext);
        await vi.waitFor(() => expect(secondStatus.text).toBe('100 | 0.1$'));
        expect((secondStatus.tooltip as vscode.MarkdownString).value).toContain('bob-chat');
        expect((secondStatus.tooltip as vscode.MarkdownString).value).not.toContain('alice-delayed');
        await vi.advanceTimersByTimeAsync(3_000);
        expect(status.text).toBe('200 | 0.1$');
        expect(secondStatus.text).toBe('100 | 0.1$');
      } finally {
        for (const disposable of secondContext.subscriptions as vscode.Disposable[]) disposable.dispose?.();
      }

      // Restart with no usage logs. Persisted account totals survive.
      for (const disposable of context.subscriptions.splice(0)) disposable.dispose?.();
      await rm(dataRoot, { recursive: true, force: true });
      vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
      vi.mocked(vscode.window.createStatusBarItem).mockReturnValueOnce(status);
      activate(context);
      await vi.waitFor(() => expect(status.text).toBe('200 | 0.1$'));
      expect(status.tooltip.value).toContain('alice-delayed');
      expect(status.tooltip.value).not.toContain('Last 30 days');
      expect(status.tooltip.value).not.toContain('bob-chat');
      // Surviving title metadata still updates saved chats after debug-log rotation.
      await mkdir(join(dataRoot, 'chatSessions'), { recursive: true });
      await writeFile(join(dataRoot, 'chatSessions', 'alice-delayed.json'), JSON.stringify({ kind: 0, v: {
        sessionId: 'alice-delayed', customTitle: 'Alice retained rename', creationDate: start.getTime(),
      } }));
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(status.tooltip.value).toContain('Alice retained rename'));
      expect(status.text).toBe('200 | 0.1$');
      expect(status.tooltip.value).not.toContain('bob-chat');
      expect(status.tooltip.value).not.toContain('Last 30 days');
    } finally {
      for (const disposable of context.subscriptions) disposable.dispose?.();
      vi.useRealTimers();
    }
  });


});

function createTotal(tokens: number, githubUsd?: number) {
  return {
    tokens,
    githubCopilot: createCost(githubUsd ?? 0),
  };
}

function createConfig(dataPath = ""): ExtensionConfig {
  return {
    dataPath,
    maxFileSizeMb: 10,
    maxScanDepth: 6,
  };
}

function createEmptySummary(): UsageSummary {
  return {
    today: createTotal(0),
    week: createTotal(0),
    month: createTotal(0),
    allTime: createTotal(0),
    topModels: [],
    chats: [],
    highestSessionToday: undefined,
  };
}

function createSummaryWithTokens(tokens: number): UsageSummary {
  return {
    today: createTotal(tokens),
    week: createTotal(tokens),
    month: createTotal(tokens),
    allTime: createTotal(tokens),
    topModels: [{ model: "model", sessions: 1, tokens, githubCopilot: createCost(0) }],
    chats: [],
    highestSessionToday: undefined,
  };
}

function createDiagnostics(): UsageDiagnostics {
  return {
    roots: 1,
    files: 0,
    parsedRecords: 0,
    normalizedRecords: 0,
    skippedMalformedFiles: 0,
    skippedRecords: 0,
    scannedFiles: 0,
    skippedFolders: 0,
    unsupportedFiles: 0,
    oversizedFiles: 0,
    unreadableFiles: 0,
  };
}

function createContext(sortMode?: string): vscode.ExtensionContext {
  return {
    subscriptions: [],
    logUri: { fsPath: "C:/logs/window1/exthost/leonbjorklund.copilot-usage-extension" },
    globalStorageUri: { fsPath: join(tmpdir(), "copilot-usage-extension-test-storage") },
    globalState: {
      get: vi.fn((_key: string, fallback: unknown) => sortMode ?? fallback),
      update: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

async function activateExtension(context = createContext()): Promise<void> {
  activatedContexts.push(context);
  activate(context);
  await settle();
}

async function activatedCommand(command: string): Promise<(...args: unknown[]) => Promise<unknown>> {
  await activateExtension();
  vi.mocked(vscode.commands.executeCommand).mockClear();
  return commandCallback(command);
}

function commandCallback(command: string): (...args: unknown[]) => Promise<unknown> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command ${command} was not registered.`);
  }

  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function registeredTreeProvider(): {
  getChildren: (element?: UsageNode) => UsageNode[] | Promise<UsageNode[] | undefined> | undefined;
} {
  return vi.mocked(vscode.window.registerTreeDataProvider).mock.calls[0][1] as {
    getChildren: (element?: UsageNode) => UsageNode[] | Promise<UsageNode[] | undefined> | undefined;
  };
}

function createCost(usd: number): CopilotCostEstimate {
  return {
    available: usd > 0,
    usd,
    aiCredits: usd * 100,
  };
}

function createChatNode(sources: Array<[filePath: string, timestamp: Date]>): UsageNode {
  return {
    kind: "chat",
    bucketId: "today",
    chat: {
      chatId: "chat-1",
      title: "Feature work",
      model: "gpt-4.1",
      timestamp: sources.at(-1)?.[1] ?? new Date(0),
      tokens: 0,
      githubCopilot: createCost(0),
      records: sources.map(([filePath, timestamp]) => createUsageRecord(filePath, timestamp)),
    },
  };
}

function createSummaryWithChats(chats: ChatUsageSummary[]): UsageSummary {
  const tokens = chats.reduce((sum, chat) => sum + chat.tokens, 0);
  const usd = chats.reduce((sum, chat) => sum + chat.githubCopilot.usd, 0);
  return {
    today: createTotal(tokens, usd),
    week: createTotal(tokens, usd),
    month: createTotal(tokens, usd),
    allTime: createTotal(tokens, usd),
    topModels: [],
    chats,
    highestSessionToday: chats[0],
  };
}

function createChatSummary(
  chatId: string,
  timestamp: Date,
  tokens: number,
  githubUsd: number,
): ChatUsageSummary {
  return {
    chatId,
    title: chatId,
    model: "gpt-4.1",
    timestamp,
    tokens,
    githubCopilot: createCost(githubUsd),
    records: [],
  };
}

function createUsageRecord(filePath: string, timestamp: Date): UsageRecord {
  return {
    chatId: "chat-1",
    title: "Feature work",
    timestamp,
    model: "gpt-4.1",
    tokens: {
      input: 0,
      cachedInput: 0,
      output: 0,
      cacheWriteInput: 0,
      total: 0,
      source: "recorded",
    },
    filePath,
  };
}

function createSourceLogPick(filePath: string): { label: string; description: string; filePath: string } {
  return {
    label: filePath.split("/").at(-1) ?? filePath,
    description: filePath,
    filePath,
  };
}
