export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 100_000) / 10}M`;
  }

  if (tokens >= 1_000) {
    const thousands = Math.round(tokens / 1_000);
    return thousands >= 1_000 ? `${Math.round(thousands / 100) / 10}M` : `${thousands}k`;
  }

  return `${Math.round(tokens)}`;
}

export function formatUsd(usd: number, partial = false): string {
  const cents = Math.round(usd * 100);
  const formatted =
    cents <= 0
      ? "0$"
      : cents < 100
        ? `${(cents / 100).toFixed(2)}$`
        : `${Math.round(usd * 10) / 10}$`;
  return partial ? `${formatted}+` : formatted;
}
