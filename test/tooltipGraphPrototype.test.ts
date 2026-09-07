import { afterEach, describe, expect, it, vi } from 'vitest';

import { aggregateUsage } from '../src/core/aggregator';
import type { UsageRecord } from '../src/core/types';
import { formatTooltipGraphPrototype } from '../src/dev/tooltipGraphPrototype';

afterEach(() => vi.unstubAllEnvs());

function decodeImages(html: string): string[] {
  return [...html.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString());
}

function barHeight(svg: string): number {
  return Number(svg.match(/width="9" height="([^"]+)"/)?.[1] ?? 0);
}

function record(date: Date, credits: number): UsageRecord {
  return {
    chatId: date.toISOString(), title: 'Usage', timestamp: date, model: 'model', filePath: 'mock.jsonl',
    tokens: { input: 100, cachedInput: 0, output: 0, cacheWriteInput: 0, total: 100, source: 'recorded' },
    billing: { aiCredits: credits, source: 'copilot-debug-log' },
  };
}

describe('tooltip graph calculations', () => {
  it('shows current usage averages and period text on the first tracked day', () => {
    const now = new Date(2026, 8, 21, 12);
    const startedAt = new Date(2026, 8, 21, 10);
    const quota = { entitlement: 100, remaining: 98, percentRemaining: 98, unlimited: false,
      overageCount: 0, resetDate: new Date('2026-10-01T00:00:00Z') };
    const html = formatTooltipGraphPrototype(aggregateUsage([record(now, 2)], now), quota, now, false, false, startedAt);
    expect(html).toContain('20 Sept · not tracked');
    expect(html).toContain('tracked since');
    expect(html).toContain('avg. 100 (0.02$) / day');
    expect(html).not.toContain('available after');
    expect(decodeImages(html).at(-1)).toContain('Period 2%');
    expect(decodeImages(html).at(-1)).toContain('2.0%/day · 20% projected');
    expect(barHeight(decodeImages(html)[29])).toBe(30);
  });

  it('projects tracked spending plus future days without filling missing earlier history', () => {
    const now = new Date(2026, 8, 21, 12);
    const startedAt = new Date(2026, 8, 19, 12);
    const quota = { entitlement: 100, remaining: 96, percentRemaining: 96, unlimited: false,
      overageCount: 0, resetDate: new Date('2026-10-01T00:00:00Z') };
    const html = formatTooltipGraphPrototype(aggregateUsage([record(now, 4)], now), quota, now, false, false, startedAt);
    expect(html).toContain('avg. 33 (0.01$) / day');
    expect(decodeImages(html).at(-1)).toContain('Period 4%');
    expect(decodeImages(html).at(-1)).toContain('1.3%/day · 16% projected');
  });

  it.each([
    ['2026-09-20T23:30:00', '2026-09-21T00:30:00'],
    ['2026-10-24T12:00:00', '2026-10-25T12:00:00'],
  ])('counts local calendar days instead of elapsed hours since %s', (start, current) => {
    vi.stubEnv('TZ', 'Europe/Stockholm');
    const now = new Date(current);
    const html = formatTooltipGraphPrototype(aggregateUsage([record(now, 4)], now), undefined, now, false, false, new Date(start));
    expect(html).toContain('avg. 50 (0.02$) / day');
  });

  it('uses the whole billing month for the rate while limiting the graph average to thirty days', () => {
    const now = new Date(2026, 9, 31, 12);
    const quota = { entitlement: 100, remaining: 7, percentRemaining: 7, unlimited: false,
      overageCount: 0, resetDate: new Date('2026-11-01T00:00:00Z') };
    const html = formatTooltipGraphPrototype(aggregateUsage([record(now, 93)], now), quota, now, false, false, new Date(2026, 8, 1));
    expect(html).toContain('avg. 3 (0.03$) / day');
    expect(decodeImages(html).at(-1)).toContain('3.0%/day · 93% projected');
  });

  it.each([1, 2, 6])('keeps the early-month caption inside the same row and hides its overlapping date on day %i', (day) => {
    const now = new Date(2026, 9, day, 12);
    const quota = {
      entitlement: 1500, remaining: 1413, percentRemaining: 94.2, unlimited: false, overageCount: 0,
      resetDate: new Date('2026-11-01T00:00:00Z'),
    };
    const html = formatTooltipGraphPrototype(aggregateUsage([record(now, 87)], now), quota, now);
    const images = decodeImages(html);
    const axis = images.at(-1)!;
    expect(axis).toContain('width="430" height="18"');
    expect(axis).toContain('<text x="430" y="13" text-anchor="end"><tspan');
    expect(axis).toContain('Period 6%');
    expect(axis).not.toContain('>1 Oct</text>');
    expect(images[30 - day]).toContain('x="0" y="37" width="1" height="6"');
    expect(images[29]).toContain('x="13" y="37" width="1" height="6"');
    expect(html).toContain('title="1 Oct ·');
  });

  it('centers the caption between the ticks again when it fits, keeping the date label', () => {
    const now = new Date(2026, 8, 21, 12);
    const quota = {
      entitlement: 1500, remaining: 841, percentRemaining: 841 / 15, unlimited: false, overageCount: 0,
      resetDate: new Date('2026-10-01T00:00:00Z'),
    };
    const axis = decodeImages(formatTooltipGraphPrototype(aggregateUsage([], now), quota, now)).at(-1)!;
    expect(axis).toContain('<text x="279.5" y="13" text-anchor="middle"><tspan');
    expect(axis).toContain('>1 Sept</text>');
    expect(axis).toContain('Period 44%');
  });

  it('scales fractional credits to the largest day and retains empty hover targets', () => {
    const now = new Date(2026, 8, 21, 12);
    const summary = aggregateUsage([
      record(new Date(2026, 8, 20, 12), 0.1), record(now, 0.2),
    ], now);
    const html = formatTooltipGraphPrototype(summary, undefined, now);
    const images = decodeImages(html);
    expect(images).toHaveLength(31); // Thirty columns plus the date axis.
    expect(barHeight(images[28])).toBeCloseTo(17.84, 2);
    expect(images[29]).toContain('height="30" rx="1"');
    expect(images[0]).not.toContain('<rect');
    expect(html).toContain('title="23 Aug · no usage"');
    expect(html.match(/ title=/g)).toHaveLength(30);
  });

  it('renders an empty window without invalid SVG numbers', () => {
    const now = new Date(2026, 8, 21, 12);
    const html = formatTooltipGraphPrototype(aggregateUsage([], now), undefined, now);
    expect(html.match(/ title="[^"]+no usage"/g)).toHaveLength(30);
    expect(decodeImages(html).join('')).not.toMatch(/NaN|Infinity/);
  });

  it.each([
    { spike: 1500, smallHeight: 3.17 },
    { spike: 3000, smallHeight: 1.89 },
  ])('gently scales beside a $spike-credit spike while preserving hover values', ({ spike, smallHeight }) => {
    const now = new Date(2026, 8, 21, 12);
    const quota = {
      entitlement: 1500, remaining: 0, percentRemaining: 0, unlimited: false, overageCount: 0,
      resetDate: new Date('2026-10-01T00:00:00Z'),
    };
    const credits = [75, 75, 75, 75, 150, spike];
    const summary = aggregateUsage(credits.map((value, i) =>
      record(new Date(2026, 8, 16 + i, 12), value)), now);
    const html = formatTooltipGraphPrototype(summary, quota, now);
    const images = decodeImages(html);
    expect(barHeight(images[24])).toBeCloseTo(smallHeight, 2);
    expect(barHeight(images[28]) / barHeight(images[24])).toBeCloseTo(1.68, 2);
    expect(barHeight(images[29])).toBe(30);
    expect(images[29]).not.toContain('8l9 -3');
    expect(html).toContain(`title="21 Sept · ${(spike / 15).toFixed(1)}% · 100 (${spike / 100}$)"`);
    expect(html).not.toContain('capped');
  });

  it.each([
    { credits: [75] },
    { credits: [75, 75, 75, 1500] },
    { credits: [75, 75, 75, 75, 75] },
    { credits: [75, 75, 75, 1500, 1500] },
    { credits: [0.001, 1500] },
  ])('handles sparse, steady and tiny usage: $credits', ({ credits }) => {
    const now = new Date(2026, 8, 21, 12);
    const summary = aggregateUsage(credits.map((value, i) =>
      record(new Date(2026, 8, 21 - credits.length + 1 + i, 12), value)), now);
    const html = formatTooltipGraphPrototype(summary, undefined, now);
    const images = decodeImages(html);
    const heights = images.slice(0, 30).map(barHeight);
    expect(heights.filter((height) => height > 0)).toHaveLength(credits.length);
    expect(Math.max(...heights)).toBe(30);
    expect(heights.every((height) => height === 0 || height >= 1.5)).toBe(true);
    if (credits[0] === 0.001) expect(heights[28]).toBe(1.5);
    expect(html).not.toContain('capped');
    expect(images.join('')).not.toMatch(/NaN|Infinity/);
  });

  it.each([
    ['Europe/Stockholm', '2026-09-30T22:30:00Z'],
    ['America/Los_Angeles', '2026-10-01T00:30:00Z'],
  ])('omits account percentages while local and UTC months disagree in %s', (timezone, instant) => {
    vi.stubEnv('TZ', timezone);
    const now = new Date(instant);
    expect(now.getMonth()).not.toBe(now.getUTCMonth());
    const quota = {
      entitlement: 1500, remaining: 841, percentRemaining: 841 / 15, unlimited: false, overageCount: 0,
      resetDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
    const html = formatTooltipGraphPrototype(aggregateUsage([record(now, 1)], now), quota, now);
    expect(html.match(/ title=/g)).toHaveLength(30);
    expect(html).not.toContain('%');
    expect(decodeImages(html).join('')).not.toContain('Period');
  });

  it('keeps valid zero-percent captions and rejects expired snapshots', () => {
    const now = new Date(2026, 8, 21, 12);
    const summary = aggregateUsage([], now);
    const quota = {
      entitlement: 1500, remaining: 1500, percentRemaining: 100, unlimited: false, overageCount: 0,
      resetDate: new Date('2026-10-01T00:00:00Z'),
    };
    const axis = decodeImages(formatTooltipGraphPrototype(summary, quota, now)).at(-1)!;
    expect(axis).toContain('Period 0%');
    expect(axis).toContain('0.0%/day · 0% projected');
    const expired = { ...quota, resetDate: new Date('2026-09-01T00:00:00Z') };
    expect(decodeImages(formatTooltipGraphPrototype(summary, expired, now)).at(-1)).not.toContain('Period');
  });
});
