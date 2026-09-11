import { describe, expect, it } from 'vitest';

import { formatPeriodPercentage, formatTokens, formatUsd } from '../src/ui/formatters';

describe('formatPeriodPercentage', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const quota = {
    entitlement: 1500, remaining: 841, percentRemaining: 841 / 15,
    unlimited: false, overageCount: 0, resetDate: new Date('2026-10-01'),
  };

  it('shows rounded account spending, including overage', () => {
    expect(formatPeriodPercentage(quota, now)).toBe('44/100%');
    expect(formatPeriodPercentage({ ...quota, remaining: 0, overageCount: 150 }, now)).toBe('110/100%');
    expect(formatPeriodPercentage({ ...quota, remaining: 1500 }, now)).toBe('0/100%');
  });

  it('omits unknown, unlimited, invalid, or expired periods', () => {
    expect(formatPeriodPercentage(undefined, now)).toBeUndefined();
    for (const patch of [
      { unlimited: true }, { entitlement: 0 }, { entitlement: Infinity },
      { remaining: NaN }, { overageCount: NaN }, { resetDate: undefined },
      { resetDate: new Date('invalid') }, { resetDate: new Date('2026-09-01') },
      { resetDate: new Date('2026-10-15') },
    ]) {
      expect(formatPeriodPercentage({ ...quota, ...patch }, now)).toBeUndefined();
    }
    expect(formatPeriodPercentage(quota, new Date('2026-10-01'))).toBeUndefined();
  });

  it('handles the December rollover', () => {
    expect(formatPeriodPercentage({ ...quota, resetDate: new Date('2027-01-01') }, new Date('2026-12-31T23:59:00Z'))).toBe('44/100%');
  });
});

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
  it('rounds amounts below one dollar to one decimal', () => {
    expect(formatUsd(0.68)).toBe('0.7$');
    expect(formatUsd(0.72)).toBe('0.7$');
    expect(formatUsd(0.17)).toBe('0.2$');
  });

  it('rounds dollar amounts to one decimal with the dollar sign after the value', () => {
    expect(formatUsd(1.2)).toBe('1.2$');
    expect(formatUsd(14.46)).toBe('14.5$');
    expect(formatUsd(200.87)).toBe('200.9$');
    expect(formatUsd(5)).toBe('5$');
  });

  it('keeps small positive amounts visible at the rounding boundaries', () => {
    expect(formatUsd(0.261479376)).toBe('0.3$');
    expect(formatUsd(0.05)).toBe('0.1$');
    expect(formatUsd(0.049999)).toBe('0.05$');
    expect(formatUsd(0.04)).toBe('0.04$');
    expect(formatUsd(0.034911756)).toBe('0.03$');
    expect(formatUsd(0.01)).toBe('0.01$');
    expect(formatUsd(0.009999)).toBe('<0.01$');
    expect(formatUsd(0.004)).toBe('<0.01$');
    expect(formatUsd(0)).toBe('0$');
    expect(formatUsd(-0.01)).toBe('0$');
  });
});
