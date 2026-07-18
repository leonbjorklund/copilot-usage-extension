# Copilot Usage Extension Agent Notes

## Project Shape

- VS Code extension in TypeScript. Entry point: `src/extension.ts`; esbuild bundles to `dist/extension.js` (the manifest `main`). `tsconfig.json` only typechecks — it never emits.
- Purpose: scan local VS Code/Copilot debug logs, count rows with positive AI Credits, and show token/cost results in the status bar plus a "Copilot Sessions" tree in its own Activity Bar container (`copilotUsage.views.usage`).
- Privacy constraint: keep work local. Do not add telemetry or network access unless the user explicitly asks.

## Commands

- Install dependencies: `npm install`
- Typecheck only: `npm run check-types`
- Compile (typecheck + bundle): `npm run compile`
- Rebuild on change: `npm run watch`
- Run tests: `npm test`
- Package VSIX: `npm run package`
- Build, install into VS Code, and open a new window: `npm run install:local`

Run `npm run compile` and relevant `npm test` coverage before claiming code changes are ready. Docs-only changes do not need tests.

## Code Map

- `src/extension.ts`: activation, commands, status bar, file system watchers, VS Code wiring.
- `src/ui/usageTreeProvider.ts`: Explorer tree rendering and diagnostics formatting.
- `src/ui/formatters.ts`: token/cost/date display formatting shared by the status bar and tree.
- `src/core/config.ts`: reads `copilotUsage.*` settings and checks the `github.copilot.chat.agentDebugLog.fileLogging.enabled` prerequisite.
- `src/core/usageIndex.ts`: caches scanned usage records and handles incremental rebuilds.
- `src/core/locator.ts`: finds VS Code Stable/Insiders storage roots plus optional configured path.
- `src/core/scanner.ts`: recursively scans only `.json` and `.jsonl`, respecting max size and depth.
- `src/core/parser.ts`: parses JSON arrays, known container keys, single JSON records, and JSONL lines.
- `src/core/normalizer.ts`: converts Copilot debug `llm_request` rows with positive `copilotUsageNanoAiu` into `UsageRecord`; metadata-only title records can still label counted chats.
- `src/core/aggregator.ts`: builds today/month/all-time totals and per-chat summaries from positive-AI-Credit usage records.
- Shared types live in `src/core/types.ts`; tests and fixtures live in `test/`.

## Change Guidance

- Prefer small changes in the relevant core module instead of broad refactors.
- Preserve strict TypeScript and CommonJS extension target from `tsconfig.json`.
- Add or update focused Vitest tests for parser, scanner, normalizer, aggregation, or service changes.
- Keep filesystem scanning bounded and tolerant of unreadable or malformed files; diagnostics should explain skipped work instead of crashing refresh.
- Keep `copilotUsageNanoAiu` as the usage gate. Do not count token-only rows, missing-AI-Credit rows, or zero-credit rows.
- Do not treat token totals as exact billing in UI text or docs; AI Credits are the billing source.
