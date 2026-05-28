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
