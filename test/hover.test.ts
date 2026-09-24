import { describe, expect, it } from 'vitest';

import { DARK, hoverMarkdown, LIGHT } from '../src/hover';
import type { Reading, Records } from '../src/quota';

const RESET = '2026-10-01T00:00:00.000Z';
const time = (day: number, hour: number, month = 9) => new Date(2026, month - 1, day, hour).getTime();
const now = time(23, 16);
const images = (markdown: string) => markdown.match(/<img [^>]+>/g)!;
const svg = (image: string) => Buffer.from(/base64,([^"]+)"/.exec(image)![1], 'base64').toString('utf8');
const muted = (text: string) => `<span style="color:var(--vscode-descriptionForeground);">${text}</span>`;
const info = '<a href="https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals" ' +
  'title="How GitHub bills Copilot credits">$(info)</a>';

function reading(at: number, percentRemaining: number, extra: Partial<Reading> = {}): Reading {
  return { at, quota: 80000, percentRemaining, resetDate: RESET, unlimited: false, ...extra };
}

describe('hover', () => {
  it('shows today with the account, then the month with its pace and the graph', () => {
    const records: Records = {
      leon: [reading(time(20, 9), 60)],
      'leon-work': [reading(time(22, 23), 26.6), reading(time(23, 15), 23.5)],
    };
    const markdown = hoverMarkdown(records, now, DARK, [])!;
    const lines = markdown.split('\n');
    expect(lines.slice(0, 7)).toEqual([
      '<table width="100%">',
      '<tr><td><strong>Today:</strong> 3.1%&nbsp;&nbsp;(2\u00a0480)</td>' +
        `<td align="right">${muted('leon-work')}&nbsp;&nbsp;${info}</td></tr>`,
      '</table>',
      '',
      '---',
      '',
      '<table width="100%">',
    ]);
    // 76.5% used by 15:00 on the 23rd of a 30-day month.
    const pace = 76.5 * 30 * 24 / ((22 * 24) + 15 + new Date(time(23, 15)).getTimezoneOffset() / 60);
    expect(lines[7]).toBe('<tr><td><strong>Month:</strong> 76.5%&nbsp;/&nbsp;100%&nbsp;&nbsp;' +
      `(61\u00a0200&nbsp;/&nbsp;80\u00a0000&nbsp;credits)</td><td align="right">&nbsp;&nbsp;${
        pace.toLocaleString('en-US', { maximumFractionDigits: 1 })}%&nbsp;monthly&nbsp;pace</td></tr>`);
    expect(lines[8]).toMatch(/^<tr><td colspan="2" align="center">(<img [^>]+>){30}<\/td><\/tr>$/);
    // The graph follows the same account.
    expect(images(markdown)[26]).toContain('title="20 Sep · Not tracked"');
    expect(lines[9]).toBe(`<tr><td>${muted('25 Aug')}</td><td align="right">${muted('23 Sep')}</td></tr>`);
    expect(lines.slice(10)).toEqual(['</table>']);
  });

  it('shows spending past the allowance with the allowance first', () => {
    const markdown = hoverMarkdown({ leon: [reading(time(22, 20), 1), reading(time(23, 15), 0, { additionalUsageUsed: 2560 })] },
      now, DARK, [])!;
    expect(markdown).toContain('<strong>Today:</strong> 4.2%&nbsp;&nbsp;(3\u00a0360)');
    expect(markdown).toContain('<strong>Month:</strong> 100%&nbsp;/&nbsp;103.2%&nbsp;&nbsp;' +
      '(80\u00a0000&nbsp;/&nbsp;82\u00a0560&nbsp;credits)');
  });

  it('keeps the used share first until the allowance is spent', () => {
    expect(hoverMarkdown({ leon: [reading(time(23, 15), 0.5)] }, now, DARK, []))
      .toContain('<strong>Month:</strong> 99.5%&nbsp;/&nbsp;100%&nbsp;&nbsp;');
  });

  it('shows the pace as unavailable without a reset at the start of next month', () => {
    for (const resetDate of [undefined, '2026-10-23T15:00:00.000Z']) {
      expect(hoverMarkdown({ leon: [reading(time(23, 15), 23.5, { resetDate })] }, now, DARK, []))
        .toContain('<td align="right">&nbsp;&nbsp;Pace&nbsp;unavailable</td>');
    }
  });

  it('names unlimited and zero allowances next to the account, without numbers or graph', () => {
    expect(hoverMarkdown({ leon: [reading(time(23, 15), 100, { quota: -1, unlimited: true })] }, now, DARK, [])).toBe(
      `<table width="100%">\n<tr><td>Unlimited&nbsp;Copilot&nbsp;quota</td><td align="right">${muted('leon')}&nbsp;&nbsp;${info}` +
      '</td></tr>\n</table>');
    expect(hoverMarkdown({ leon: [reading(time(23, 15), 0, { quota: 0 })] }, now, DARK, []))
      .toContain('<tr><td>No&nbsp;Copilot&nbsp;credit&nbsp;allowance</td>');
    expect(hoverMarkdown({ leon: [reading(time(23, 15), 100, { quota: 300, unlimited: true })] }, now, DARK, []))
      .toContain('<tr><td>Unlimited&nbsp;Copilot&nbsp;quota</td>');
  });

  it('shows only model use before any reading, and nothing without either', () => {
    expect(hoverMarkdown({}, now, DARK, [{ model: 'claude-opus-5', chats: 1, share: 100 }])).toBe('<table width="100%">\n' +
      '<tr><td colspan="2"><strong>Model use this month</strong></td></tr>\n' +
      '<tr><td>1. claude-opus-5</td><td align="right">1 session · 100%</td></tr>\n</table>');
    expect(hoverMarkdown({}, now, DARK, [])).toBeUndefined();
  });
});

describe('model use', () => {
  const models = [{ model: 'claude-opus-5.5', chats: 1310, share: 94.04 }, { model: 'gpt-6-luna', chats: 1, share: 3 },
    { model: '<b>x&y</b>', chats: 7, share: 0.01 }];
  const section = [
    '',
    '---',
    '',
    '<table width="100%">',
    '<tr><td colspan="2"><strong>Model use this month</strong></td></tr>',
    '<tr><td>1. claude-opus-5.5</td><td align="right">1\u00a0310 sessions · 94%</td></tr>',
    '<tr><td>2. gpt-6-luna</td><td align="right">1 session · 3%</td></tr>',
    '<tr><td>3. &lt;b&gt;x&amp;y&lt;/b&gt;</td><td align="right">7 sessions · 0%</td></tr>',
    '</table>',
  ].join('\n');

  it('ends the hover with the top models, their chats and share', () => {
    const records = { leon: [reading(time(23, 15), 23.5)] };
    expect(hoverMarkdown(records, now, DARK, models)).toBe(`${hoverMarkdown(records, now, DARK, [])}\n${section}`);
  });

  it('follows unlimited and zero allowances too', () => {
    const records = { leon: [reading(time(23, 15), 100, { quota: -1, unlimited: true })] };
    expect(hoverMarkdown(records, now, DARK, models)).toBe(`${hoverMarkdown(records, now, DARK, [])}\n${section}`);
  });
});

describe('graph', () => {
  it('draws one bottom-aligned bar per day, bright this month and dim before, scaled to the busiest day', () => {
    const readings = [
      reading(time(26, 9, 8), 80), reading(time(31, 20, 8), 77.8),
      reading(time(13, 20), 70), reading(time(14, 20), 52.4), reading(time(15, 20), 52.4),
      reading(time(22, 20), 50), reading(time(23, 15), 48),
    ];
    const bars = images(hoverMarkdown({ leon: readings }, now, DARK, [])!);
    expect(bars).toHaveLength(30);
    expect(bars.every((image) => / width="14" height="25" /.test(image))).toBe(true);
    expect(bars[0]).toContain('alt="25 Aug · Not tracked" title="25 Aug · Not tracked"');
    expect(bars[1]).toContain('title="26 Aug · 0%"');
    expect(bars[6]).toContain('title="31 Aug · 2.2%"');
    expect(bars[19]).toContain('title="13 Sep · 7.8%"');
    expect(bars[20]).toContain('title="14 Sep · 17.6%"');
    expect(bars[21]).toContain('title="15 Sep · 0%"');
    expect(bars[28]).toContain('title="22 Sep · 2.4%"');
    expect(bars[29]).toContain('title="23 Sep · 2%"');
    // The busiest day fills the 24px bar area; August bars use the dim colour.
    expect(svg(bars[20])).toContain('<rect x="2.5" y="0" width="9" height="24" rx="1" fill="#cccccc"/>');
    expect(svg(bars[6])).toContain('y="18" width="9" height="6" rx="1" fill="#4a4a4a"/>');
    expect(svg(bars[29])).toContain('y="19" width="9" height="5" rx="1" fill="#cccccc"/>');
    // Empty and untracked days keep only the axis line, so they still own a hover target.
    expect(svg(bars[0])).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="25">' +
      '<rect y="24" width="14" height="1" fill="#454545"/></svg>');
    expect(svg(bars[21])).not.toContain('rx="1"');
  });

  it('still draws a tiny day past the allowance, labeled 0%', () => {
    const readings = [reading(time(22, 20), 0, { additionalUsageUsed: 2560 }), reading(time(23, 15), 0, { additionalUsageUsed: 2590 })];
    const bars = images(hoverMarkdown({ leon: readings }, now, DARK, [])!);
    expect(bars[29]).toContain('title="23 Sep · 0%"');
    expect(hoverMarkdown({ leon: readings }, now, DARK, [])).toContain('<strong>Today:</strong> 0%&nbsp;&nbsp;(30)');
    expect(svg(bars[29])).toContain('height="24" rx="1"');
  });

  it('keeps tiny bars visible, uses the light palette, and moves the bright month with the date', () => {
    const readings = [reading(time(29, 20), 50), reading(time(30, 20), 10),
      reading(time(1, 15, 10), 99.9, { resetDate: '2026-11-01T00:00:00.000Z' })];
    const bars = images(hoverMarkdown({ leon: readings }, time(1, 16, 10), LIGHT, [])!);
    expect(bars[28]).toContain('title="30 Sep · 40%"');
    expect(svg(bars[28])).toContain('height="24" rx="1" fill="#c8c8c8"/>');
    // The reset counts October from zero.
    expect(bars[29]).toContain('title="1 Oct · 0.1%"');
    expect(svg(bars[29])).toContain('y="23" width="9" height="1" rx="1" fill="#616161"/>');
    expect(svg(bars[29])).toContain('fill="#d4d4d4"/>');
  });
});
