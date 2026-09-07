import { aggregateDailyUsage } from '../core/aggregator';
import type { CopilotQuota } from '../core/quota';
import type { UsageSummary } from '../core/types';
import { getPeriodSpentPercentage, formatTokens, formatUsd } from '../ui/formatters';

/** Throwaway: can native image titles show daily details inside the status-bar hover? */
export function formatTooltipGraphPrototype(
  summary: UsageSummary,
  quota: CopilotQuota | undefined,
  now: Date,
  lightTheme = false,
  highContrast = false,
  trackingStartedAt?: Date,
): string {
  const width = 430;
  const height = 44;
  const baseline = 35;
  const colors = lightTheme
    ? { bar: '#333333', old: '#b0b0b0', axis: '#d0d0d0', tick: '#616161', text: '#333333', muted: '#616161' }
    : { bar: '#cccccc', old: '#4a4a4a', axis: '#454545', tick: '#9d9d9d', text: '#cccccc', muted: '#8c8c8c' };
  if (highContrast) {
    colors.bar = colors.text = lightTheme ? '#000000' : '#ffffff';
    colors.old = colors.muted = lightTheme ? '#595959' : '#aaaaaa';
    colors.axis = colors.tick = colors.bar;
  }
  const records = summary.chats.flatMap((chat) => chat.records);
  const days = aggregateDailyUsage(records, now);
  const maxCredits = Math.max(...days.map((day) => day.total.githubCopilot.aiCredits));
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodIndex = days.findIndex((day) => day.date.getTime() === periodStart.getTime());
  // The graph uses local dates; quota snapshots reset in UTC. During a month-boundary
  // mismatch, omit percentages rather than attribute another billing month's spending.
  const sameBillingMonth = now.getFullYear() === now.getUTCFullYear() && now.getMonth() === now.getUTCMonth();
  const spentPct = sameBillingMonth ? getPeriodSpentPercentage(quota, now) : undefined;
  const trackingStart = trackingStartedAt?.getTime();
  // Count local calendar dates, including today, without a first-day delay or
  // changes caused by a daylight-saving transition or the time of day.
  const trackedCalendarDays = trackingStartedAt ? Math.max(1, 1 + Math.round((
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
    Date.UTC(trackingStartedAt.getFullYear(), trackingStartedAt.getMonth(), trackingStartedAt.getDate())
  ) / 86_400_000)) : Infinity;
  const trackedDays = Math.min(30, trackedCalendarDays);
  const rateDays = Math.min(now.getDate(), trackedCalendarDays);
  const totalTokens = days.reduce((sum, day) => sum + day.total.tokens, 0);
  const totalUsd = days.reduce((sum, day) => sum + day.total.githubCopilot.usd, 0);
  const dateLabel = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const edge = (index: number) => Math.round(index * width / days.length);

  // No whitespace between images: all thirty full-height hitboxes meet, even on empty days.
  const columns = days.map((day, index) => {
    const columnWidth = edge(index + 1) - edge(index);
    const credits = day.total.githubCopilot.aiCredits;
    // Gently lift smaller days while keeping the largest day at full height.
    const barHeight = credits > 0 ? Math.max(1.5, (credits / maxCredits) ** 0.75 * 30) : 0;
    const inPeriod = day.date >= periodStart;
    const share = inPeriod && spentPct !== undefined && quota ? `${(credits / quota.entitlement * 100).toFixed(1)}% · ` : '';
    const nextDay = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate() + 1).getTime();
    const untracked = trackingStart !== undefined && nextDay <= trackingStart;
    const partial = trackingStart !== undefined && day.date.getTime() < trackingStart && !untracked;
    const value = untracked ? 'not tracked' : (credits > 0
      ? `${share}${formatTokens(day.total.tokens)} (${formatUsd(day.total.githubCopilot.usd)})`
      : 'no usage') + (partial ? ` · tracked since ${trackingStartedAt!.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');
    const title = `${dateLabel(day.date)} · ${value}`;
    const bar = credits > 0
      ? `<rect x="${(columnWidth - 9) / 2}" y="${baseline - barHeight}" width="9" height="${barHeight}" rx="1" fill="${inPeriod ? colors.bar : colors.old}"/>`
      : '';
    const tick = index === periodIndex ? `<rect x="0" y="37" width="1" height="6" fill="${colors.tick}"/>` : '';
    const endTick = index === 29 ? `<rect x="${columnWidth - 1}" y="37" width="1" height="6" fill="${colors.tick}"/>` : '';
    return svgImage(columnWidth, height,
      `${bar}<path d="M0 35.5H${columnWidth}" stroke="${colors.axis}"/>${tick}${endTick}`, title);
  }).join('');

  const boundary = periodIndex < 0 ? 0 : edge(periodIndex);
  const labels = [`<text x="0" y="13" fill="${colors.muted}">${dateLabel(days[0].date)}</text>`];
  let caption = '';
  let captionLeft = width;
  let captionRight = width;
  if (spentPct !== undefined) {
    const ratePct = Math.round(spentPct / rateDays * 10) / 10;
    const daysInPeriod = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectedPct = Math.round(trackingStart === undefined ? ratePct * daysInPeriod
      : spentPct + ratePct * (daysInPeriod - now.getDate()));
    caption = `Period ${spentPct}% · ${ratePct.toFixed(1)}%/day · ${projectedPct}% projected`;
    const captionWidth = estimateAxisTextWidth(caption);
    const center = (boundary + width) / 2;
    const fitsCentered = center + captionWidth / 2 <= width;
    captionRight = fitsCentered ? center + captionWidth / 2 : width;
    captionLeft = captionRight - captionWidth;
    // End anchoring uses the actual rendered width at the edge, so the caption cannot clip there.
    labels.push(`<text x="${fitsCentered ? center : width}" y="13" text-anchor="${fitsCentered ? 'middle' : 'end'}"><tspan fill="${colors.text}">Period ${spentPct}%</tspan><tspan fill="${colors.muted}"> · ${ratePct.toFixed(1)}%/day · ${projectedPct}% projected</tspan></text>`);
  }
  const periodDate = dateLabel(periodStart);
  const halfDateWidth = estimateAxisTextWidth(periodDate) / 2;
  const clearOfCaption = !caption || boundary + halfDateWidth + 6 <= captionLeft || boundary - halfDateWidth - 6 >= captionRight;
  if (periodIndex >= 0 && boundary >= 56 && clearOfCaption) {
    labels.push(`<text x="${boundary}" y="13" text-anchor="middle" fill="${colors.muted}">${periodDate}</text>`);
  }
  const axis = svgImage(width, 18,
    `<g font-family="Segoe UI, sans-serif" font-size="12" style="font-variant-numeric:tabular-nums">${labels.join('')}</g>`,
    `${dateLabel(days[0].date)}${caption ? ` · ${caption}` : ''}`, false);

  return [
    '<table width="430">',
    `<tr><td><strong>Last 30 days</strong></td><td align="right">avg. ${formatTokens(totalTokens / trackedDays)} (${formatUsd(totalUsd / trackedDays)}) / day</td></tr>`,
    '</table>',
    `<p>${columns}<br>${axis}</p>`,
  ].join('\n');
}

// Conservative character advances for the axis's fixed 12px Segoe UI font.
// These only decide alignment and collisions; SVG still renders at its natural text width.
function estimateAxisTextWidth(text: string): number {
  const advances: Record<string, number> = {
    P: 6.8, e: 6.3, r: 4.2, i: 3, o: 7.1, d: 7.1, ' ': 3.3, '%': 9.9, '·': 2.7,
    '/': 4.7, a: 6.2, y: 5.9, p: 7.1, j: 3, c: 5.6, t: 4.1, '.': 2.7,
    J: 4.3, n: 6.8, F: 5.9, b: 7.1, M: 10.8, A: 7.8, u: 6.8, l: 3,
    g: 7.1, S: 6.4, O: 9.1, N: 9, v: 5.8, D: 8.5,
  };
  return 2 + Array.from(text).reduce((width, character) =>
    width + (/[0-9]/.test(character) ? 6.5 : advances[character] ?? 12), 0);
}

function svgImage(width: number, height: number, content: string, label: string, title = true): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`;
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<img src="${source}" width="${width}" height="${height}" alt="${escaped}"${title ? ` title="${escaped}"` : ''}>`;
}
