import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    summarize: ReturnType<typeof vi.fn>;
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
    event = vi.fn();
    fire = vi.fn();
  },
  window: {
    createStatusBarItem: vi.fn(),
    registerTreeDataProvider: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
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

vi.mock("../src/core/locator", () => ({ locateCopilotDataPaths }));
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
      summarize: vi.fn(() => state.usageIndexResult),
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
  UsageSummary,
} from "../src/core/types";
import { activate, formatStatusBarSummary, formatStatusBarTooltip } from "../src/extension";

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
    expect(
      tooltip.value.startsWith(
        'Cost is based on <a href="https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals">GitHub Copilot Usage-based billing $(link-external)</a>\n',
      ),
    ).toBe(true);
    expect(tooltip.value).not.toContain("## Today:");
    expect(tooltip.value).not.toContain("Week:");
    expect(tooltip.value).toContain(
      "**Today:** 1.2M (8.4$) &nbsp; | &nbsp; **Month:** 8.9M (21.6$) &nbsp; | &nbsp; **All time:** 22M (42.2$)",
    );
    expect(tooltip.value).toContain("---");
    expect(tooltip.value).not.toContain("GitHub Copilot usage-based");
    expect(tooltip.value).toContain('<tr><td colspan="2"><strong>Model use:</strong></td></tr>');
    expect(tooltip.value).not.toContain('<strong>Model usage:</strong>');
    expect(tooltip.value).not.toContain('<strong>Top models:</strong>');
    expect(tooltip.value).toContain(
      '<td>1. Claude opus 4.6</td><td align="right">12 sessions | 5.2M (8.4$)</td>',
    );
    expect(tooltip.value).not.toContain("<em>Claude opus 4.6</em>");
    expect(tooltip.value).toContain(
      '<tr><td colspan="2"><strong>Most tokens today:</strong></td></tr>',
    );
    expect(tooltip.value).toContain(
      '<td>Feature work | Claude opus 4.6</td><td align="right">420k (2.1$)</td>',
    );
    expect(tooltip.value).toContain(
      '<td>Feature work | Claude opus 4.6</td><td align="right">420k (2.1$)</td></tr>\n</table>\n\n---\n\n<table width="100%">\n<tr><td colspan="2"><strong>Most expensive today:</strong></td></tr>',
    );
    expect(tooltip.value).toContain(
      '<tr><td colspan="2"><strong>Most expensive today:</strong></td></tr>',
    );
    expect(tooltip.value).toContain(
      '<td>Cost audit | Claude opus 4.7</td><td align="right">316k (4.8$)</td>',
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
        "**Today:** 0 &nbsp; | &nbsp; **Month:** 0 &nbsp; | &nbsp; **All time:** 0",
        "",
        "---",
        "",
        '<table width="100%">',
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
    expect(formatStatusBarTooltip(summary).value).not.toContain("GitHub Copilot usage-based");
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
    expect(formatStatusBarTooltip(summary).value).toContain("**Today:** 1k");
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
      ["**Today highlights:**", "No sessions today."].join("\n"),
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
      '<td>1. model &lt;alpha&gt;</td><td align="right">1 session | 1</td>',
    );
    expect(tooltip.value).not.toContain("<em>model &lt;alpha&gt;</em>");
    expect(tooltip.value).toContain("Fix &lt;parser&gt;");
    expect(tooltip.value).not.toContain("model <alpha>");
    expect(tooltip.value).not.toContain("Fix <parser>");
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
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("shows setup action and skips scanning when Copilot file logging is disabled", async () => {
    state.copilotFileLoggingEnabled = false;
    const statusBar = {
      show: vi.fn(),
    } as unknown as vscode.StatusBarItem;
    vi.mocked(vscode.window.createStatusBarItem).mockReturnValue(statusBar);
    const context = createContext();

    activate(context);
    await settle();

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
  });

  it("clears the setup context after a scan completes", async () => {
    const context = createContext();

    activate(context);
    await settle();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "copilotUsage.setupNeeded",
      false,
    );
  });

  it("opens the exact Copilot file logging setting", async () => {
    const context = createContext();

    activate(context);
    await settle();
    const openSetting = commandCallback("copilotUsage.openCopilotLoggingSetting");
    await openSetting();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "@id:github.copilot.chat.agentDebugLog.fileLogging.enabled",
    );
  });

  it("creates scoped file watchers for indexed folders and updates one changed file from cache", async () => {
    vi.useFakeTimers();
    state.watchFolders = ["root/GitHub.copilot-chat"];
    const context = createContext();

    activate(context);
    await settle();

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
    const context = createContext();

    activate(context);
    await settle();

    expect(watcherRegistrations[0].pattern).toMatchObject({
      baseUri: { fsPath: "C:/custom/copilot-logs" },
      pattern: "**/*.{json,jsonl}",
    });
  });

  it("ignores root-level JSON file events outside Copilot usage folders", async () => {
    vi.useFakeTimers();
    const context = createContext();

    activate(context);
    await settle();

    watcherRegistrations[0].handlers.change[0]({ fsPath: "root/other-extension-state.json" });
    await vi.runAllTimersAsync();
    await settle();

    expect(usageIndexInstances[0].applyChanges).not.toHaveBeenCalled();
  });

  it("keeps existing watchers after processing a changed file", async () => {
    vi.useFakeTimers();
    const context = createContext();

    activate(context);
    await settle();
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
    const context = createContext();

    activate(context);
    await settle();

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
    const context = createContext();

    activate(context);
    await settle();

    watcherRegistrations[0].handlers.create[0]({ fsPath: "root/usage.jsonl" });
    await vi.runAllTimersAsync();
    await settle();

    expect(usageIndexInstances[0].applyChanges).not.toHaveBeenCalled();
  });

  it("removes watchers for folders no longer needed after file events", async () => {
    vi.useFakeTimers();
    state.watchFolders = ["root/GitHub.copilot-chat", "root/GitHub.copilot-chat/session"];
    const context = createContext();

    activate(context);
    await settle();
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
    const context = createContext();

    activate(context);
    await settle();

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
    const context = createContext();

    activate(context);
    await settle();
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
    const context = createContext();

    activate(context);
    await settle();

    const refresh = commandCallback("copilotUsage.refresh");
    await refresh();
    rejectFirst(firstError);
    await settle();

    expect(statusBar.text).not.toBe("Scan Failed");
    expect(statusBar.tooltip).not.toBe(firstError.message);
  });

  it("manual refresh rebuilds the full index and keeps unchanged watchers", async () => {
    const context = createContext();

    activate(context);
    await settle();
    const firstWatcher = watcherRegistrations[0].watcher;

    state.watchFolders = ["root", "root/session"];
    const refresh = commandCallback("copilotUsage.refresh");
    await refresh();

    expect(usageIndexInstances[0].rebuild).toHaveBeenCalledTimes(2);
    expect(firstWatcher.dispose).not.toHaveBeenCalled();
    expect(watcherRegistrations).toHaveLength(2);
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

function createContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function commandCallback(command: string): () => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command ${command} was not registered.`);
  }

  return call[1] as () => Promise<void>;
}

function createCost(usd: number): CopilotCostEstimate {
  return {
    available: usd > 0,
    usd,
    aiCredits: usd * 100,
  };
}
