import { describe, expect, it } from 'vitest';
import { dailyUsage, type DailyUsage } from '../src/core/quotaHistory';
import { DARK_PALETTE, formatDailyUsageGraphRows, formatDayLabel, LIGHT_PALETTE } from '../src/ui/usageGraph';

const day = (date: number, month = 8) => new Date(2026, month, date).getTime();
const decode = (image: string) => Buffer.from(/base64,([^"]+)"/.exec(image)![1], 'base64').toString('utf8');

describe('daily usage graph rows', () => {
  it('handles no history and a single incomplete baseline without drawing consumed usage', () => {
    expect(formatDailyUsageGraphRows([], DARK_PALETTE)).toEqual([]);
    const baseline = [{ day: day(16), used: 0, incomplete: true }];
    const rows = formatDailyUsageGraphRows(baseline, DARK_PALETTE);
    const images = rows[0].match(/<img [^>]+>/g)!;
    expect(images).toHaveLength(1);
    expect(images[0]).toContain('alt="16 Sep · 0% recorded · Incomplete"');
    expect(images[0]).toContain('title="16 Sep · 0% recorded · Incomplete"');
    expect(decode(images[0])).not.toContain('rx="1"');
    expect(rows[1].match(/16 Sep/g)).toHaveLength(2);
  });

  it('renders one bottom-aligned image per day with its hover label, bright for this month and dim before', () => {
    const days = dailyUsage([], day(16, 8)).map((slot): DailyUsage => slot.day === day(31, 7) ? { ...slot, used: 2.2, incomplete: false }
      : slot.day === day(14, 8) ? { ...slot, used: 17.6, incomplete: false }
      : slot.day === day(15, 8) ? { ...slot, used: 0, incomplete: false }
      : slot.day === day(16, 8) ? { ...slot, used: 2, incomplete: true } : slot);
    const rows = formatDailyUsageGraphRows(days, DARK_PALETTE);
    expect(rows).toHaveLength(2);
    const images = rows[0].match(/<img [^>]+>/g)!;
    expect(images).toHaveLength(30);
    expect(rows[0]).not.toContain('> <img');
    expect(rows[0]).toContain('<tr><td colspan="2" align="center"><img ');
    expect(images.every((image) => / width="14" height="25" /.test(image))).toBe(true);
    expect(images[0]).toContain('title="18 Aug · Not tracked"');
    expect(images[13]).toContain('title="31 Aug · 2.2%"');
    expect(images[27]).toContain('title="14 Sep · 17.6%"');
    expect(images[28]).toContain('title="15 Sep · 0%"');
    expect(images[29]).toContain('title="16 Sep · 2% recorded · Incomplete"');
    expect(images.some((image) => image.includes('$('))).toBe(false);
    // The tallest day fills the 24px bar area; August bars use the dim colour.
    expect(decode(images[27])).toContain('<rect x="2.5" y="0" width="9" height="24" rx="1" fill="#cccccc"/>');
    expect(decode(images[13])).toContain('y="18" width="9" height="6" rx="1" fill="#4a4a4a"/>');
    expect(decode(images[29])).toContain('height="5" rx="1" fill="#cccccc"/>');
    // Empty and untracked days keep only the axis line so they still own a hover target.
    expect(decode(images[28])).not.toContain('rx="1"');
    expect(decode(images[0])).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="25"><rect y="24" width="14" height="1" fill="#454545"/></svg>');
    expect(rows[1]).toBe('<tr><td><span style="color:var(--vscode-descriptionForeground);">18 Aug</span></td>'
      + '<td align="right"><span style="color:var(--vscode-descriptionForeground);">16 Sep</span></td></tr>');
  });
  it('keeps tiny bars visible and changes the highlighted month with the date', () => {
    const days = dailyUsage([], day(1, 9)).map((slot): DailyUsage => slot.day === day(30, 8) ? { ...slot, used: 40, incomplete: false }
      : slot.day === day(1, 9) ? { ...slot, used: 0.004, incomplete: false } : slot);
    const images = formatDailyUsageGraphRows(days, LIGHT_PALETTE)[0].match(/<img [^>]+>/g)!;
    expect(images[28]).toContain('title="30 Sep · 40%"');
    expect(decode(images[28])).toContain('height="24" rx="1" fill="#c8c8c8"/>');
    expect(images[29]).toContain('title="1 Oct · &lt;0.01%"');
    expect(decode(images[29])).toContain('y="23" width="9" height="1" rx="1" fill="#616161"/>');
  });
  it('draws a day at a tenth of the peak at a fifth of the bar height', () => {
    const days = dailyUsage([], day(16, 8)).map((slot): DailyUsage => slot.day === day(14, 8) ? { ...slot, used: 20, incomplete: false }
      : slot.day === day(15, 8) ? { ...slot, used: 2, incomplete: false } : slot);
    const images = formatDailyUsageGraphRows(days, DARK_PALETTE)[0].match(/<img [^>]+>/g)!;
    expect(decode(images[27])).toContain('y="0" width="9" height="24"');
    expect(decode(images[28])).toContain('y="19" width="9" height="5"');
  });
  it('formats labels with at most two decimals', () => {
    expect(formatDayLabel({ day: day(3), used: 1.1, incomplete: false })).toBe('3 Sep · 1.1%');
    expect(formatDayLabel({ day: day(3), used: 1.23456, incomplete: true })).toBe('3 Sep · 1.23% recorded · Incomplete');
    expect(formatDayLabel({ day: day(3), used: 0, incomplete: true })).toBe('3 Sep · 0% recorded · Incomplete');
    expect(formatDayLabel({ day: day(3), incomplete: true })).toBe('3 Sep · Not tracked');
  });
});
