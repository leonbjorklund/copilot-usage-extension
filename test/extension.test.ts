import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    rebuild: ReturnType<typeof vi.fn>;
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
      readonly value: string,
      supportThemeIcons?: boolean,
    ) {
      this.supportThemeIcons = supportThemeIcons;
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
import { CopilotAccountWatcher } from "../src/core/copilotAccount";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

vi.mock("../src/core/locator", () => ({ locateCopilotDataPaths }));
vi.mock("../src/core/copilotAccount", () => ({
  CopilotAccountWatcher: vi.fn().mockImplementation(function () {
    return {
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      currentLogin: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
  }),
}));
vi.mock("../src/core/config", () => ({
  COPILOT_FILE_LOGGING_SETTING: "github.copilot.chat.agentDebugLog.fileLogging.enabled",
  isCopilotFileLoggingEnabled: vi.fn(() => state.copilotFileLoggingEnabled),
  readConfig,
}));
vi.mock("../src/core/usageIndex", () => ({
  UsageIndex: vi.fn().mockImplementation(function () {
    const instance = {
      rebuild: vi.fn(() => Promise.resolve(state.rebuildResults.shift() ?? state.usageIndexResult)),
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
import type { UsageNode } from "../src/ui/usageTreeProvider";

describe("formatStatusBarTooltip", () => {
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
    expect(tooltip.value).toContain('<tr><td colspan="2"><strong>Model use:</strong></td></tr>');
    expect(tooltip.value).not.toContain('<strong>Model usage:</strong>');
    expect(tooltip.value).not.toContain('<strong>Top models:</strong>');
    expect(tooltip.value).toContain(
      '<td>1. Claude opus 4.6</td><td align="right">12 sessions · 5.2M (8.4$)</td>',
    );
    expect(tooltip.value).not.toContain("<em>Claude opus 4.6</em>");
    expect(tooltip.value).toContain(
      '<tr><td colspan="2"><strong>Top sessions today:</strong></td></tr>',
    );
    expect(tooltip.value).toContain(
      '<td>Feature work <span style="color:var(--vscode-descriptionForeground);">Claude opus 4.6</span></td><td align="right">420k (2.1$)</td>',
    );
    expect(tooltip.value).not.toContain("Most tokens today:");
    expect(tooltip.value).not.toContain("Most expensive today:");
    expect(tooltip.value.indexOf("Cost audit")).toBeLessThan(tooltip.value.indexOf("Feature work"));
    expect(tooltip.value.match(/---/g)).toHaveLength(2);
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
        '<tr><td colspan="2"><strong>Model use:</strong></td></tr>',
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

  it("formats status bar as no sessions today when today has no tokens", () => {
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
      '<strong>Top sessions today:</strong></td></tr>\n<tr><td colspan="2">No sessions today.</td></tr>',
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
      entitlement: 1500, remaining: 841, percentRemaining: 841 / 15,
      unlimited: false, overageCount: 0, resetDate: new Date("2026-10-01"),
    };
    expect(formatStatusBarSummary(summary, quota, new Date("2026-09-21"))).toBe("2.1M | 8.3$ • 44/100%");
    expect(formatStatusBarSummary(summary)).toBe("2.1M | 8.3$");
    summary.today = createTotal(0);
    expect(formatStatusBarSummary(summary, quota, new Date("2026-09-21"))).toBe("No sessions today • 44/100%");
  });

});

describe("activate", () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    usageIndexInstances.length = 0;
    watcherRegistrations.length = 0;
    state.usageIndexResult = { summary: createEmptySummary(), diagnostics: createDiagnostics() };
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
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
    expect(locateCopilotDataPaths).not.toHaveBeenCalled();
    expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled();
    // The quota does not come from the logs, so it is still read.
    expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", [], { silent: true });
  });

  it("clears the setup context after a scan completes", async () => {
    await activateExtension();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "copilotUsage.setupNeeded",
      false,
    );
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
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
    await settle();

    expect(usageIndexInstances[0].applyChanges).not.toHaveBeenCalled();
  });

  it("keeps existing watchers after processing a changed file", async () => {
    vi.useFakeTimers();

    await activateExtension();
    const firstWatcher = watcherRegistrations[0].watcher;

    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/usage.jsonl" });
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
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
    await vi.runAllTimersAsync();
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

  it("offers the consent row when GitHub grants no silent session", async () => {
    await activateExtension();
    await settle();

    const rootChildren = (await registeredTreeProvider().getChildren()) ?? [];
    expect(rootChildren[0]).toEqual({ kind: "quota", state: { kind: "needs-consent" } });
  });

  it.each(['logging disabled', 'scan failed'])("keeps quota available in development with %s", async (failure) => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'copilot-quota-independent-'));
    roots.push(root);
    if (failure === 'logging disabled') state.copilotFileLoggingEnabled = false;
    else locateCopilotDataPaths.mockRejectedValue(new Error('Cannot scan logs'));
    const context = { ...createContext(), extensionMode: vscode.ExtensionMode.Development,
      globalStorageUri: vscode.Uri.file(join(root, 'storage')) };
    try {
      activate(context);
      await vi.waitFor(async () => expect((await registeredTreeProvider().getChildren())?.[0]).toEqual({
        kind: 'quota', state: { kind: 'needs-consent' },
      }));
      vi.mocked(vscode.authentication.getSession).mockResolvedValue({
        id: 'alice', accessToken: 'test', scopes: [], account: { id: 'alice', label: 'alice' },
      });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ quota_snapshots: { premium_models: {
        entitlement: 100, percent_remaining: 50, reset_date: '2026-10-01',
      } } }))));
      await commandCallback('copilotUsage.connectQuota')();
      const rows = await registeredTreeProvider().getChildren();
      expect(rows?.[0]).toMatchObject({ kind: 'quota', state: { account: 'alice', quota: { remaining: 50 } } });
      expect(rows?.[1].kind).toBe(failure === 'logging disabled' ? 'setup' : 'error');
    } finally {
      for (const disposable of context.subscriptions) disposable.dispose?.();
      vi.mocked(vscode.authentication.getSession).mockReset().mockResolvedValue(undefined);
    }
  });

  it("updates the ready status when quota arrives and removes it when access is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    state.usageIndexResult = {
      summary: { ...createEmptySummary(), today: createTotal(2_100_000, 0.87) },
      diagnostics: createDiagnostics(),
    };
    vi.mocked(vscode.authentication.getSession).mockResolvedValueOnce({
      id: "test", accessToken: "test", scopes: [], account: { id: "test", label: "test" },
    });
    let respond!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const context = createContext();
    try {
      await activateExtension(context);
      await settle();
      const statusBar = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      expect(statusBar.text).toBe("2.1M | 0.9$");
      respond(new Response(JSON.stringify({ quota_snapshots: { premium_models: {
        entitlement: 1500, percent_remaining: 841 / 15, reset_date: "2026-10-01",
      } } })));
      await vi.waitFor(() => expect(statusBar.text).toBe("2.1M | 0.9$ • 44/100%"));
      expect(statusBar.command).toBe("copilotUsage.openView");
      await commandCallback("copilotUsage.connectQuota")();
      expect(statusBar.text).toBe("2.1M | 0.9$");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      for (const disposable of context.subscriptions) { disposable.dispose?.(); }
    }
  });

  it("asks for consent only when the user clicks the quota row", async () => {
    await activateExtension();
    expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", [], { silent: true });

    await commandCallback("copilotUsage.connectQuota")();

    expect(vscode.authentication.getSession).toHaveBeenLastCalledWith("github", [], {
      createIfNone: true,
      clearSessionPreference: true,
    });
  });

  it.each([
    { mode: vscode.ExtensionMode.Development, switchedAccount: 'bob' },
    { mode: vscode.ExtensionMode.Development, switchedAccount: 'bob_company' },
    { mode: vscode.ExtensionMode.Production, switchedAccount: 'bob' },
    { mode: vscode.ExtensionMode.Production, switchedAccount: 'bob_company' },
  ])("runs the real account pipeline in mode $mode and switches quota and usage to $switchedAccount", async ({ mode, switchedAccount }) => {
    vi.useFakeTimers();
    const start = new Date(2026, 8, 21, 12);
    vi.setSystemTime(start);
    const root = await mkdtemp(join(tmpdir(), "copilot-poc-integration-"));
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
    await writeRequest("historical", -60_000, 99, "old");
    const realIndex = await vi.importActual<typeof import("../src/core/usageIndex")>("../src/core/usageIndex");
    const { UsageIndex } = await import("../src/core/usageIndex");
    vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
    const realAccount = await vi.importActual<typeof import("../src/core/copilotAccount")>("../src/core/copilotAccount");
    vi.mocked(CopilotAccountWatcher).mockImplementationOnce(function (path) { return new realAccount.CopilotAccountWatcher(path); });
    locateCopilotDataPaths.mockResolvedValue([dataRoot]);
    const accounts = ['alice', switchedAccount].map((label) => ({ id: label, label }));
    vi.mocked(vscode.authentication.getAccounts).mockResolvedValue(accounts);
    vi.mocked(vscode.authentication.getSession).mockImplementation(async (_provider, _scopes, options) => ({
      id: options?.account?.id ?? 'alice', accessToken: 'test-token', scopes: [], account: options?.account ?? accounts[0],
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ quota_snapshots: { premium_models: {
      entitlement: 100, percent_remaining: 50, overage_count: 0, reset_date: '2026-10-01',
    } } })));
    vi.stubGlobal('fetch', fetchMock);
    const context = { ...createContext(), extensionMode: mode,
      logUri: vscode.Uri.file(join(host, "leonbjorklund.copilot-usage-extension")),
      globalStorageUri: vscode.Uri.file(join(root, "storage")) };
    try {
      vi.setSystemTime(start.getTime() + 1_000);
      activate(context);
      const status = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      await vi.waitFor(() => expect(status.text).toBe('No sessions today • 50/100%'));
      await writeRequest('alice-chat', 5_000, 2, 'alice-request');
      await appendFile(log, stamp(6_000, 'request done: requestId: [alice-request] model deployment ID: []'));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(status.text).toBe('100 | 0$ • 50/100%'));
      expect(status.tooltip.value).toContain('alice-chat');
      expect(status.tooltip.value).not.toContain('historical');
      expect(status.tooltip.value).not.toContain('Last 30 days');
      await appendFile(log, stamp(10_000, `Logged in as ${switchedAccount}`) + stamp(10_100, `Got Copilot token for ${switchedAccount}`));
      await writeRequest('bob-chat', 14_000, 5, 'bob-request');
      await appendFile(log, stamp(15_000, 'request done: requestId: [bob-request] model deployment ID: []'));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(status.text).toBe('100 | 0.1$ • 50/100%'));
      expect(status.tooltip.value).toContain('bob-chat');
      expect(status.tooltip.value).not.toContain('alice-chat');
      const children = await registeredTreeProvider().getChildren();
      expect(children?.[0]).toMatchObject({ kind: 'quota', state: { account: switchedAccount, quota: { remaining: 50 } } });
      expect(children?.[1]).toMatchObject({ kind: 'bucket', bucket: { tokens: 100, githubCopilot: { aiCredits: 5 } } });
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
      expect(vscode.authentication.getSession).toHaveBeenLastCalledWith('github', [], { silent: true, account: accounts[1] });

      // A delayed completion from Alice must not hide Bob's confirmed usage.
      await writeRequest('alice-delayed', 6_500, 3, 'delayed-request');
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(async () => {
        await commandCallback('copilotUsage.showDiagnostics')();
        expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toContain('unresolved requests: 1');
      });
      expect(status.text).toBe('100 | 0.1$ • 50/100%');
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
      expect(status.text).toBe('100 | 0.1$ • 50/100%');

      // Switch back while quota is blocked on the network. Local saved usage
      // must return without waiting for that request or mixing Bob's quota.
      let finishQuota!: (response: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishQuota = resolve; }));
      const switchAt = Date.now() - start.getTime();
      await appendFile(log, stamp(switchAt, 'Logged in as alice') + stamp(switchAt + 100, 'Got Copilot token for alice'));
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(status.text).toBe('200 | 0.1$'));
      expect(status.tooltip.value).toContain('alice-delayed');
      expect(status.tooltip.value).not.toContain('bob-chat');
      const aliceRows = await registeredTreeProvider().getChildren();
      expect(aliceRows?.some((row) => row.kind === 'quota')).toBe(false);
      const aliceBucket = aliceRows?.find((row) => row.kind === 'bucket');
      expect(aliceBucket?.kind === 'bucket' && aliceBucket.bucket.chats.map((chat) => chat.title).sort()).toEqual(['alice-chat', 'alice-delayed']);
      await vi.waitFor(() => expect(finishQuota).toBeTypeOf('function'));
      finishQuota(new Response(JSON.stringify({ quota_snapshots: { premium_models: {
        entitlement: 100, percent_remaining: 75, overage_count: 0, reset_date: '2026-10-01',
      } } })));
      await vi.waitFor(() => expect(status.text).toBe('200 | 0.1$ • 25/100%'));

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
      vi.mocked(CopilotAccountWatcher).mockImplementationOnce(function (path) { return new realAccount.CopilotAccountWatcher(path); });
      try {
        activate(secondContext);
        await vi.waitFor(() => expect(secondStatus.text).toBe('100 | 0.1$ • 50/100%'));
        expect((secondStatus.tooltip as vscode.MarkdownString).value).toContain('bob-chat');
        expect((secondStatus.tooltip as vscode.MarkdownString).value).not.toContain('alice-delayed');
        await vi.advanceTimersByTimeAsync(3_000);
        expect(status.text).toBe('200 | 0.1$ • 25/100%');
        expect(secondStatus.text).toBe('100 | 0.1$ • 50/100%');
      } finally {
        for (const disposable of secondContext.subscriptions as vscode.Disposable[]) disposable.dispose?.();
      }

      // Restart with no usage logs. Persisted account totals survive.
      for (const disposable of context.subscriptions.splice(0)) disposable.dispose?.();
      await rm(dataRoot, { recursive: true, force: true });
      vi.mocked(UsageIndex).mockImplementationOnce(function () { return new realIndex.UsageIndex(); });
      vi.mocked(CopilotAccountWatcher).mockImplementationOnce(function (path) { return new realAccount.CopilotAccountWatcher(path); });
      vi.mocked(vscode.window.createStatusBarItem).mockReturnValueOnce(status);
      activate(context);
      await vi.waitFor(() => expect(status.text).toBe('200 | 0.1$ • 50/100%'));
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
      expect(status.text).toBe('200 | 0.1$ • 50/100%');
      expect(status.tooltip.value).not.toContain('bob-chat');
      expect(status.tooltip.value).not.toContain('Last 30 days');
    } finally {
      for (const disposable of context.subscriptions) disposable.dispose?.();
      vi.useRealTimers();
      vi.mocked(vscode.authentication.getSession).mockReset().mockResolvedValue(undefined);
      vi.mocked(vscode.authentication.getAccounts).mockReset().mockResolvedValue([]);
    }
  });

  it("updates status and tree quota after an account switch without file events or reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    const root = await mkdtemp(join(tmpdir(), "copilot-quota-switch-"));
    roots.push(root);
    const logFolder = join(root, "GitHub.copilot-chat");
    const logPath = join(logFolder, "GitHub Copilot Chat.log");
    await mkdir(logFolder);
    await writeFile(logPath, "[info] Logged in as octocat\n");
    const realAccount = await vi.importActual<typeof import("../src/core/copilotAccount")>("../src/core/copilotAccount");
    vi.mocked(CopilotAccountWatcher).mockImplementationOnce(function (path) {
      return new realAccount.CopilotAccountWatcher(path);
    });
    const accounts = ["octocat", "hubot"].map(label => ({ id: label, label }));
    vi.mocked(vscode.authentication.getAccounts).mockResolvedValue(accounts);
    vi.mocked(vscode.authentication.getSession).mockImplementation(async (_provider, _scopes, options) => ({
      id: options?.account?.id ?? "octocat",
      accessToken: options?.account?.label ?? "octocat",
      scopes: [],
      account: options?.account ?? accounts[0],
    }));
    const fetchMock = vi.fn(async (_url, options: RequestInit) => {
      const isHubot = new Headers(options.headers).get("Authorization")?.includes("hubot");
      return new Response(JSON.stringify({ quota_snapshots: { premium_models: {
        entitlement: isHubot ? 3000 : 1500,
        percent_remaining: isHubot ? 80 : 90,
        reset_date: "2026-10-01",
      } } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    state.usageIndexResult = {
      summary: { ...createEmptySummary(), today: createTotal(2_100_000, 0.87) },
      diagnostics: createDiagnostics(),
    };
    const context = createContext();
    Object.assign(context, { logUri: vscode.Uri.file(join(root, "copilot-usage-extension")) });
    const writer = await open(logPath, "a");
    try {
      await activateExtension(context);
      const statusBar = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      await vi.waitFor(() => expect(statusBar.text).toBe("2.1M | 0.9$ • 10/100%"));
      expect((await registeredTreeProvider().getChildren())?.[0]).toMatchObject({
        kind: "quota", state: { account: "octocat", quota: { remaining: 1350, entitlement: 1500 } },
      });

      await writer.write("[info] Logged in as hubot\n");
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(statusBar.text).toBe("2.1M | 0.9$ • 20/100%"));
      expect((await registeredTreeProvider().getChildren())?.[0]).toMatchObject({
        kind: "quota", state: { account: "hubot", quota: { remaining: 2400, entitlement: 3000 } },
      });
      expect(vscode.authentication.getSession).toHaveBeenLastCalledWith("github", [], {
        silent: true, account: accounts[1],
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      for (const disposable of context.subscriptions) { disposable.dispose?.(); }
      await writer.close();
      vi.mocked(vscode.authentication.getSession).mockReset().mockResolvedValue(undefined);
      vi.mocked(vscode.authentication.getAccounts).mockReset().mockResolvedValue([]);
    }
  });

  it("re-reads the quota once a log write has settled", async () => {
    vi.useFakeTimers();
    state.watchFolders = ["root/GitHub.copilot-chat"];

    await activateExtension();
    vi.mocked(vscode.authentication.getSession).mockClear();

    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/GitHub.copilot-chat/usage.jsonl" });
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();

    // The settle delay and the one-minute floor both run out in fake time.
    await vi.runAllTimersAsync();

    expect(vscode.authentication.getSession).toHaveBeenCalledTimes(1);
    expect(vscode.authentication.getSession).toHaveBeenLastCalledWith("github", [], { silent: true });
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
    globalState: {
      get: vi.fn((_key: string, fallback: unknown) => sortMode ?? fallback),
      update: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function activateExtension(context = createContext()): Promise<void> {
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
