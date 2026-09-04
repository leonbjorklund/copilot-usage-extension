# Copilot Usage Extension Agent Notes

## Project Shape

- VS Code extension in TypeScript. Entry point: `src/extension.ts`; esbuild bundles to `dist/extension.js` (the manifest `main`). Nothing builds from `tsconfig.json`: `check-types` passes `--noEmit`, and esbuild produces every shipped file.
- Purpose: scan local VS Code/Copilot debug logs, count rows with positive AI Credits, and show token/cost results in the status bar plus a "Copilot Sessions" tree (view `copilotUsage.views.usage`) in its own Activity Bar container (`copilotUsage`). The tree leads with an AI Credit quota row read from GitHub, the one row not derived from the logs.
- Privacy constraint: keep work local. Do not add telemetry, and add no network access beyond the one request the user asked for: the AI Credit quota row reads `copilot_internal/user` under the rules below. Nothing about the user's logs or usage leaves the machine. The account the row follows comes from Copilot Chat's own log in the window (`copilotAccount.ts`); only the login is read from it.

## Commands

- Install dependencies: `npm install`
- Typecheck only: `npm run check-types`
- Compile (typecheck + bundle): `npm run compile`
- Production bundle: `npm run compile:production`, which is what `vscode:prepublish` runs, so packaging always rebuilds
- Rebuild on change: `npm run watch`, which bundles only, so run `npm run check-types` beside it
- Delete build output: `npm run clean`
- Run tests: `npm test`
- Package VSIX: `npm run package`
- Build, install into VS Code, and open a new window: `npm run install:local`. Windows already open keep the old build until reloaded (Developer: Reload Window), and no new window opens when the folder is already open.

Run `npm run compile` and relevant `npm test` coverage before claiming code changes are ready. Docs-only changes do not need tests.

## Code Map

- `src/extension.ts`: activation, commands, status bar, file system watchers, VS Code wiring.
- `src/ui/usageTreeProvider.ts`: builds the "Copilot Sessions" rows: the AI Credit quota row, the date buckets, a "Scan failed" row when a scan throws, and the setup row that stands in for the welcome view once the quota row has filled the tree. Also owns `formatDiagnostics`, the text the Show Scan Diagnostics command prints.
- `src/ui/formatters.ts`: token and cost display formatting shared by the status bar and tree.
- `src/core/config.ts`: reads `copilotUsage.*` settings and checks the `github.copilot.chat.agentDebugLog.fileLogging.enabled` prerequisite.
- `src/core/usageIndex.ts`: caches scanned usage records and handles incremental rebuilds.
- `src/core/locator.ts`: finds VS Code Stable/Insiders storage roots plus optional configured path.
- `src/core/scanner.ts`: recursively scans only `.json` and `.jsonl`, respecting max size and depth.
- `src/core/parser.ts`: parses JSON arrays, known container keys, single JSON records, and JSONL lines.
- `src/core/normalizer.ts`: converts Copilot debug `llm_request` rows with positive `copilotUsageNanoAiu` into `UsageRecord`; metadata-only title records can still label counted chats. A chat is identified by its `debug-logs/<sessionId>/` folder, not by the `sid` in the row, so a subagent run bills to its parent chat instead of becoming its own session. Title runs are read in metadata mode, so they label a chat but never add to a total.
- `src/core/quota.ts`: the only network call in the extension. Issues the `copilot_internal/user` request with `Authorization`, `X-GitHub-Api-Version` and `Accept` only, reads the premium snapshot the way Copilot Chat does, maps each response status to a result kind, and formats the tree label.
- `src/core/quotaService.ts`: reads the quota through the `github` auth provider for the account Copilot Chat reports, debounced and rate-limited. GitHub Enterprise Server is not supported; the endpoint lives on api.github.com.
- `src/core/copilotAccount.ts`: watches Copilot Chat's log for this window (beside `context.logUri`) for `Logged in as <login>`, the only place VS Code exposes which account another extension uses, and tells the quota service when it changes.
- `src/core/aggregator.ts`: builds today/week/month/all-time totals, per-chat summaries, the top three models, and today's highest-token and most-expensive sessions, all from positive-AI-Credit usage records.
- Shared types and the `TITLE_PRIORITY` ladder live in `src/core/types.ts`; tests and fixtures live in `test/`.

## Change Guidance

- Prefer small changes in the relevant core module instead of broad refactors.
- Preserve strict TypeScript and CommonJS extension target from `tsconfig.json`.
- Add or update focused Vitest tests for parser, scanner, normalizer, aggregation, or service changes.
- Keep filesystem scanning bounded and tolerant of unreadable or malformed files; diagnostics should explain skipped work instead of crashing refresh.
- A child run inside a session folder must never label the chat. Its records carry `TITLE_PRIORITY.childRun`, which loses to the chat's own generic name even though the child log is written later.
- Keep `copilotUsageNanoAiu` as the usage gate. Do not count token-only rows, missing-AI-Credit rows, or zero-credit rows.
- The JSONL resume offset must come from the bytes the parser actually read (`ParseUsageFileResult.consumedBytes`), never from a `stat` taken before the read, or live logs get counted twice.
- Background quota reads stay behind the settle delay and the one-minute floor in `quotaService.ts`, with backoff on failure. The endpoint spends the account's shared hourly REST budget, so a burst of chats must not become a burst of quota calls. A Copilot account switch is the one background read that skips the floor.
- Quota requests must stay silent: `getSession` with an empty scope list and `silent: true`, with `account` set to the login `copilotAccount.ts` reports so the row follows Copilot. Only `copilotUsage.connectQuota`, which is a user gesture, may pass `createIfNone`; when the login is unknown it pairs it with `clearSessionPreference` so VS Code shows its account picker instead. Never pass `forceNewSession`: it forces a fresh sign-in even when the existing session is fine, and any session this extension creates itself carries no scopes. Reuse the sessions Copilot already holds, which the picker does.
- Do not treat token totals as exact billing in UI text or docs; AI Credits are the billing source.
