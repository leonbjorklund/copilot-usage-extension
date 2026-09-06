import { afterEach, describe, expect, it, vi } from 'vitest';

import { aggregateUsage } from '../src/core/aggregator';
import type { UsageRecord } from '../src/core/types';
import { formatTooltipGraphPrototype } from '../src/dev/tooltipGraphPrototype';

afterEach(() => vi.unstubAllEnvs());

function decodeImages(html: string): string[] {
  return [...html.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString());
}

function record(date: Date, credits: number): UsageRecord {
  return {
    chatId: date.toISOString(), title: 'Usage', timestamp: date, model: 'model', filePath: 'mock.jsonl',
    tokens: { input: 100, cachedInput: 0, output: 0, cacheWriteInput: 0, total: 100, source: 'recorded' },
    billing: { aiCredits: credits, source: 'copilot-debug-log' },
  };
}

describe('tooltip graph calculations', () => {
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
    expect(images[28]).toContain('height="15" rx="1"');
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
