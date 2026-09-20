import type { DailyUsage } from '../core/quotaHistory';

/**
 * Tooltip markdown keeps only `img` size, `src`, and `title` attributes and no
 * CSS beyond span colors, so each day is a small SVG data image whose height
 * is the bar and whose native title is the hover label. Adjacent images share
 * the text baseline, which bottom-aligns the bars.
 */
const COLUMN_WIDTH = 14;
const BAR_WIDTH = 9;
const BAR_AREA_HEIGHT = 24;
const AXIS_HEIGHT = 1;
const IMAGE_HEIGHT = BAR_AREA_HEIGHT + AXIS_HEIGHT;
// Heights compress toward the tallest day so one heavy day does not flatten
// the rest: a day at a tenth of the peak draws at a fifth of its height.
const HEIGHT_EXPONENT = 0.7;

export interface GraphPalette { bright: string; dim: string; axis: string }

export const DARK_PALETTE: GraphPalette = { bright: '#cccccc', dim: '#4a4a4a', axis: '#454545' };
export const LIGHT_PALETTE: GraphPalette = { bright: '#616161', dim: '#c8c8c8', axis: '#d4d4d4' };

/** Table rows for the graph: one row of day images and one row of axis labels. */
export function formatDailyUsageGraphRows(days: DailyUsage[], palette: GraphPalette): string[] {
  if (days.length === 0) return [];
  const scale = Math.max(...days.map((day) => day.used ?? 0));
  const currentMonth = monthKey(days[days.length - 1].day);
  const images = days.map((day) => {
    const label = formatDayLabel(day);
    const height = day.used === undefined || day.used <= 0 || scale <= 0 ? 0
      : Math.max(1, Math.round((day.used / scale) ** HEIGHT_EXPONENT * BAR_AREA_HEIGHT));
    const color = monthKey(day.day) === currentMonth ? palette.bright : palette.dim;
    return `<img src="${dayImage(height, color, palette.axis)}" width="${COLUMN_WIDTH}" height="${IMAGE_HEIGHT}" alt="${label}" title="${label}">`;
  }).join('');
  const muted = (text: string) => `<span style="color:var(--vscode-descriptionForeground);">${text}</span>`;
  return [
    `<tr><td colspan="2" align="center">${images}</td></tr>`,
    `<tr><td>${muted(formatDate(days[0].day))}</td><td align="right">${muted(formatDate(days[days.length - 1].day))}</td></tr>`,
  ];
}

export function formatDayLabel(day: DailyUsage): string {
  const date = formatDate(day.day);
  if (day.used === undefined) return `${date} · Not tracked`;
  const percent = formatPercent(day.used);
  return day.incomplete ? `${date} · ${percent} recorded · Incomplete` : `${date} · ${percent}`;
}

function formatPercent(used: number): string {
  if (used > 0 && used < 0.01) return '&lt;0.01%';
  return `${used.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false })}%`;
}

function formatDate(day: number): string {
  const date = new Date(day);
  return `${date.getDate()} ${date.toLocaleString('en-US', { month: 'short' })}`;
}

function monthKey(day: number): string {
  const date = new Date(day);
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function dayImage(height: number, color: string, axis: string): string {
  const bar = height > 0
    ? `<rect x="${(COLUMN_WIDTH - BAR_WIDTH) / 2}" y="${BAR_AREA_HEIGHT - height}" width="${BAR_WIDTH}" height="${height}" rx="1" fill="${color}"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLUMN_WIDTH}" height="${IMAGE_HEIGHT}">${bar}` +
    `<rect y="${BAR_AREA_HEIGHT}" width="${COLUMN_WIDTH}" height="${AXIS_HEIGHT}" fill="${axis}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
