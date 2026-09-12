# Copilot Token Cost

## Project shape

- TypeScript VS Code extension showing local Copilot token usage and estimated AI Credit cost in the status bar and Copilot Sessions tree. The quota row reads the current account's allowance from GitHub.
- Entry point: `src/extension.ts`. esbuild ships `dist/extension.js`; TypeScript only typechecks.
- Keep usage local. No telemetry or network access beyond the GitHub quota request to `copilot_internal/user`.

## Commands

- `npm install`: install dependencies.
- `npm run check-types`: typecheck without building.
- `npm run compile`: typecheck and bundle.
- `npm run watch`: rebuild on changes without typechecking.
- `npm test`: run tests.
- `npm run preview`: rebuild and open a development window using the normal VS Code profile and real usage data.
- `npm run package`: build a production VSIX.
- `npm run install:local`: package, install, and open VS Code. Existing windows need a reload to use the new build.

After code changes, run compile, relevant tests, and preview. Docs-only changes need no build or tests.

## Code map

- `src/extension.ts`: activation, commands, status bar, and filesystem watchers.
- `src/ui/usageTreeProvider.ts`: session tree, quota row, and scan diagnostics.
- `src/ui/formatters.ts`: token, cost, and quota percentage formatting.
- `src/core/config.ts`: settings and the Copilot file-logging prerequisite.
- `src/core/locator.ts`: Stable/Insiders storage roots and optional custom scan path.
- `src/core/scanner.ts`: bounded discovery of JSON and JSONL files.
- `src/core/parser.ts`: JSON containers, JSONL records, and consumed byte counts.
- `src/core/normalizer.ts`: billed requests and chat-title metadata.
- `src/core/usageIndex.ts`: cached records, incremental reads, and disk reconciliation.
- `src/core/aggregator.ts`: period totals, chat summaries, and top models/sessions.
- `src/core/copilotAccount.ts`: this window's Copilot login and successful chat markers.
- `src/core/quota.ts`: GitHub quota request, response parsing, and credit labels.
- `src/core/quotaService.ts`: quota authentication, consent, refresh timing, and backoff.
- `src/dev/accountUsagePoc.ts`: account attribution and the saved usage ledger. Runs in production despite its name.
- `src/dev/preview.ps1`: development-window launcher.
- `src/core/types.ts`: shared types; `test/`: Vitest tests and fixtures.

## Change guidance

- Prefer small changes in the relevant module. Preserve strict TypeScript and the CommonJS target; add focused regression tests for behavior changes.
- Count only positive `copilotUsageNanoAiu`. Tokens are not billing; displayed USD is an estimate. Child runs bill to their parent session folder but never name the chat. Title-generation records supply metadata only.
- Attribute newer requests only with a unique window match and successful authentication evidence. Preserve uncertain requests without assigning an account. Historical usage stays unassigned. Local usage must work without quota permission.
- Preserve `globalStorageUri/account-poc`, observer journals, and `start.json`. Never reset them to recover from errors or limits. Use temporary copies for destructive tests; consent resets must preserve usage and Copilot sign-in.
- Keep scans bounded and tolerate unreadable files. Resume JSONL reads from `consumedBytes`, not a pre-read file size. Preserve saved request identity and billing when updating titles.
- Quota requests follow this window's Copilot account. Preserve the settle delay, one-minute floor, and failure backoff. An account switch may skip the floor, but not an explicit rate limit.
- Reuse GitHub sessions with empty scopes and `silent: true`. Interactive consent is allowed only for the manual quota command or once per account after a new successful panel request. Preserve the exclusive `quota-consent` claim across cancellation, reloads, and windows. Only the manual command may use `clearSessionPreference` for an unknown account. Never use `forceNewSession`.
