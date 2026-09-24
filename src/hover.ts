import {
  currentAccount, dailyUsed, formatNumber, monthUsed, monthlyPace, todayUsed, type Reading, type Records,
} from './quota';

const INFO = '<a href="https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals" ' +
  'title="How GitHub bills Copilot credits">$(info)</a>';

/**
 * The hover keeps only `img` size, `src`, `alt` and `title` attributes and no CSS beyond span colors, so
 * each day is a small SVG data image whose height is the bar and whose native title is the hover
 * label. Adjacent images share the text baseline, which bottom-aligns the bars.
 */
const COLUMN_WIDTH = 14;
const BAR_WIDTH = 9;
const BAR_AREA_HEIGHT = 24;
const AXIS_HEIGHT = 1;
const IMAGE_HEIGHT = BAR_AREA_HEIGHT + AXIS_HEIGHT;
// Heights compress toward the tallest day so one heavy day does not flatten the rest: a day at a
// tenth of the peak draws at a fifth of its height.
const HEIGHT_EXPONENT = 0.7;

interface Palette { bright: string; dim: string; axis: string }

export const DARK: Palette = { bright: '#cccccc', dim: '#4a4a4a', axis: '#454545' };
export const LIGHT: Palette = { bright: '#616161', dim: '#c8c8c8', axis: '#d4d4d4' };

/**
 * The status bar hover: the quota of the account Copilot reported for last, then the month's top
 * models, or `undefined` with neither. The quota part holds a link, since the hover stays open
 * under the mouse only while it has one.
 */
export function hoverMarkdown(
  records: Records, now: number, palette: Palette, models: Array<{ model: string; chats: number; share: number }>,
): string | undefined {
  const sections: string[] = [];
  const login = currentAccount(records);
  if (login) sections.push(...quota(login, records[login], now, palette));
  if (models.length) sections.push(modelTable(models));
  return sections.length ? sections.join('\n\n---\n\n') : undefined;
}

/** Today with the account, then the month with its pace and graph; one row for an allowance without numbers. */
function quota(login: string, readings: Reading[], now: number, palette: Palette): string[] {
  const latest = readings.at(-1)!;
  const account = `${muted(login)}&nbsp;&nbsp;${INFO}`;
  if (latest.unlimited || latest.quota <= 0) {
    const label = latest.unlimited ? 'Unlimited Copilot quota' : 'No Copilot credit allowance';
    return [table([`<tr><td>${nbsp(label)}</td><td align="right">${account}</td></tr>`])];
  }
  const credits = (share: number) => formatNumber(Math.round(share * latest.quota / 100));
  const today = todayUsed(readings, now);
  const month = monthUsed(readings, now);
  const allowance = formatNumber(latest.quota);
  // Past the allowance, the allowance comes first and the larger spend second.
  const period = month > 100
    ? `100% / ${formatNumber(month)}%  (${allowance} / ${credits(month)} credits)`
    : `${formatNumber(month)}% / 100%  (${credits(month)} / ${allowance} credits)`;
  const pace = monthlyPace(latest, now);
  return [
    table([`<tr><td><strong>Today:</strong> ${nbsp(`${percent(today)}  (${credits(today)})`)}</td>` +
      `<td align="right">${account}</td></tr>`]),
    table([
      `<tr><td><strong>Month:</strong> ${nbsp(period)}</td><td align="right">&nbsp;&nbsp;` +
        `${nbsp(pace === undefined ? 'Pace unavailable' : `${formatNumber(pace)}% monthly pace`)}</td></tr>`,
      ...graphRows(dailyUsed(readings, now), palette),
    ]),
  ];
}

function modelTable(models: Array<{ model: string; chats: number; share: number }>): string {
  return table([
    '<tr><td colspan="2"><strong>Model use this month</strong></td></tr>',
    ...models.map(({ model, chats, share }, index) => `<tr><td>${index + 1}. ${escapeHtml(model)}</td>` +
      `<td align="right">${formatNumber(chats)} ${chats === 1 ? 'session' : 'sessions'} · ${percent(share)}</td></tr>`),
  ]);
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function table(rows: string[]): string {
  return ['<table width="100%">', ...rows, '</table>'].join('\n');
}

function muted(text: string): string {
  return `<span style="color:var(--vscode-descriptionForeground);">${text}</span>`;
}

/** Keeps a label on one line. */
function nbsp(text: string): string {
  return text.replaceAll(' ', '&nbsp;');
}

/** One row of day images and one row with the first and last date. */
function graphRows(days: Array<{ day: number; used?: number }>, palette: Palette): string[] {
  const scale = Math.max(...days.map((day) => day.used ?? 0));
  const currentMonth = new Date(days.at(-1)!.day).getMonth();
  const images = days.map(({ day, used }) => {
    const label = `${formatDate(day)} · ${used === undefined ? 'Not tracked' : percent(used)}`;
    const height = used === undefined || used <= 0 ? 0
      : Math.max(1, Math.round((used / scale) ** HEIGHT_EXPONENT * BAR_AREA_HEIGHT));
    const color = new Date(day).getMonth() === currentMonth ? palette.bright : palette.dim;
    return `<img src="${dayImage(height, color, palette.axis)}" width="${COLUMN_WIDTH}" height="${IMAGE_HEIGHT}" ` +
      `alt="${label}" title="${label}">`;
  }).join('');
  return [
    `<tr><td colspan="2" align="center">${images}</td></tr>`,
    `<tr><td>${muted(formatDate(days[0].day))}</td><td align="right">${muted(formatDate(days.at(-1)!.day))}</td></tr>`,
  ];
}

/** A tiny positive day keeps its bar, so it must not read 0%. */
function percent(used: number): string {
  return used > 0 && used < 0.05 ? '&lt;0.1%' : `${formatNumber(used)}%`;
}

function formatDate(day: number): string {
  const date = new Date(day);
  return `${date.getDate()} ${date.toLocaleString('en-US', { month: 'short' })}`;
}

function dayImage(height: number, color: string, axis: string): string {
  const bar = height > 0
    ? `<rect x="${(COLUMN_WIDTH - BAR_WIDTH) / 2}" y="${BAR_AREA_HEIGHT - height}" width="${BAR_WIDTH}" ` +
      `height="${height}" rx="1" fill="${color}"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLUMN_WIDTH}" height="${IMAGE_HEIGHT}">${bar}` +
    `<rect y="${BAR_AREA_HEIGHT}" width="${COLUMN_WIDTH}" height="${AXIS_HEIGHT}" fill="${axis}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
