# Copilot Token Cost

VS Code extension. Entry point: `src/extension.ts`; esbuild ships `dist/extension.js`. Account tracking in `src/dev/accountUsagePoc.ts` runs in production despite its name.

## Development

- After code changes, run `npm run compile`, relevant `npm test` coverage, and `npm run preview`. Preview uses the normal VS Code profile and real usage data. Docs-only changes need no build or tests.
- Other commands live in `package.json`. `watch` bundles without typechecking; installed builds require existing VS Code windows to reload.

## Rules

- Keep usage local. No telemetry or network access beyond the GitHub quota request to `copilot_internal/user`.
- Count only positive `copilotUsageNanoAiu`. Tokens are not billing; displayed USD is an estimate. Child runs bill to their parent session folder but never name the chat. Title-generation records supply metadata only.
- Attribute newer requests only with a unique window match and successful authentication evidence. Preserve uncertain requests without assigning an account. Historical usage stays unassigned. Local usage must work without quota permission.
- Preserve `globalStorageUri/account-poc`, observer journals, and `start.json`. Never reset them to recover from errors or limits. Use temporary copies for destructive tests; consent resets must preserve usage and Copilot sign-in.
- Keep scans bounded and tolerate unreadable files. Resume JSONL reads from `consumedBytes`, not a pre-read file size. Preserve saved request identity and billing when updating titles.
- Quota requests follow this window's Copilot account. Preserve the settle delay, one-minute floor, and failure backoff. An account switch may skip the floor, but not an explicit rate limit.
- Reuse GitHub sessions with empty scopes and `silent: true`. Interactive consent is allowed only for the manual quota command or once per account after a new successful panel request. Preserve the exclusive `quota-consent` claim across cancellation, reloads, and windows. Only the manual command may use `clearSessionPreference` for an unknown account. Never use `forceNewSession`.
