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
- `src/core/accountTracking.ts`: account attribution, the saved usage ledger, and its rollover into per-day snapshots.
- `src/dev/preview.ps1`: development-window launcher.
- `src/core/types.ts`: shared types; `test/`: Vitest tests and fixtures.

## Change guidance

- If evidence shows an existing design rule causes incorrect behavior, present the evidence, proposed change, and drawbacks, then ask before changing the rule or affected product behavior. Do not preserve a bug merely to comply with the current design.
- Prefer small changes in the relevant module. Preserve strict TypeScript and the CommonJS target; add focused regression tests for behavior changes.
- Count only positive `copilotUsageNanoAiu`. Tokens are not billing; displayed USD is an estimate. Child runs bill to their parent session folder but never name the chat. Title-generation records supply metadata only.
- Attribute newer requests only with a unique window match and successful authentication evidence. Preserve uncertain requests without assigning an account. Historical usage stays unassigned. Local usage must work when quota is unavailable.
- The log a window is writing may have dropped a switch when it no longer starts with the bytes already read from it. Treat that as a switch, unless another log re-read in the same refresh still begins with those exact bytes, which is how rotation into a numbered sibling stays free. A numbered sibling already read to its end is not itself losable, since rotation replacing or deleting it drops nothing unread. Uncertainty starts just past the matching tolerance after reading stopped, since everything erased was written later, while a request already read in full must not be rejected as a change around itself. It is never later than the refresh that finds it, or the old account stays on display. Only a later successful token names an owner again, including one another window recorded before those lines vanished. The record of what was read must survive a failed ledger append, or the next refresh forgets the loss.
- Preserve `globalStorageUri/account-tracking/start.json` and recorded usage. Append whole lines to `ledger.jsonl`; rollover renames it to `ledger-<ms>-<uuid>.jsonl`. Append retries must survive retirement of the file they opened. Never truncate, rewrite, or reset shared files to recover from errors. Use temporary copies for destructive tests. Preserve Copilot sign-in and other extensions' approvals.
- Requests older than seven days freeze into per-day rollups after their rolled ledger settles for ten minutes. Rewrites caused only by aging wait at least ten minutes after the loaded snapshot's `at`; absorbable ledgers need no additional wait. Frozen account decisions, including unresolved ones, are permanent; younger requests retain their evidence. Do not append bills older than this window; newly discovered requests that old do not enter the account ledger. Snapshots retain exact request hashes in bounded `frozen-keys` rows to reject late duplicates.
- Publish `snapshot-<generation>-<uuid>.jsonl` only after fsync, using an exclusive hard link to the deterministic successor name; concurrent losers must not replace it. Validate the complete snapshot, including its declared line count, before retiring absorbed rolled ledgers. Failed snapshot reads discard partial state and must fail again on retry without deleting sources. Invalid JSON in append-only ledgers is a torn write: skip and count it. Parsed but invalid entries must fail every refresh.
- Keep scans bounded and tolerate unreadable files. Resume JSONL reads from `consumedBytes`, not a pre-read file size. Preserve saved request identity and billing when updating titles.
- Tooltip HTML is sanitized by VS Code: only `img` size, `src`, `title`, and `alt` and span colors survive, so the graph is per-day data images. Assign the status bar tooltip only when its markdown changed; every assignment redraws an open hover. Daily usage assigns a percentage rise to a day only when both observations fall on that day; unobserved gaps stay incomplete or untracked, never guessed. `quota-history.jsonl` is append-only and shared by all windows; never rewrite it.
- Quota follows successful account evidence in this window. Before this window verifies an account, quota stays unavailable. If log evidence for a verified account is lost, show newer quota without an account or account-specific graph and never journal it. A different ledger account must not hide anonymous quota. Only a nonempty unchanged prefix in the same current file proves continuity; surviving backups cannot rule out erased intervening lines. Treat every replacement or read gap as a possible switch, even if the next token names the same account. After a switch or gap, named quota and history accept only token-derived snapshots; reject delayed untagged responses. Sign-in or token activity hides anonymous quota until a successful token and its quota snapshot arrive. Keep the last reported percentage without time-based expiry and preserve server precision; do not reconstruct exact spent credits.
- Keep the Copilot Chat Trace default enabled across reloads and shutdown. Preserve other logging settings and explicit channel overrides. Never extract or reuse Copilot credentials.
