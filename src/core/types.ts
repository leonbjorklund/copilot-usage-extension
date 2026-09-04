export type TokenSource = 'recorded' | 'missing';

export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  cacheWriteInput: number;
  total: number;
  source: TokenSource;
}

export interface UsageBilling {
  aiCredits: number;
  source: 'copilot-debug-log';
}

/**
 * How much a record's title is worth as the chat's label. The normalizer stamps
 * it; the aggregator picks the highest, and ties on a prompt go to the earliest
 * turn while every other tie goes to the latest.
 */
export const TITLE_PRIORITY = {
  custom: 5,
  generated: 4,
  prompt: 2,
  record: 1,
  generic: 0,
  /** A subagent or title run is never the chat's label, whatever it calls itself. */
  childRun: -1,
} as const;

export interface UsageRecord {
  chatId: string;
  title: string;
  timestamp: Date;
  model: string;
  tokens: TokenUsage;
  billing?: UsageBilling;
  filePath: string;
  hiddenFromExplorer?: boolean;
  metadataOnly?: boolean;
  titlePriority?: number;
}

export interface ExtensionConfig {
  dataPath: string;
  maxFileSizeMb: number;
  maxScanDepth: number;
}

export interface UsageTotal {
  tokens: number;
  githubCopilot: CopilotCostEstimate;
}

export interface ChatUsageSummary {
  chatId: string;
  title: string;
  model: string;
  timestamp: Date;
  tokens: number;
  githubCopilot: CopilotCostEstimate;
  records: UsageRecord[];
}

export interface ModelUsageSummary {
  model: string;
  sessions: number;
  tokens: number;
  githubCopilot: CopilotCostEstimate;
}

export interface UsageSummary {
  today: UsageTotal;
  week: UsageTotal;
  month: UsageTotal;
  allTime: UsageTotal;
  chats: ChatUsageSummary[];
  topModels: ModelUsageSummary[];
  highestSessionToday?: ChatUsageSummary;
  mostExpensiveSessionToday?: ChatUsageSummary;
}

export interface UsageDiagnostics {
  roots: number;
  files: number;
  parsedRecords: number;
  normalizedRecords: number;
  skippedMalformedFiles: number;
  skippedRecords: number;
  scannedFiles: number;
  skippedFolders: number;
  unsupportedFiles: number;
  oversizedFiles: number;
  unreadableFiles: number;
}

export interface UsageServiceResult {
  summary: UsageSummary;
  diagnostics: UsageDiagnostics;
}

export interface CopilotCostEstimate {
  available: boolean;
  usd: number;
  aiCredits: number;
}
