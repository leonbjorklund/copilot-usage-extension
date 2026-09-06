# Status bar credits — tooltip redesign handoff

Visual reference: `Tooltip-Spec-v32.html` (open in a browser; hover the bars).

Target: a **webview-backed hover panel**, so per-bar hover works. The graph is
still built as a plain SVG **string** — no chart library, no canvas, no build
step. The same string powers the markdown fallback in §8.

---

## 1. Status bar item

```
{tokensToday} | {usdToday}$ • {periodPct} / 100%
```

Example: `2.1M | 0.87$ • 44 / 100%`

- tokens and USD are **today**; the percent is credits spent in the **current
  billing period**.
- `|` joins fields inside one concept, `•` separates concepts.
- If quota/period data is unavailable, drop ` • {periodPct} / 100%` entirely.

---

## 2. Tooltip — webview panel

The tooltip content is one HTML string. Structure top to bottom:

1. totals line — `Today: … | Month: … | All time: …` + info icon, right-aligned
2. `Model use:` — 3 rows, name left (ellipsised), `{n} sessions · {tokens} ({usd}$)` right
3. `Top sessions today:` — 2 rows, title + dim model name left, `{tokens} ({usd}$)` right
4. `Last 30 days` header, right side `{avgTokens} ({avgUsd}$)/day`
5. the graph (§3)
6. the axis row (§4)

1px `#454545` dividers with 7px vertical margins between each block. Content
width 430px, padding `4px 8px`, body type 13px/19px.

```ts
const html = `
<div style="width:430px;background:#202020;border:1px solid #454545;border-radius:3px;padding:4px 8px;font:13px/19px var(--vscode-font-family);color:#cccccc">
  ${totalsRow(today, month, allTime)}
  ${divider}
  ${modelUse(models)}
  ${divider}
  ${topSessions(sessions)}
  ${divider}
  ${lastThirtyHeader(avg)}
  ${graph(days, period)}
  ${axisRow(days, period)}
</div>`;
```

Prefer `var(--vscode-*)` variables over the literal hex values in §6 where an
equivalent exists; the hex list is the dark-theme reference.

## 3. Graph — SVG string + hover

Rolling 30 days, always. One slot per day for `today-29 … today`; zero-usage
days keep their slot and draw no bar, so the axis stays linear in time.

```ts
interface Day { date: Date; credits: number; tokens: number; usd: number; }
interface Period { start: Date; daysInPeriod: number; quota: number; spent: number; }

const FG = "#cccccc";       // bars inside the current billing period
const FG_PAST = "#4a4a4a";  // bars before the period started
const AXIS = "#454545";
const TICK = "#9d9d9d";

const W = 544, BASE = 52, TOP = 4, X0 = 8, WIDTH = 528;

function graph(days: Day[], p: Period): string {
  const step = WIDTH / days.length;
  const bw = Math.min(11, step - 3);
  const max = Math.max(...days.map(d => d.credits), 1);
  const boundIdx = days.findIndex(d => d.date >= p.start);
  const r = (n: number) => Math.round(n * 10) / 10;

  const hit: string[] = [];
  const bar: string[] = [];

  days.forEach((d, i) => {
    const cx = X0 + i * step + step / 2;
    const h = d.credits > 0 ? Math.max(1.5, (d.credits / max) * (BASE - TOP)) : 0;
    // full-column hit target, drawn first so bars sit on top
    hit.push(
      `<rect class="hit" data-i="${i}" x="${r(cx - step / 2)}" y="2" ` +
      `width="${r(step)}" height="50" fill="transparent"/>`
    );
    if (h > 0) {
      bar.push(
        `<rect class="bar" data-i="${i}" x="${r(cx - bw / 2)}" y="${r(BASE - h)}" ` +
        `width="${r(bw)}" height="${r(h)}" rx="1" ` +
        `fill="${i >= boundIdx ? FG : FG_PAST}"/>`
      );
    }
  });

  const boundX = r(X0 + boundIdx * step);
  const endX = X0 + WIDTH - 0.5;

  return `
