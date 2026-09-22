import { describe, expect, it } from 'vitest';

import { calculateProjectedPercentage, formatQuotaLabel, formatQuotaPace, formatPeriodPercentage, formatTokens, formatUsd } from '../src/ui/formatters';

const monthlyQuota = {
  entitlement: 60_000, percentRemaining: 72.4, unlimited: false, hasQuota: true,
  resetDate: new Date('2026-10-01T00:00:00Z'),
};

describe('monthly credit presentation', () => {
  it('groups rounded credit counts and preserves the reported percentage', () => {
    expect(formatQuotaLabel(monthlyQuota)).toBe('16\u00a0560 / 60\u00a0000 credits (27.6% / 100%)');
    expect(formatQuotaLabel({ ...monthlyQuota, entitlement: 1500, percentRemaining: 71.1 }))
      .toBe('434 / 1\u00a0500 credits (28.9% / 100%)');
    expect(formatQuotaLabel({ ...monthlyQuota, entitlement: 1500.6, percentRemaining: 0 }))
      .toBe('1\u00a0501 / 1\u00a0501 credits (100% / 100%)');
  });

  it('keeps tiny positive use visible without inventing percentage precision', () => {
    expect(formatQuotaLabel({ ...monthlyQuota, percentRemaining: 99.99999999999999 }))
      .toBe('<1 / 60\u00a0000 credits (0.00000000000001% / 100%)');
    expect(formatQuotaLabel({ ...monthlyQuota, percentRemaining: 1e-7 }))
      .toBe('60\u00a0000 / 60\u00a0000 credits (99.9999999% / 100%)');
    expect(formatQuotaLabel({ ...monthlyQuota, percentRemaining: 100 }))
      .toBe('0 / 60\u00a0000 credits (0% / 100%)');
  });

  it('shows the allowance first and the larger spend second past 100%', () => {
    const over = { ...monthlyQuota, entitlement: 1000, percentRemaining: 0, overage: 300 };
    expect(formatQuotaLabel(over)).toBe('1\u00a0000 / 1\u00a0300 credits (100% / 130%)');
    expect(formatQuotaLabel(over, 'percentage-first')).toBe('100% / 130%  (1\u00a0000 / 1\u00a0300 credits)');
    expect(formatPeriodPercentage(over)).toBe('100/130%');
    expect(formatQuotaLabel({ ...over, entitlement: 60_000, overage: 1 }))
      .toBe('60\u00a0000 / 60\u00a0001 credits (100% / 100%)');
    expect(formatQuotaLabel({ ...over, entitlement: 1500.6, overage: 0.4 }))
      .toBe('1\u00a0501 / 1\u00a0501 credits (100% / 100%)');
    const observedAt = Date.parse('2026-09-16T00:00:00Z');
    expect(formatQuotaPace(over, observedAt, observedAt)).toBe('8.67% / day · 260% monthly pace');
  });

  it('keeps zero and unlimited allowance meaningful without numerical projection', () => {
    const observedAt = Date.parse('2026-09-16T00:00:00Z');
    for (const [patch, label] of [
      [{ entitlement: 0 }, 'No Copilot credit allowance'],
      [{ entitlement: 0, hasQuota: false }, 'Copilot allowance exhausted'],
      [{ unlimited: true, entitlement: -1 }, 'Unlimited Copilot quota'],
      [{ unlimited: true, entitlement: -1, hasQuota: false }, 'Copilot allowance exhausted'],
    ] as const) {
      const quota = { ...monthlyQuota, ...patch };
      expect(formatQuotaLabel(quota)).toBe(label);
      expect(formatQuotaPace(quota, observedAt, observedAt)).toBeUndefined();
    }
  });
});

