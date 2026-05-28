import * as vscode from "vscode";

import type {
  ChatUsageSummary,
  CopilotCostEstimate,
  UsageDiagnostics,
  UsageSummary,
} from "../core/types";
import { formatTokens, formatUsd } from "./formatters";

type BucketId = "today" | "yesterday" | "older";

interface UsageBucket {
  id: BucketId;
  label: string;
  chats: ChatUsageSummary[];
  tokens: number;
  githubCopilot: CopilotCostEstimate;
}

type UsageNode =
  | {
      kind: "empty";
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

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageNode> {
  private summary: UsageSummary | undefined;
  private setupNeeded = false;
  private readonly changeEmitter = new vscode.EventEmitter<UsageNode | undefined | null | void>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly now = () => new Date()) {}

  setSummary(summary: UsageSummary): void {
    this.summary = summary;
    this.setupNeeded = false;
    this.changeEmitter.fire();
  }

  setSetupNeeded(): void {
    this.summary = undefined;
    this.setupNeeded = true;
    this.changeEmitter.fire();
  }

  getChildren(element?: UsageNode): vscode.ProviderResult<UsageNode[]> {
    if (this.setupNeeded) {
      return [];
    }

    if (!this.summary) {
      return [];
    }

    if (!element) {
      const buckets = buildBuckets(this.summary, this.now()).map(
        (bucket): UsageNode => ({ kind: "bucket", bucket }),
      );
      return buckets.length > 0 ? buckets : [{ kind: "empty" }];
    }

    if (element.kind === "bucket") {
      return element.bucket.chats.map(
        (chat): UsageNode => ({ kind: "chat", chat, bucketId: element.bucket.id }),
      );
    }

    return [];
  }

  getTreeItem(element: UsageNode): vscode.TreeItem {
    if (element.kind === "empty") {
      return new vscode.TreeItem("No Copilot usage found", vscode.TreeItemCollapsibleState.None);
    }

    if (element.kind === "bucket") {
      const item = new vscode.TreeItem(
        element.bucket.label,
        element.bucket.id === "today"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = [
        formatSessionCount(element.bucket.chats.length),
        formatTokensWithCost(element.bucket.tokens, element.bucket.githubCopilot),
      ].join(" | ");
      item.tooltip = [
        element.bucket.label,
        formatSessionCount(element.bucket.chats.length),
        `Tokens: ${formatExactTokens(element.bucket.tokens)}`,
        ...formatCostTooltipLines(element.bucket.githubCopilot),
      ].join("\n");
      return item;
    }

    const item = new vscode.TreeItem(element.chat.title, vscode.TreeItemCollapsibleState.None);
    item.description = formatChatDescription(element.chat, element.bucketId);
    item.tooltip = formatChatTooltip(element.chat);
    return item;
  }
}

function buildBuckets(summary: UsageSummary, baseDate: Date): UsageBucket[] {
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

  for (const chat of summary.chats) {
    const dayDiff = differenceInLocalCalendarDays(chat.timestamp, baseDate);
    const bucket = dayDiff === 0 ? buckets[0] : dayDiff === 1 ? buckets[1] : buckets[2];
    bucket.chats.push(chat);
    bucket.tokens += chat.tokens;
    addCost(bucket.githubCopilot, chat.githubCopilot);
  }

  return buckets.filter((bucket) => bucket.chats.length > 0);
}

function emptyCostEstimate(): CopilotCostEstimate {
  return {
    available: false,
    usd: 0,
    aiCredits: 0,
  };
}

function addCost(target: CopilotCostEstimate, addition: CopilotCostEstimate): void {
  target.usd += addition.usd;
  target.aiCredits += addition.aiCredits;
  target.available ||= addition.available;
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

function formatExactTokens(tokens: number): string {
  return `${Math.round(tokens)}`;
}

function formatSessionCount(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
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
    `Tokens: ${formatExactTokens(chat.tokens)}`,
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
