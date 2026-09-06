# Tooltip graph handoff

## Current state and next step

- Work stays on `menu-design`. This is a preview checkpoint, not a production rollout; do not merge, package, install, or wire the graph into the normal tooltip yet.
- The user accepted the shorter graph, `avg.` label with spaced ` / day`, the `0.75` power scale, and mock usage with quiet days and a few busier standouts. Daily native tooltips and early-period caption placement were manually verified in preview. A distinct today-bar style was discussed but not chosen.
- Next, check the accepted preview in light and high-contrast themes; non-Windows font fallback also needs verification before production wiring. Preserve the accepted native hover behavior and content. Production wiring needs a later explicit request.
- Run `npm run preview` from the repo root to compile and open an Extension Development Host with mock input. Hover the status bar and move across populated and empty columns. Each column should show its date and values or `no usage`; the caption should remain inside its existing axis row.
- The default mock date is 1 October 2026 at local noon, with only one day in the new period. To inspect another date, change the default in `src/dev/usagePreview.ts` and rerun preview. The 21 September fixture remains in tests.
- `src/dev/tooltipGraphPrototype.ts` renders thirty adjacent full-height SVG images with native HTML `title` attributes, plus an axis image. `src/extension.ts` appends it only when `COPILOT_USAGE_PREVIEW=1` and the extension runs in Development mode. Theme changes refresh the preview.
- `src/dev/usagePreview.ts` writes temporary raw JSONL inputs for the normal `UsageIndex` pipeline and supplies mock quota. The fixture is illustrative, not a measured average user. Preview does not read real usage or request account quota. `src/core/aggregator.ts` owns the daily rollup; `src/ui/formatters.ts` shares quota validation and formats the status percentage as `{spentPct}/100%`.
- Verification commands are `npm run compile` and `npm test`. Graph tests cover empty days, fractional credits, caption placement, missing or stale quota, and local/UTC month disagreement. Extension tests cover preview isolation and theme refresh. Light/high-contrast appearance and non-Windows font fallback still need manual checks before production wiring.

## Behavior

- Keep the graph inside the existing status-bar hover popup without changing how it opens, closes, or responds to clicks.
- Preserve existing content and overall styling while refining the graph below.
- Show daily AI-credit usage over the last 30 days, retain zero-usage days, and distinguish the current billing period.
- Hovering a day's column shows its date and daily values from the handoff, including zero-usage days.
- Use native HTML image-title tooltips for daily details. Their appearance, position, and delay are controlled by VS Code's browser host and are accepted constraints. Bar highlighting on hover is not required.
- Choose the simplest solution with the least ongoing overhead, regardless of how much code needs rewriting.
- The per-column image approach is accepted. See `GRAPH-OPTIONS.md` for the research and verified outcome.

Visual reference: `Tooltip-Spec-v32.html` (open in a browser; hover the bars). It is the original design reference, not the current implementation. This handoff supersedes its custom hover chip, hover highlight, spaced status percentage, and unclamped axis caption. Its sample totals are illustrative; preview totals come from raw mock logs.

---

## 1. Graph placement

Append below the existing tooltip content:

1. `Last 30 days` header, right side `avg. {avgTokens} ({avgUsd}$) / day`
2. the graph (§2)
3. the axis row (§3)

1px `#454545` dividers with 7px vertical margins between each block. Content
width 430px, padding `4px 8px`, body type 13px/19px.

The colours in §5 are the dark-theme reference.

## 2. Graph and hover

Rolling 30 days, always. One slot per day for `today-29 … today`; zero-usage
days keep their slot and draw no bar, so the axis stays linear in time.

Bar height uses `max(1.5, (dayCredits / largestDayCredits) ** 0.75 * 30)` for
positive usage. The largest day across all 30 days gets 30px; smaller days are
gently lifted, so height ratios are not exact usage ratios. Zero days draw no bar.
There are no caps or slash markers; hover values remain unchanged. The scale
updates with the rolling window, independently of the account quota.

Each column image is 44px tall, with a baseline at 35px and a separate 18px date
axis. Bars before the current period are dimmed, and bars inside it are brighter.
These accepted dimensions and scaling supersede the original visual reference;
retain its bar spacing and rounded corners.

Hover behaviour:

- hovering anywhere in a day's column shows its details, including zero-usage days
- native tooltips show the date followed by the daily values below
- bar fills stay unchanged on hover; the host controls tooltip placement, delay, styling, and dismissal

Daily value formatting:

| case | text |
|---|---|
| day inside the period | `{dayPct}% · {tokens} ({usd}$)` |
| day before the period | `{tokens} ({usd}$)` — no quota to be a share of |
| zero-usage day | `no usage` |

## 3. Axis row

One row under the graph, 12px, tabular figures, positioned proportionally:

- **flush left:** window start date (`today-29`, e.g. `23 Aug`), `#8c8c8c`
- **centred on the period start tick:** period start date (`1 Sep`), `#8c8c8c`
- **prefer centred between the two ticks:** the caption (§4), shifted left only as needed to fit the right edge

If the period start falls within ~56px of the window start, drop the period
start label rather than let the two collide. Also hide it if it overlaps the
caption, keeping its tick and daily hover date. The caption may extend under
older days; keep it on this same row without wrapping or shrinking its font.
The preview estimates collisions using the fixed 12px Segoe UI font and uses
right anchoring when the caption reaches the edge.

## 4. Numbers & caption

```
Period {spentPct}% · {ratePct}%/day · {projectedPct}% projected
```

`Period {spentPct}%` in `#cccccc`, the rest in `#8c8c8c`. The caption shares
the axis row with the date labels in §3.

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
| primary text | `#cccccc` |
| secondary text | `#8c8c8c` |
| body type | 13px / 19px |
| captions, numeric rows | 12px, tabular figures |

Match VS Code's active theme; the values above are the dark-theme reference.

---

## 6. Data source

Daily rollups come from **local logs**, so the graph renders offline. Only the
percentages need account quota + period boundaries; when those are missing,
invalid, unlimited, or expired, render the graph and omit the caption and daily
percentages. Daily slots use local calendar dates, including DST transitions.
Quota resets use UTC; while the local and UTC month disagree, omit graph
percentages rather than attribute another month's quota to the local period.

## 7. Explicitly rejected

Kept out on purpose — don't reintroduce them:

- horizontal rule connecting the two period ticks
- shaded/tinted period region, walls, or arrows
- daily-allowance threshold lines and overspend zones
- meter/progress bars anywhere in the tooltip or status bar
- credit counts in the tooltip (percent, tokens and USD only)