describe('monthly projection', () => {
  it('uses elapsed partial days at the reading, unaffected by a later read time', () => {
    const observedAt = Date.parse('2026-09-08T12:00:00Z');
    expect(calculateProjectedPercentage(monthlyQuota, observedAt, observedAt)).toBeCloseTo(110.4);
    expect(formatQuotaPace(monthlyQuota, observedAt, observedAt)).toBe('3.68% / day · 110.4% monthly pace');
    expect(formatQuotaPace(monthlyQuota, observedAt, Date.parse('2026-09-30T23:59:59Z')))
      .toBe('3.68% / day · 110.4% monthly pace');
  });

  it.each([
    ['2026-09-16T00:00:00Z', '2026-10-01T00:00:00Z', '1.84'],
    ['2026-02-15T00:00:00Z', '2026-03-01T00:00:00Z', '1.97'],
    ['2028-02-15T12:00:00Z', '2028-03-01T00:00:00Z', '1.9'],
    ['2026-12-16T12:00:00Z', '2027-01-01T00:00:00Z', '1.78'],
  ])('uses the calendar month containing %s', (at, reset, daily) => {
    const observedAt = Date.parse(at);
    expect(formatQuotaPace({ ...monthlyQuota, resetDate: new Date(reset) }, observedAt, observedAt))
      .toBe(`${daily}% / day · 55.2% monthly pace`);
  });

  it('handles zero usage, exhaustion, whole percentages, and fractional projections', () => {
    const observedAt = Date.parse('2026-09-16T00:00:00Z');
    for (const [percentRemaining, daily, projected] of [
      [100, '0', '0'], [0, '6.67', '200'], [44, '3.73', '112'], [72.38, '1.84', '55.2'],
      [70.9, '1.94', '58.2'], [99.99, '<0.01', '0'],
    ] as const) {
      expect(formatQuotaPace({ ...monthlyQuota, percentRemaining }, observedAt, observedAt))
        .toBe(`${daily}% / day · ${projected}% monthly pace`);
    }
  });

  it('withholds projection for missing or inconsistent dates and completed months', () => {
    const observedAt = Date.parse('2026-09-16T00:00:00Z');
    for (const resetDate of [undefined, new Date('invalid'), new Date('2026-10-15'), new Date('2026-09-01')]) {
      expect(formatQuotaPace({ ...monthlyQuota, resetDate }, observedAt, observedAt))
        .toBe('Pace unavailable');
    }
    for (const [at, now] of [
      [NaN, observedAt], [observedAt, NaN], [observedAt, observedAt - 1],
      [Date.parse('2026-09-01T00:00:00Z'), observedAt],
      [observedAt, Date.parse('2026-10-01T00:00:00Z')],
    ]) {
      expect(formatQuotaPace(monthlyQuota, at, now)).toBe('Pace unavailable');
    }
  });
});

describe('formatPeriodPercentage', () => {
  const quota = {
    entitlement: 1500, percentRemaining: 56.1,
    unlimited: false, hasQuota: true, resetDate: new Date('2026-10-01'),
  };

  it('preserves the server percentage', () => {
    expect(formatPeriodPercentage(quota)).toBe('43.9/100%');
    expect(formatPeriodPercentage({ ...quota, percentRemaining: 80.3 })).toBe('19.7/100%');
    expect(formatPeriodPercentage({ ...quota, percentRemaining: 0 })).toBe('100/100%');
    expect(formatPeriodPercentage({ ...quota, percentRemaining: 100 })).toBe('0/100%');
  });

  it('omits unknown, unlimited, or invalid quotas', () => {
    expect(formatPeriodPercentage(undefined)).toBeUndefined();
    for (const patch of [
      { unlimited: true }, { entitlement: 0 }, { entitlement: Infinity },
      { percentRemaining: NaN },
    ]) {
      expect(formatPeriodPercentage({ ...quota, ...patch })).toBeUndefined();
    }
  });

  it('keeps the reported percentage regardless of the reset date', () => {
    for (const resetDate of [undefined, new Date('2020-01-01'), new Date('2026-10-15')]) {
      expect(formatPeriodPercentage({ ...quota, resetDate })).toBe('43.9/100%');
    }
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
