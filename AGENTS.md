# Copilot Token Cost

Local TypeScript VS Code extension. Entry point: `src/extension.ts`; esbuild output: `dist/extension.js`.

## Development

- Use scripts in `package.json`. After code changes, run `npm run compile`, relevant tests, and `npm run preview`. Docs-only changes need no build or tests.
- Preview and F5 use real usage data and sign-ins. Keep their test gates; use temporary log fixtures for account transitions. Live account switching belongs to the user. Never run old authenticated quota builds against this profile or edit authentication storage.
- Keep changes localized and preserve strict TypeScript and CommonJS. Add focused regression tests for behavior changes.
- If a design rule causes incorrect behavior, present the evidence, proposed change, and drawbacks, then ask before changing the rule or affected behavior.

## Project safeguards

- Keep usage local. Read quota from Copilot's output log; no telemetry, GitHub session requests, authenticated quota fetches, or credential extraction.
- Count only positive `copilotUsageNanoAiu`. Tokens are not billing; USD is an estimate. Child runs bill to the parent session but never name it. Title records supply metadata only.
- Assign requests to accounts only with a unique window match and successful authentication evidence. Leave historical and uncertain usage unassigned. Local usage must work without quota.
- Preserve `globalStorageUri/account-tracking/start.json` and recorded usage. Shared ledgers and `quota-history.jsonl` are append-only; never truncate, rewrite, or reset them for recovery. Use temporary copies for destructive tests.
- Preserve concurrent append retries, atomic snapshot publication, and validation before retiring ledgers. Frozen account decisions are permanent. Before changing attribution, log-loss handling, or rollover, read `src/core/accountTracking.ts` and `test/accountTracking.test.ts`.
- Keep scans bounded and tolerate unreadable files. Resume JSONL reads from `consumedBytes`, not a pre-read file size. Title updates must preserve request identity and billing.
- Named quota requires successful account evidence in this window. Lost evidence must not retain an owner or add account history. Before changing quota continuity or account transitions, read `src/core/quotaService.ts` and `test/quotaService.test.ts`.
- Keep the last server-reported percentage without time-based expiry and preserve its precision. Do not reconstruct exact spent credits or guess daily usage across unobserved gaps.
- Keep Copilot Chat's Trace default enabled across reloads and shutdown. Preserve other logging settings, explicit channel overrides, sign-ins, and other extensions' approvals.
- VS Code sanitizes tooltip HTML. Keep graph rendering compatible and assign the tooltip only when its markdown changes to avoid redrawing an open hover.
