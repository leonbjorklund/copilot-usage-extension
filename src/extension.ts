import { stat } from "node:fs/promises";
import { basename } from "node:path";

import * as vscode from "vscode";

import {
  COPILOT_FILE_LOGGING_SETTING,
  isCopilotFileLoggingEnabled,
  readConfig,
} from "./core/config";
import { locateCopilotDataPaths } from "./core/locator";
import { isSameOrInsidePath, pathContainsUsageFolder } from "./core/scanner";
import type {
  CopilotCostEstimate,
  ExtensionConfig,
  UsageDiagnostics,
  UsageSummary,
} from "./core/types";
import { UsageIndex } from "./core/usageIndex";
import { formatTokens, formatUsd } from "./ui/formatters";
import { formatDiagnostics, UsageTreeProvider, type UsageNode } from "./ui/usageTreeProvider";

const STATUS_BAR_DISPLAY = {
  scanningText: "Scanning Sessions...",
  failedText: "Scan Failed",
  setupNeededText: "Enable Copilot logs to see token use",
  tooltip: "Click to open Copilot usage.",
  separator: " | ",
};
const SETUP_NEEDED_CONTEXT = "copilotUsage.setupNeeded";

const USAGE_WATCH_GLOB =
  "**/{github.copilot-chat,GitHub.copilot-chat,debug-logs,transcripts,chatSessions,chatsessions,emptyWindowChatSessions,emptywindowchatsessions}/**";
const CUSTOM_DATA_PATH_WATCH_GLOB = "**/*.{json,jsonl}";
const GITHUB_COPILOT_USAGE_BASED_BILLING_URL =
  "https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals";
const TOOLTIP_TITLE = `Cost is based on <a href="${GITHUB_COPILOT_USAGE_BASED_BILLING_URL}">GitHub Copilot Usage-based billing $(link-external)</a>`;

interface SourceLogPick extends vscode.QuickPickItem {
  filePath: string;
}

interface SourceLog {
  filePath: string;
  timestamp: Date;
}

