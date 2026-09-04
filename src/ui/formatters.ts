/**
 * Counts are sums of recorded usage, so a negative or non-finite value means a
 * defect upstream. Show zero rather than a nonsensical number in the tree.
 */
export function clampCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function formatTokens(rawTokens: number): string {
  const tokens = clampCount(rawTokens);

  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 100_000) / 10}M`;
  }

  if (tokens >= 1_000) {
    const thousands = Math.round(tokens / 1_000);
    return thousands >= 1_000 ? `${Math.round(thousands / 100) / 10}M` : `${thousands}k`;
  }

  return `${Math.round(tokens)}`;
}

export function formatUsd(rawUsd: number): string {
  const usd = clampCount(rawUsd);
  const cents = Math.round(usd * 100);
  if (cents <= 0) {
    return "0$";
  }

  return cents < 100 ? `${(cents / 100).toFixed(2)}$` : `${Math.round(usd * 10) / 10}$`;
}
