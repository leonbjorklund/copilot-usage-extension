# Tooltip graph handoff

## Current state and next step

- Work stays on `menu-design`. The user authorized local installation of the graph and account-specific tracking on September 7. Both now run in normal installed windows as well as development windows. Merging and publication remain separate actions.
- The user accepted the shorter graph, `avg.` label with spaced ` / day`, the `0.75` power scale, and mock usage with quiet days and a few busier standouts. Daily native tooltips and early-period caption placement were manually verified in preview. A distinct today-bar style was discussed but not chosen.
- Next step after committing and pushing this branch: install the audited build locally, reload existing windows, and verify live account switching and light/high-contrast hover appearance before merging or publishing. Non-Windows font fallback remains unverified. Preserve the accepted native hover behavior and content.
- Run `npm run preview` from the repo root to compile and open an Extension Development Host with the normal profile, real usage logs, and live quota. Run `npm run install:local` to package and install the same behavior. Existing normal windows need Developer: Reload Window to load the new build.
- The default mock date is 1 October 2026 at local noon, with only one day in the new period. Mock input requires launching a Development host with `COPILOT_USAGE_PREVIEW=1`; `npm run preview` clears that flag and always uses real data. The 21 September fixture remains in tests.
- `src/dev/tooltipGraphPrototype.ts` renders thirty adjacent full-height SVG images with native HTML `title` attributes, plus an axis image. `src/extension.ts` appends it in installed and development windows. Theme changes refresh the graph.
- `COPILOT_USAGE_PREVIEW=1` selects isolated mock input only in Development mode; installed windows ignore that flag. `src/dev/usagePreview.ts` supplies those temporary fixtures and mock quota. Normal activation uses the persisted local account ledger and live quota. `src/core/aggregator.ts` owns the daily rollup; `src/ui/formatters.ts` shares quota validation and formats the status percentage as `{spentPct}/100%`.
- Verification commands are `npm run compile` and `npm test`. The September 7 cleanup passed all 285 tests, compilation, and VSIX packaging. A replay of copied saved data preserved both accounts' totals across repeated refreshes and restarts; the real-data preview activated. Tests cover account switches, concurrent windows, delayed evidence, interrupted writes, quota failures, polling, graph calculations, and preview isolation. These checks do not establish live GitHub billing correctness or native theme appearance. The cleanup build has not been installed into normal windows by this task.

## Account tracking

- `src/dev/accountUsagePoc.ts` owns forward-only attribution. Its ledger lives in `context.globalStorageUri/account-poc`; each process appends its own observer journal. Preserve existing journals and `start.json`. Clearing them loses saved observations and resets the tracking boundary.
- A billed request needs a unique window match and successful authentication evidence. Requests around account switches and chats that predate a switch are excluded. A delayed session header can recover attribution later. Historical usage before the saved start time is never assigned to the current account.
- Confirmed usage stays visible when other requests cannot be attributed. Unresolved records remain in diagnostics and are retried; they do not create a permanent waiting banner. Unknown current account identity shows a waiting state. Window-log read failures show an error while available confirmed usage remains visible.
- After successful sign-in evidence arrives, polling displays that account's saved usage without waiting for quota. Status-bar percentage and the quota row use the matching account's live GitHub balance. Graph percentages use only its tracked spending and live quota capacity, so they can differ from the live balance.
- The ledger reader stops with an error above 256 observer journals or 32 MiB per file; log discovery stops above 512 window folders. Automatic compaction is not implemented. Preserve data if these limits are reached; do not reset or delete journals as recovery.
- [Account attribution research](ACCOUNT-ATTRIBUTION-RESEARCH.md) records the original source investigation and correlation limitations. This handoff describes the accepted implementation.

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
| tracked zero-usage day | `no usage` |
| day before tracking began | `not tracked` |
| first partially tracked day | append `tracked since {time}` to the daily value |

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
| `spentPct` | account's tracked credits in the local month ÷ quota, rounded |
| `ratePct` | `spentPct` ÷ tracked calendar days in the current month, 1 decimal |
| `projectedPct` | `spentPct` + `ratePct` × calendar days after today in the month, rounded |
| `avg` | 30-day window total ÷ tracked calendar days in that window, capped at 30 |

Count today as one day, including on the first tracked day. Averages and the
period caption have no 24-hour gate. The tracking boundary is the ledger's
saved start time. With mock input, which has no tracking boundary, use 30 days
for the average, the current day of the month for the rate, and
`ratePct × days in period` for the projection.

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

Daily rollups come from the **local account ledger**, populated from logs, so the graph renders offline. Only the
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