function formatSessionCount(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

function formatStatusBarCost(cost: CopilotCostEstimate): string | undefined {
  return cost.available && cost.aiCredits > 0 ? formatUsd(cost.usd) : undefined;
}

export function formatStatusBarTooltip(summary: UsageSummary): vscode.MarkdownString {
  const summaryItems = [
    formatTooltipSummaryItem("Today", summary.today),
    formatTooltipSummaryItem("Month", summary.month),
    formatTooltipSummaryItem("All time", summary.allTime),
  ];
  const lines = [TOOLTIP_TITLE, "", summaryItems.join(" &nbsp; | &nbsp; "), "", "---", ""];

  const topModelRows = summary.topModels.map((model, index) =>
    formatTopModelTableRow(
      index,
      model.model,
      model.sessions,
      formatTokensWithCost(model.tokens, model.githubCopilot),
    ),
  );
  lines.push(...formatTopModelsTooltipRows(topModelRows));

  lines.push("", "---", "", ...formatHighestTodayTooltipRows(summary));

  lines.push("", "---", "", "Click for detailed chat entries");
  const tooltip = new vscode.MarkdownString(lines.join("\n"), true);
  tooltip.supportHtml = true;
  return tooltip;
}

function formatTooltipSummaryItem(label: string, total: UsageSummary["today"]): string {
  return `**${label}:** ${formatTokensWithCost(total.tokens, total.githubCopilot)}`;
}

function formatTokensWithCost(tokens: number, costEstimate: CopilotCostEstimate): string {
  const cost = formatStatusBarCost(costEstimate);
  return `${formatTokens(tokens)}${cost ? ` (${cost})` : ""}`;
}

function formatTopModelTableRow(
  index: number,
  model: string,
  sessions: number,
  value: string,
): string {
  return `<tr><td>${index + 1}. ${escapeHtml(model)}</td><td align="right">${formatSessionCount(sessions)} | ${escapeHtml(value)}</td></tr>`;
}

function formatTopModelsTooltipRows(rows: string[]): string[] {
  return formatTooltipTable([
    '<tr><td colspan="2"><strong>Model use:</strong></td></tr>',
    ...(rows.length > 0 ? rows : ['<tr><td colspan="2">No sessions yet.</td></tr>']),
  ]);
}

function formatTooltipTable(rows: string[]): string[] {
  return ['<table width="100%">', ...rows, "</table>"];
}

function formatHighestTodayTooltipRows(summary: UsageSummary): string[] {
  if (!summary.highestSessionToday) {
    return ["**Today highlights:**", "No sessions today."];
  }

  const rows = formatTooltipTable(
    formatTodayHighlightTableRows("Most tokens today", summary.highestSessionToday),
  );
  if (summary.mostExpensiveSessionToday) {
    rows.push(
      "",
      "---",
      "",
      ...formatTooltipTable(
        formatTodayHighlightTableRows("Most expensive today", summary.mostExpensiveSessionToday),
      ),
    );
  }

  return rows;
}

function formatTodayHighlightTableRows(
  label: string,
  chat: NonNullable<UsageSummary["highestSessionToday"]>,
): string[] {
  return [
    `<tr><td colspan="2"><strong>${label}:</strong></td></tr>`,
    `<tr><td>${escapeHtml(chat.title)} | ${escapeHtml(chat.model)}</td><td align="right">${escapeHtml(formatTokensWithCost(chat.tokens, chat.githubCopilot))}</td></tr>`,
  ];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatStatusBarSummary(summary: UsageSummary): string {
  if (summary.today.tokens === 0) {
    return "No sessions today";
  }

  const cost = formatStatusBarCost(summary.today.githubCopilot);
  return cost
    ? [formatTokens(summary.today.tokens), cost].join(STATUS_BAR_DISPLAY.separator)
    : formatTokens(summary.today.tokens);
}

function setStatusBarScanning(statusBar: vscode.StatusBarItem): void {
  statusBar.text = STATUS_BAR_DISPLAY.scanningText;
  statusBar.tooltip = STATUS_BAR_DISPLAY.tooltip;
  statusBar.command = "copilotUsage.openView";
}

function setStatusBarReady(statusBar: vscode.StatusBarItem, summary: UsageSummary): void {
  statusBar.text = formatStatusBarSummary(summary);
  statusBar.tooltip = formatStatusBarTooltip(summary);
  statusBar.command = "copilotUsage.openView";
}

function setStatusBarFailed(statusBar: vscode.StatusBarItem, error: unknown): void {
  statusBar.text = STATUS_BAR_DISPLAY.failedText;
  statusBar.tooltip = error instanceof Error ? error.message : String(error);
  statusBar.command = "copilotUsage.openView";
}

function setStatusBarSetupNeeded(statusBar: vscode.StatusBarItem): void {
  statusBar.text = STATUS_BAR_DISPLAY.setupNeededText;
  statusBar.tooltip = undefined;
  statusBar.command = "copilotUsage.openCopilotLoggingSetting";
}

export function activate(context: vscode.ExtensionContext): void {
  const treeProvider = new UsageTreeProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const usageIndex = new UsageIndex();
  let latestDiagnostics: UsageDiagnostics | undefined;
  let currentConfig: ExtensionConfig = readConfig();
  let generation = 0;
  const watcherDisposablesByFolder = new Map<string, vscode.Disposable[]>();
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let eventGeneration = 0;
  let updateChain = Promise.resolve();
  const changedPaths = new Set<string>();
  const deletedPaths = new Set<string>();

  statusBar.command = "copilotUsage.openView";
  setStatusBarScanning(statusBar);
  statusBar.show();

  async function runRefresh(): Promise<void> {
    const refreshGeneration = ++generation;
    try {
      if (!isCopilotFileLoggingEnabled()) {
        treeProvider.setSetupNeeded();
        void setSetupNeededContext(true);
        setStatusBarSetupNeeded(statusBar);
        disposeWatchers();
        return;
      }

      void setSetupNeededContext(false);
      currentConfig = readConfig();
      const config = currentConfig;
      setStatusBarScanning(statusBar);

      const roots = await locateCopilotDataPaths(config.dataPath);
      const result = await usageIndex.rebuild({ roots, config });
      if (refreshGeneration !== generation) {
        return;
      }

      applyResult(result);
      syncWatchers(usageIndex.getWatchFolders());
    } catch (error) {
      if (refreshGeneration === generation) {
        setStatusBarFailed(statusBar, error);
      }
    }
  }

  async function openView(): Promise<void> {
    await vscode.commands.executeCommand("copilotUsage.views.usage.focus");
  }

  async function openSourceLog(node: UsageNode | undefined): Promise<void> {
    if (node?.kind !== "chat") {
      return;
    }

    const sourceLogs = buildSourceLogPicks(node);
    if (sourceLogs.length === 0) {
      await vscode.window.showInformationMessage("No source log available for this session.");
      return;
    }

    if (sourceLogs.length === 1) {
      await openFile(sourceLogs[0].filePath);
      return;
    }

    const selected = await vscode.window.showQuickPick(sourceLogs, {
      placeHolder: "Open source log",
    });
    if (selected) {
      await openFile(selected.filePath);
    }
  }

  async function openFile(filePath: string): Promise<void> {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
  }

  function applyResult(result: { summary: UsageSummary; diagnostics: UsageDiagnostics }): void {
    latestDiagnostics = result.diagnostics;
    void setSetupNeededContext(false);
    treeProvider.setSummary(result.summary);
    setStatusBarReady(statusBar, result.summary);
  }

  function setSetupNeededContext(value: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand("setContext", SETUP_NEEDED_CONTEXT, value);
  }

  function syncWatchers(folders: string[]): void {
    const desiredFolders = new Set(folders);
    for (const folder of watcherDisposablesByFolder.keys()) {
      if (!desiredFolders.has(folder)) {
        disposeFolderWatchers(folder);
      }
    }

    for (const folder of folders) {
      if (watcherDisposablesByFolder.has(folder)) {
        continue;
      }

      watcherDisposablesByFolder.set(folder, [...registerUsageWatcher(folder)]);
    }
  }

  function disposeWatchers(): void {
    for (const folder of watcherDisposablesByFolder.keys()) {
      disposeFolderWatchers(folder);
    }
  }

  function disposeFolderWatchers(folder: string): void {
    const disposables = watcherDisposablesByFolder.get(folder);
    if (!disposables) {
      return;
    }

    for (const disposable of disposables) {
      disposable.dispose();
    }
    watcherDisposablesByFolder.delete(folder);
  }

  function registerUsageWatcher(folder: string): vscode.Disposable[] {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(folder), watchGlobForFolder(folder)),
    );
    return [
      watcher,
      watcher.onDidChange((uri) => scheduleFileUpdate(uri.fsPath)),
      watcher.onDidCreate((uri) => {
        void scheduleCreatedPath(uri.fsPath);
      }),
      watcher.onDidDelete((uri) => scheduleDelete(uri.fsPath)),
    ];
  }

  function watchGlobForFolder(folder: string): string {
    return isCustomDataWatchFolder(folder) ? CUSTOM_DATA_PATH_WATCH_GLOB : USAGE_WATCH_GLOB;
  }

  function isCustomDataWatchFolder(folder: string): boolean {
    const dataPath = currentConfig.dataPath.trim();
    return dataPath.length > 0 && isSameOrInsidePath(folder, dataPath);
  }

  async function scheduleCreatedPath(path: string): Promise<void> {
    try {
      const fileStat = await stat(path);
      if (fileStat.isDirectory()) {
        syncWatchers([...usageIndex.getWatchFolders(), path]);
        scheduleFileUpdate(path, true);
      } else {
        scheduleFileUpdate(path);
      }
    } catch {
      return;
    }
  }

  function scheduleFileUpdate(filePath: string, force = false): void {
    if (!force && !shouldProcessFileEvent(filePath)) {
      return;
    }

    changedPaths.add(filePath);
    deletedPaths.delete(filePath);
    scheduleEventFlush();
  }

  function shouldProcessFileEvent(filePath: string): boolean {
    const dataPath = currentConfig.dataPath.trim();
    return (
      pathContainsUsageFolder(filePath) ||
      (dataPath.length > 0 && isSameOrInsidePath(filePath, dataPath))
    );
  }

  function scheduleDelete(path: string): void {
    deletedPaths.add(path);
    changedPaths.delete(path);
    scheduleEventFlush();
  }

  function scheduleEventFlush(): void {
    eventGeneration = generation;
    if (eventTimer) {
      clearTimeout(eventTimer);
    }

    eventTimer = setTimeout(() => {
      eventTimer = undefined;
      const pathsToUpdate = Array.from(changedPaths);
      const pathsToDelete = Array.from(deletedPaths);
      changedPaths.clear();
      deletedPaths.clear();
      const flushGeneration = eventGeneration;
      updateChain = updateChain
        .then(() => processFileEvents(pathsToUpdate, pathsToDelete, flushGeneration))
        .catch((error: unknown) => setStatusBarFailed(statusBar, error));
    }, 100);
  }

  async function processFileEvents(
    pathsToUpdate: string[],
    pathsToDelete: string[],
    flushGeneration: number,
  ): Promise<void> {
    if (flushGeneration !== generation) {
      return;
    }

    const config = currentConfig;
    const result = await usageIndex.applyChanges({
      pathsToDelete,
      pathsToUpdate,
      config,
    });

    if (flushGeneration !== generation) {
      return;
    }

    applyResult(result);
    syncWatchers(usageIndex.getWatchFolders());
  }

  context.subscriptions.push(
    statusBar,
    vscode.window.registerTreeDataProvider("copilotUsage.views.usage", treeProvider),
    vscode.commands.registerCommand("copilotUsage.refresh", () => runRefresh()),
    vscode.commands.registerCommand("copilotUsage.openView", () => openView()),
    vscode.commands.registerCommand("copilotUsage.openSourceLog", (node?: UsageNode) =>
      openSourceLog(node),
    ),
    vscode.commands.registerCommand("copilotUsage.openCopilotLoggingSetting", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@id:${COPILOT_FILE_LOGGING_SETTING}`,
      ),
    ),
    vscode.commands.registerCommand("copilotUsage.showDiagnostics", () =>
      vscode.window.showInformationMessage(
        latestDiagnostics
          ? formatDiagnostics(latestDiagnostics)
          : "No Copilot usage scan has completed yet.",
        { modal: true },
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration("copilotUsage") &&
        !event.affectsConfiguration(COPILOT_FILE_LOGGING_SETTING)
      ) {
        return;
      }

      void runRefresh();
    }),
    new vscode.Disposable(() => {
      disposeWatchers();
      if (eventTimer) {
        clearTimeout(eventTimer);
      }
    }),
  );

  void runRefresh();
}

export function deactivate(): void {}

function buildSourceLogPicks(node: Extract<UsageNode, { kind: "chat" }>): SourceLogPick[] {
  const logsByPath = new Map<string, SourceLog>();

  for (const record of node.chat.records) {
    const existing = logsByPath.get(record.filePath);
    if (existing && existing.timestamp >= record.timestamp) {
      continue;
    }

    logsByPath.set(record.filePath, {
      filePath: record.filePath,
      timestamp: record.timestamp,
    });
  }

  return Array.from(logsByPath.values()).sort(
    (left, right) => right.timestamp.getTime() - left.timestamp.getTime(),
  ).map((log) => ({
    label: basename(log.filePath),
    description: log.filePath,
    filePath: log.filePath,
  }));
}
