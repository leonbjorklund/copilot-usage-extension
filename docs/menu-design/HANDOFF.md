# Tooltip graph handoff

Visual reference: `Tooltip-Spec-v32.html` (open in a browser; hover the bars).

---

## 1. Graph placement

Append below the existing tooltip content:

1. `Last 30 days` header, right side `{avgTokens} ({avgUsd}$)/day`
2. the graph (§2)
3. the axis row (§3)

1px `#454545` dividers with 7px vertical margins between each block. Content
width 430px, padding `4px 8px`, body type 13px/19px.

The colours in §5 are the dark-theme reference.

## 2. Graph and hover

Rolling 30 days, always. One slot per day for `today-29 … today`; zero-usage
days keep their slot and draw no bar, so the axis stays linear in time.

Bar height represents daily credit usage on a shared scale; every positive-usage
day has a visible bar. Bars before the current period are dimmed, and bars inside
it are brighter. Match the bar spacing, proportions, rounded corners, baseline,
and period ticks in the visual reference.

Hover behaviour:

- hovering anywhere in a day's column shows its details, including zero-usage days
- hovered bar's fill becomes `#ffffff`; all others revert to their base fill
- the chip sits **above the hovered bar's top edge**, horizontally centred on it,
  with background `#202020` so content behind it does not show through
- keep the chip's centre within **20–74%** of the width so it never leaves the box
- keep the chip above the bar without extending above the graph area
- moving the pointer across the chip must not interrupt the day's hover details
- chip content: date in `#8c8c8c`, value in `#ffffff`, 12px, tabular figures
- when the pointer leaves the graph, hide the chip and restore bar colours

Chip value formatting:

| case | text |
|---|---|
| day inside the period | `{dayPct}% · {tokens} ({usd}$)` |
| day before the period | `{tokens} ({usd}$)` — no quota to be a share of |
| zero-usage day | `no usage` |

## 3. Axis row

One row under the graph, 12px, tabular figures, positioned proportionally:

- **flush left:** window start date (`today-29`, e.g. `23 Aug`), `#8c8c8c`
- **centred on the period start tick:** period start date (`1 Sep`), `#8c8c8c`
- **centred between the two ticks:** the caption (§4)

If the period start falls within ~56px of the window start, drop the period
start label rather than let the two collide.



## 4. Numbers & caption

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

## 5. Colours & type

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

Match VS Code's active theme; the values above are the dark-theme reference.

---

## 6. Data source

Daily rollups come from **local logs**, so the graph renders offline. Only the
percentages need account quota + period boundaries; when those are missing,
render the graph and omit the caption.

## 7. Explicitly rejected

Kept out on purpose — don't reintroduce them:

- horizontal rule connecting the two period ticks
- shaded/tinted period region, walls, or arrows
- daily-allowance threshold lines and overspend zones
- meter/progress bars anywhere in the tooltip or status bar
- credit counts in the tooltip (percent, tokens and USD only)
