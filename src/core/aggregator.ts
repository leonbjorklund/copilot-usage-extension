import type {
  ChatUsageSummary,
  CopilotCostEstimate,
  ModelUsageSummary,
  UsageRecord,
  UsageSummary,
  UsageTotal,
} from './types';

interface TitleCandidate {
  title: string;
  priority: number;
  timestamp: Date;
}

export function aggregateUsage(records: UsageRecord[], now = new Date()): UsageSummary {
  const today = emptyTotal();
  const week = emptyTotal();
  const month = emptyTotal();
  const allTime = emptyTotal();
  const titleCandidates = new Map<string, TitleCandidate>();
  const visibleRecords: UsageRecord[] = [];

  for (const record of records) {
    if (record.hiddenFromExplorer === true) {
      continue;
    }

    if (record.metadataOnly === true) {
      collectTitleCandidate(titleCandidates, record);
      continue;
    }

    if (!hasPositiveAiCredits(record)) {
      continue;
    }

    const tokens = record.tokens.total;
    const cost = estimateRecordCost(record);

    addToTotal(allTime, tokens, cost);

    if (isSameLocalDay(record.timestamp, now)) {
      addToTotal(today, tokens, cost);
    }

    if (isSameLocalWeek(record.timestamp, now)) {
      addToTotal(week, tokens, cost);
    }

    if (isSameLocalMonth(record.timestamp, now)) {
      addToTotal(month, tokens, cost);
    }

    collectTitleCandidate(titleCandidates, record);
    visibleRecords.push(record);
  }

  const sortedChats = buildChatSummaries(visibleRecords, titleCandidates)
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());

  const todayChats = buildChatSummaries(
    visibleRecords.filter((record) => isSameLocalDay(record.timestamp, now)),
    titleCandidates,
  );

  return {
    today,
    week,
    month,
    allTime,
    chats: sortedChats,
    topModels: buildTopModels(records),
    highestSessionToday: [...todayChats].sort(compareChatsByTokens)[0],
    mostExpensiveSessionToday: [...todayChats].sort(compareChatsByCost)[0],
  };
}

function buildChatSummaries(
  records: UsageRecord[],
  titleCandidates: Map<string, TitleCandidate>,
): ChatUsageSummary[] {
  const chats = new Map<string, ChatUsageSummary>();

  for (const record of records) {
    const title = resolveTitle(record, titleCandidates.get(record.chatId));
    const cost = estimateRecordCost(record);
    const existing = chats.get(record.chatId);

    if (existing) {
      existing.tokens += record.tokens.total;
      addCost(existing.githubCopilot, cost);
      existing.records.push(record);

      if (record.timestamp > existing.timestamp) {
        existing.title = title;
        existing.model = record.model;
        existing.timestamp = record.timestamp;
      }
    } else {
      const chat: ChatUsageSummary = {
        chatId: record.chatId,
        title,
        model: record.model,
        timestamp: record.timestamp,
        tokens: record.tokens.total,
        githubCopilot: emptyCostEstimate(),
        records: [record],
      };

      addCost(chat.githubCopilot, cost);
      chats.set(record.chatId, chat);
    }
  }

  return Array.from(chats.values()).map((chat) => ({
    ...chat,
    records: chat.records.sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime()),
  }));
}

function compareChatsByTokens(left: ChatUsageSummary, right: ChatUsageSummary): number {
  return right.tokens - left.tokens || right.timestamp.getTime() - left.timestamp.getTime();
}

function compareChatsByCost(left: ChatUsageSummary, right: ChatUsageSummary): number {
  return (
    right.githubCopilot.aiCredits - left.githubCopilot.aiCredits ||
    right.tokens - left.tokens ||
    right.timestamp.getTime() - left.timestamp.getTime()
  );
}

function buildTopModels(records: UsageRecord[]): ModelUsageSummary[] {
  const models = new Map<string, { chatIds: Set<string>; tokens: number; githubCopilot: CopilotCostEstimate }>();

  for (const record of records) {
    if (
      record.hiddenFromExplorer === true ||
      record.metadataOnly === true ||
      !hasPositiveAiCredits(record) ||
      record.tokens.total <= 0 ||
      record.tokens.source === 'missing'
    ) {
      continue;
    }

    let model = models.get(record.model);
    if (!model) {
      model = { chatIds: new Set<string>(), tokens: 0, githubCopilot: emptyCostEstimate() };
      models.set(record.model, model);
    }

    model.tokens += record.tokens.total;
    model.chatIds.add(record.chatId);
    addCost(model.githubCopilot, estimateRecordCost(record));
  }

  return Array.from(models.entries())
    .map(([model, usage]) => ({
      model,
      sessions: usage.chatIds.size,
      tokens: usage.tokens,
      githubCopilot: usage.githubCopilot,
    }))
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 3);
}

function emptyTotal(): UsageTotal {
  return {
    tokens: 0,
    githubCopilot: emptyCostEstimate(),
  };
}

function emptyCostEstimate(): CopilotCostEstimate {
  return {
    available: false,
    usd: 0,
    aiCredits: 0,
  };
}

function estimateRecordCost(record: UsageRecord): CopilotCostEstimate {
  const aiCredits = record.billing?.aiCredits ?? 0;
  return {
    available: aiCredits > 0,
    usd: roundUsd(aiCredits * 0.01),
    aiCredits,
  };
}

function hasPositiveAiCredits(record: UsageRecord): boolean {
  return (record.billing?.aiCredits ?? 0) > 0;
}

function addToTotal(total: UsageTotal, tokens: number, cost: CopilotCostEstimate): void {
  total.tokens += tokens;
  addCost(total.githubCopilot, cost);
}

function addCost(target: CopilotCostEstimate, addition: CopilotCostEstimate): void {
  target.usd = roundUsd(target.usd + addition.usd);
  target.aiCredits += addition.aiCredits;
  target.available ||= addition.available;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(10));
}

function collectTitleCandidate(candidates: Map<string, TitleCandidate>, record: UsageRecord): void {
  const candidate = {
    title: record.title,
    priority: record.titlePriority ?? 1,
    timestamp: record.timestamp,
  };
  const existing = candidates.get(record.chatId);

  if (!existing || isBetterTitleCandidate(candidate, existing)) {
    candidates.set(record.chatId, candidate);
  }
}

function isBetterTitleCandidate(candidate: TitleCandidate, existing: TitleCandidate): boolean {
  if (candidate.priority !== existing.priority) {
    return candidate.priority > existing.priority;
  }

  if (candidate.priority === 2) {
    return candidate.timestamp < existing.timestamp;
  }

  return candidate.timestamp > existing.timestamp;
}

function resolveTitle(record: UsageRecord, candidate: TitleCandidate | undefined): string {
  const title = candidate?.title ?? record.title;
  if (isGenericTitle(title)) {
    return record.chatId || title;
  }

  return title;
}

function isGenericTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === '' || normalized === 'panel/editagent' || normalized === 'copilot debug request';
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function isSameLocalMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

function startOfLocalWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return start;
}

function isSameLocalWeek(left: Date, right: Date): boolean {
  const leftStart = startOfLocalWeek(left);
  const rightStart = startOfLocalWeek(right);
  return leftStart.getTime() === rightStart.getTime();
}
