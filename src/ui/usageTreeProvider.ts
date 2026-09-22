import * as vscode from "vscode";

import { estimateRecordCost, mergeCostEstimates } from "../core/aggregator";
import type {
  ChatUsageSummary,
  CopilotCostEstimate,
  UsageDiagnostics,
  UsageRecord,
  UsageSummary,
} from "../core/types";
import type { QuotaState } from "../core/quotaService";
import { CREDIT_USAGE_EXPLANATION, formatQuotaLabel, formatTokens, formatUsd } from "./formatters";

type BucketId = "today" | "yesterday" | "older";
export type UsageTreeSortMode = "time" | "cost";

interface UsageBucket {
  id: BucketId;
  label: string;
  chats: ChatUsageSummary[];
  tokens: number;
  githubCopilot: CopilotCostEstimate;
}

export type UsageNode =
  | {
      kind: "empty";
    }
  /** Scanning failed, so the tree explains itself instead of rendering blank. */
  | {
      kind: "error";
      message: string;
    }
  | {
      kind: "quota";
      state: QuotaRowState;
    }
  /** Stands in for the welcome view when a quota row is already filling the tree. */
  | {
      kind: "setup";
    }
  | {
      kind: "bucket";
      bucket: UsageBucket;
    }
  | {
      kind: "chat";
      chat: ChatUsageSummary;
      bucketId: BucketId;
    };

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageNode>, vscode.Disposable {
  private summary: UsageSummary | undefined;
  private setupNeeded = false;
  private problem: Extract<UsageNode, { kind: "error" }> | undefined;
  private quotaState: QuotaState = { kind: "idle" };
  private readonly changeEmitter = new vscode.EventEmitter<UsageNode | undefined | null | void>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly now = () => new Date(),
    private sortMode: UsageTreeSortMode = "time",
  ) {}

  setSortMode(sortMode: UsageTreeSortMode): void {
    this.sortMode = sortMode;
    this.changeEmitter.fire();
  }

  setQuotaState(state: QuotaState): void {
    this.quotaState = state;
    this.changeEmitter.fire();
  }

  setSummary(summary: UsageSummary, problemMessage?: string): void {
    this.summary = summary;
    this.setupNeeded = false;
    this.problem = problemMessage ? { kind: "error", message: problemMessage } : undefined;
    this.changeEmitter.fire();
  }

  setSetupNeeded(): void {
    this.summary = undefined;
    this.setupNeeded = true;
    this.problem = undefined;
    this.changeEmitter.fire();
  }

  setProblem(message: string): void {
    this.summary = undefined;
    this.setupNeeded = false;
    this.problem = { kind: "error", message };
    this.changeEmitter.fire();
  }

  getChildren(element?: UsageNode): vscode.ProviderResult<UsageNode[]> {
    if (!element) {
      return this.rootRows();
    }

    if (element.kind === "bucket") {
      return element.bucket.chats.map(
        (chat): UsageNode => ({ kind: "chat", chat, bucketId: element.bucket.id }),
      );
    }

    return [];
  }

  /** Quota uses the Copilot output log independently of session file logging. */
  private rootRows(): UsageNode[] {
    const quota: UsageNode[] = showsQuotaRow(this.quotaState)
      ? [{ kind: "quota", state: this.quotaState }]
      : [];

    if (this.setupNeeded) {
      // An empty tree is what makes VS Code draw the welcome view, so the setup
      // prompt only becomes a row once the quota row has taken that away.
      return quota.length > 0 ? [...quota, { kind: "setup" }] : [];
    }

    if (this.problem && !this.summary) {
      return [...quota, this.problem];
    }

    if (!this.summary) {
      return quota;
    }

    const buckets = buildBuckets(this.summary, this.now(), this.sortMode).map(
      (bucket): UsageNode => ({ kind: "bucket", bucket }),
    );
    return [...quota, ...buckets, ...(this.problem ? [this.problem] : buckets.length > 0 ? [] : [{ kind: "empty" } as UsageNode])];
  }

  getTreeItem(element: UsageNode): vscode.TreeItem {
    if (element.kind === "empty") {
      return new vscode.TreeItem("No Copilot usage found", vscode.TreeItemCollapsibleState.None);
    }

    if (element.kind === "error") {
      const item = new vscode.TreeItem("Scan failed", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("error");
      item.tooltip = element.message;
      return item;
    }

    if (element.kind === "quota") {
      return buildQuotaTreeItem(element.state);
    }

    if (element.kind === "setup") {
      const label = "Enable Copilot logs to see token use";
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("gear");
      item.command = { command: "copilotUsage.openCopilotLoggingSetting", title: label };
      return item;
    }

    if (element.kind === "bucket") {
      const item = new vscode.TreeItem(
        element.bucket.label,
        element.bucket.id === "today"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      const sessionCount = `${element.bucket.chats.length} ${element.bucket.chats.length === 1 ? "session" : "sessions"}`;
      item.description = [
        sessionCount,
        formatTokensWithCost(element.bucket.tokens, element.bucket.githubCopilot),
      ].join(" | ");
      item.tooltip = [
        element.bucket.label,
        sessionCount,
        `Tokens: ${Math.round(element.bucket.tokens)}`,
        ...formatCostTooltipLines(element.bucket.githubCopilot),
      ].join("\n");
      return item;
    }

    const item = new vscode.TreeItem(element.chat.title, vscode.TreeItemCollapsibleState.None);
    item.description = formatChatDescription(element.chat, element.bucketId);
    item.tooltip = formatChatTooltip(element.chat);
    item.contextValue = "chat";
    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

type QuotaRowState = Extract<QuotaState, { kind: "quota" | "waiting" }>;

function showsQuotaRow(state: QuotaState): state is QuotaRowState {
  return state.kind === "quota" || (state.kind === "waiting" && !state.reason);
}

function buildQuotaTreeItem(state: QuotaRowState): vscode.TreeItem {
  if (state.kind === "waiting") {
    const item = new vscode.TreeItem("Waiting for Copilot quota", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("credit-card");
    return item;
  }

  const item = new vscode.TreeItem(
    formatQuotaLabel(state.quota),
    vscode.TreeItemCollapsibleState.None,
  );
  item.iconPath = new vscode.ThemeIcon("credit-card");
  if (state.account) item.description = `Account: ${state.account}`;
  if (!state.quota.unlimited && state.quota.entitlement > 0) {
    item.tooltip = `${item.label}\n${item.description ? `${item.description}\n` : ""}\n${CREDIT_USAGE_EXPLANATION}`;
  }
  return item;
}

function buildBuckets(
  summary: UsageSummary,
  baseDate: Date,
  sortMode: UsageTreeSortMode,
): UsageBucket[] {
  const buckets: UsageBucket[] = [
    { id: "today", label: "Today", chats: [], tokens: 0, githubCopilot: emptyCostEstimate() },
    {
      id: "yesterday",
      label: "Yesterday",
      chats: [],
      tokens: 0,
      githubCopilot: emptyCostEstimate(),
    },
    { id: "older", label: "Older", chats: [], tokens: 0, githubCopilot: emptyCostEstimate() },
  ];

  const bucketFor = (date: Date) => {
    const dayDiff = differenceInLocalCalendarDays(date, baseDate);
    return dayDiff === 0 ? buckets[0] : dayDiff === 1 ? buckets[1] : buckets[2];
  };

  for (const chat of summary.chats) {
    // A chat that crosses midnight shows once per bucket, with only that bucket's requests.
    for (const [bucket, part] of splitChatByBucket(chat, bucketFor)) {
      bucket.chats.push(part);
      bucket.tokens += part.tokens;
      bucket.githubCopilot = mergeCostEstimates(bucket.githubCopilot, part.githubCopilot);
    }
  }

  for (const bucket of buckets) {
    bucket.chats.sort(comparerForSortMode(sortMode));
  }

  return buckets.filter((bucket) => bucket.chats.length > 0);
}

function splitChatByBucket(
  chat: ChatUsageSummary,
  bucketFor: (date: Date) => UsageBucket,
): Map<UsageBucket, ChatUsageSummary> {
  const groups = new Map<UsageBucket, UsageRecord[]>();
  for (const record of chat.records) {
    const bucket = bucketFor(record.timestamp);
    const group = groups.get(bucket);
    if (group) group.push(record);
    else groups.set(bucket, [record]);
  }
  if (groups.size <= 1) {
    return new Map([[bucketFor(chat.timestamp), chat]]);
  }

  const parts = new Map<UsageBucket, ChatUsageSummary>();
  for (const [bucket, records] of groups) {
    // Records are newest first, so the first one sets the part's time and model.
    parts.set(bucket, {
      ...chat,
      model: records[0].model,
      timestamp: records[0].timestamp,
      tokens: records.reduce((sum, record) => sum + record.tokens.total, 0),
      githubCopilot: records.map(estimateRecordCost).reduce(mergeCostEstimates, emptyCostEstimate()),
      records,
    });
  }
  return parts;
}

function comparerForSortMode(
  sortMode: UsageTreeSortMode,
): (left: ChatUsageSummary, right: ChatUsageSummary) => number {
  return sortMode === "cost" ? compareChatsByCost : compareChatsByTime;
}

function compareChatsByTime(left: ChatUsageSummary, right: ChatUsageSummary): number {
  return right.timestamp.getTime() - left.timestamp.getTime();
}

function compareChatsByCost(left: ChatUsageSummary, right: ChatUsageSummary): number {
  return (
    right.githubCopilot.aiCredits - left.githubCopilot.aiCredits ||
    right.tokens - left.tokens ||
    compareChatsByTime(left, right)
  );
}

function emptyCostEstimate(): CopilotCostEstimate {
  return {
    available: false,
    usd: 0,
    aiCredits: 0,
  };
}

function formatTokensWithCost(tokens: number, cost: CopilotCostEstimate): string {
  const formattedCost = hasDisplayableCost(cost) ? ` (${formatUsd(cost.usd)})` : "";
  return `${formatTokens(tokens)}${formattedCost}`;
}

function formatCostTooltipLines(cost: CopilotCostEstimate): string[] {
  return hasDisplayableCost(cost) ? [`Cost: ${formatUsd(cost.usd)}`] : [];
}

function hasDisplayableCost(cost: CopilotCostEstimate): boolean {
  return cost.available && cost.aiCredits > 0;
}

export function formatDiagnostics(diagnostics: UsageDiagnostics): string {
  const lines = [
    `Roots: ${diagnostics.roots}`,
    `Files: ${diagnostics.files}`,
    `Parsed records: ${diagnostics.parsedRecords}`,
    `Normalized records: ${diagnostics.normalizedRecords}`,
    `Skipped folders: ${diagnostics.skippedFolders}`,
    `Skipped malformed files: ${diagnostics.skippedMalformedFiles}`,
    `Skipped records: ${diagnostics.skippedRecords}`,
    `Unsupported files: ${diagnostics.unsupportedFiles}`,
    `Oversized files: ${diagnostics.oversizedFiles}`,
    `Unreadable files: ${diagnostics.unreadableFiles}`,
  ];

  return lines.join("\n");
}

function formatChatDescription(chat: ChatUsageSummary, bucketId: BucketId): string {
  const timestamp =
    bucketId === "older" ? formatDateTime(chat.timestamp) : formatTime(chat.timestamp);
  return [timestamp, chat.model, formatTokensWithCost(chat.tokens, chat.githubCopilot)].join(" | ");
}

function formatChatTooltip(chat: ChatUsageSummary): string {
  return [
    `Chat ID: ${chat.chatId}`,
    `Model: ${chat.model}`,
    `Date: ${chat.timestamp.toLocaleString()}`,
    `Tokens: ${Math.round(chat.tokens)}`,
    ...formatCostTooltipLines(chat.githubCopilot),
  ].join("\n");
}

export function differenceInLocalCalendarDays(date: Date, baseDate: Date): number {
  const dateStart = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const baseStart = Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  return Math.floor((baseStart - dateStart) / 86_400_000);
}

function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