<div class="graph" style="position:relative;padding-top:16px">
  <span id="chip"></span>
  <svg viewBox="0 0 ${W} 60" style="width:100%;height:auto;display:block">
    ${hit.join("")}
    ${bar.join("")}
    <line x1="${X0}" y1="52.5" x2="${X0 + WIDTH}" y2="52.5" stroke="${AXIS}"/>
    <rect x="${boundX}" y="53.5" width="1" height="6" fill="${TICK}"/>
    <rect x="${endX}" y="53.5" width="1" height="6" fill="${TICK}"/>
  </svg>
</div>`;
}
```

Hover behaviour (one listener, delegated on the `.hit` rects):

- hovered bar's fill becomes `#ffffff`; all others revert to their base fill
- the chip is absolutely positioned **above the hovered bar's top edge**,
  horizontally centred on it, `transform: translateX(-50%)`, background
  `#202020` so it knocks out of anything behind it, `pointer-events:none`
- clamp `left` to **20–74%** of the width so the chip never leaves the box
- chip `top` = `16 + barY * (430 / 544) - 19` px, floored at 0
- chip content: date in `#8c8c8c`, value in `#ffffff`, 12px, tabular figures
- on mouseleave of the graph, clear the chip and restore fills

Chip value formatting:

| case | text |
|---|---|
| day inside the period | `{dayPct}% · {tokens} ({usd}$)` |
| day before the period | `{tokens} ({usd}$)` — no quota to be a share of |
| zero-usage day | `no usage` |

## 4. Axis row

One row under the graph, 12px, tabular figures, positioned proportionally:

- **flush left:** window start date (`today-29`, e.g. `23 Aug`), `#8c8c8c`
- **centred on the period start tick:** period start date (`1 Sep`), `#8c8c8c`
- **centred between the two ticks:** the caption (§5)

Percentages for the two label positions come from the same geometry as the
graph: `boundX / 544` and `((boundX + endX) / 2) / 544`.

If the period start falls within ~56px of the window start, drop the period
start label rather than let the two collide.



## 5. Numbers & caption

```
Period {spentPct}% · {ratePct}%/day · {projectedPct}% projected
```

`Period {spentPct}%` in `#cccccc`, the rest in `#8c8c8c`. Nothing else goes on
this line.

| value | formula |
|---|---|
| `spentPct` | credits spent in period ÷ quota, rounded |
| `ratePct` | `spentPct` ÷ days elapsed in period, 1 decimal |
| `projectedPct` | `ratePct` × days in period, rounded |
| `avg` | 30-day window total ÷ 30 |

Period boundaries are calendar-monthly (1 Aug → 1 Sep …). The graph never
locks to them — it is always the last 30 days.

---

## 6. Colours & type

| token | value |
|---|---|
| tooltip bg | `#202020` |
| tooltip border | `#454545` |
| axis, dividers | `#454545` |
| period ticks | `#9d9d9d` |
| bars, in period | `#cccccc` |
| bars, before period | `#4a4a4a` |
| bar hover | `#ffffff` |
| primary text | `#cccccc` |
| secondary text | `#8c8c8c` |
| body type | 13px / 19px |
| captions, numeric rows | 12px, tabular figures |

These are the VS Code dark defaults — map to theme tokens
(`descriptionForeground`, `charts.lines`, etc.) where equivalents exist.

---

## 7. Data source

Daily rollups come from **local logs**, so the graph renders offline. Only the
percentages need account quota + period boundaries; when those are missing,
render the graph and omit the caption and the status bar percent.

## 8. Markdown-string fallback

If the webview is gated behind a setting or fails to load, the same graph string
works as a `MarkdownString` image — base64, not percent-encoding, or raw `#`
and `<` break the URI:

```ts
const md = new vscode.MarkdownString(undefined, true);
md.supportHtml = true;
md.isTrusted = true;
// …text blocks…
const svg = graphSvgOnly(days, period);           // §3 without the hit rects or chip
md.appendMarkdown(`![](data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")})`);
```

In this mode the axis labels and caption must be drawn **inside** the SVG as
`<text>` (markdown can't position them), and there is no per-bar hover — a
`data:` URI image has no pointer events and VS Code strips scripts.

## 9. Explicitly rejected

Kept out on purpose — don't reintroduce them:

- horizontal rule connecting the two period ticks
- shaded/tinted period region, walls, or arrows
- daily-allowance threshold lines and overspend zones
- meter/progress bars anywhere in the tooltip or status bar
- credit counts in the tooltip (percent, tokens and USD only)
