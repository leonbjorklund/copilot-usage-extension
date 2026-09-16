# Copilot Token Cost

## Project shape

- TypeScript VS Code extension showing local Copilot token usage and estimated AI Credit cost in the status bar and Copilot Sessions tree. The quota row reads the account's server-reported allowance from Copilot's local output log.
- Entry point: `src/extension.ts`. esbuild ships `dist/extension.js`; TypeScript only typechecks.
- Keep usage local. Quota comes from Copilot's own output log. No telemetry, GitHub session requests, or authenticated quota-fetch path.

## Commands

- `npm install`: install dependencies.
- `npm run check-types`: typecheck without building.
- `npm run compile`: typecheck and bundle.
- `npm run watch`: rebuild on changes without typechecking.
- `npm test`: run tests.
- `npm run preview`: run tests, rebuild, and open a development window using the normal VS Code profile and real usage data.
- `npm run package`: build a production VSIX.
- `npm run install:local`: package, install, and open VS Code. Existing windows need a reload to use the new build.

After code changes, run compile, relevant tests, and preview. Docs-only changes need no build or tests.

Preview and F5 share real sign-ins. Use their test gates; never run old authenticated quota builds against this profile. Reproduce account transitions with temporary log fixtures first. Live sign-in, sign-out, and account switching belong to the user; diagnosing this extension must not create sessions or edit VS Code's authentication storage.

## Code map

- `src/extension.ts`: activation, commands, status bar, and filesystem watchers.
- `src/ui/usageTreeProvider.ts`: session tree, quota row, and scan diagnostics.
- `src/ui/formatters.ts`: token, cost, credit, quota percentage, and monthly pace formatting.
- `src/ui/usageGraph.ts`: tooltip daily usage graph as per-day SVG data images with native hover titles. Bar heights are relative to the tallest day, compressed with exponent 0.7 so one heavy day does not flatten the rest.
- `src/core/config.ts`: settings and the Copilot file-logging prerequisite.
- `src/core/locator.ts`: Stable/Insiders storage roots and optional custom scan path.
- `src/core/scanner.ts`: bounded discovery of JSON and JSONL files.
- `src/core/parser.ts`: JSON containers, JSONL records, and consumed byte counts.
- `src/core/normalizer.ts`: billed requests and chat-title metadata.
- `src/core/usageIndex.ts`: cached records, incremental reads, and disk reconciliation.
- `src/core/aggregator.ts`: period totals, chat summaries, and top models/sessions.
- `src/core/quota.ts`: server snapshot parsing and precise usage percentages.
- `src/core/quotaService.ts`: bounded current-window log reads and account matching.
- `src/core/quotaHistory.ts`: shared append-only journal of allowance percentages and per-day usage with completeness.
- `src/core/quotaLogging.ts`: persistent scoped Copilot Trace logging.
- `src/dev/accountUsagePoc.ts`: account attribution and the saved usage ledger. Runs in production despite its name.
- `src/dev/preview.ps1`: development-window launcher.
- `src/core/types.ts`: shared types; `test/`: Vitest tests and fixtures.

## Change guidance

- Prefer small changes in the relevant module. Preserve strict TypeScript and the CommonJS target; add focused regression tests for behavior changes.
- Count only positive `copilotUsageNanoAiu`. Tokens are not billing; displayed USD is an estimate. Child runs bill to their parent session folder but never name the chat. Title-generation records supply metadata only.
- Attribute newer requests only with a unique window match and successful authentication evidence. Preserve uncertain requests without assigning an account. Historical usage stays unassigned. Local usage must work when quota is unavailable.
- Preserve `globalStorageUri/account-poc`, `ledger.jsonl`, older `observer-*.jsonl` journals, and `start.json`. Never reset them to recover from errors or limits. Every window appends whole lines to the shared `ledger.jsonl`; observer journals are read but never written. A ledger line that is not JSON is a torn write: skip and count it, never repair it. An entry that parses but fails validation must fail every refresh. Use temporary copies for destructive tests. Preserve Copilot sign-in and other extensions' approvals.
- Keep scans bounded and tolerate unreadable files. Resume JSONL reads from `consumedBytes`, not a pre-read file size. Preserve saved request identity and billing when updating titles.
- Tooltip HTML is sanitized by VS Code: only `img` size, `src`, `title`, and `alt` and span colors survive, so the graph is per-day data images. Assign the status bar tooltip only when its markdown changed; every assignment redraws an open hover. Daily usage assigns a percentage rise to a day only when both observations fall on that day; unobserved gaps stay incomplete or untracked, never guessed. `quota-history.jsonl` is append-only and shared by all windows; never rewrite it.
- Quota follows successful account evidence in this window. Keep the last reported percentage without time-based expiry. Reject untagged responses after account switches. Log rotation without account evidence stays unavailable. Keep server percentage precision; do not reconstruct exact spent credits.
- Keep the Copilot Chat Trace default enabled across reloads and shutdown. Preserve other logging settings and explicit channel overrides. Never extract or reuse Copilot credentials.
