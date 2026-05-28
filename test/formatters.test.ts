import { describe, expect, it } from 'vitest';

import { formatTokens, formatUsd } from '../src/ui/formatters';

describe('formatTokens', () => {
  it('rounds thousands to whole k values', () => {
    expect(formatTokens(368_100)).toBe('368k');
    expect(formatTokens(368_500)).toBe('369k');
  });

  it('keeps one decimal for million values', () => {
    expect(formatTokens(1_240_000)).toBe('1.2M');
    expect(formatTokens(22_000_000)).toBe('22M');
  });
});

describe('formatUsd', () => {
  it('shows cents for amounts below one dollar', () => {
    expect(formatUsd(0.68)).toBe('0.68$');
    expect(formatUsd(0.72)).toBe('0.72$');
  });

  it('rounds dollar amounts to one decimal with the dollar sign after the value', () => {
    expect(formatUsd(1.2)).toBe('1.2$');
  });

  it('shows cents for nonzero amounts that round to zero at one decimal', () => {
    expect(formatUsd(0.04)).toBe('0.04$');
    expect(formatUsd(0.004)).toBe('0$');
    expect(formatUsd(-0.01)).toBe('0$');
  });

  it('keeps partial cost marker after the dollar sign', () => {
    expect(formatUsd(1.24, true)).toBe('1.2$+');
  });
});
