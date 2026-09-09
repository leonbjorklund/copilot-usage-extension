# Account tracking handoff

This release contains account-specific AI Credit tracking and its regression fixes. Run `npm run preview` for an Extension Development Host using the normal VS Code profile, real logs, and live quota.

Before publication, verify account switching and delayed chat-title updates in the development host. Successful automated tests do not establish native behavior or live billing correctness.

## Account tracking

- `src/dev/accountUsagePoc.ts` owns forward-only attribution. Its ledger lives in `context.globalStorageUri/account-poc`; each process appends its own observer journal. Preserve existing journals and `start.json`. Clearing them loses saved observations and resets the tracking boundary.
- A billed request needs a unique window match and successful authentication evidence. Requests around account switches and chats that predate a switch are excluded. A delayed session header can recover attribution later. Historical usage before the saved start time is never assigned to the current account.
- Confirmed usage stays visible when other requests cannot be attributed. Unresolved records remain in diagnostics and are retried; they do not create a permanent waiting banner. Unknown current account identity shows a waiting state. Window-log read failures show an error while available confirmed usage remains visible.
- After successful sign-in evidence arrives, polling displays that account's saved usage without waiting for quota. Status-bar percentage and the quota row use the matching account's live GitHub balance.
- The ledger reader stops with an error above 256 observer journals or 32 MiB per file; log discovery stops above 512 window folders. Automatic compaction is not implemented. Preserve data if these limits are reached; do not reset or delete journals as recovery.
- [Account attribution research](ACCOUNT-ATTRIBUTION-RESEARCH.md) records the original source investigation and correlation limitations. This handoff describes the accepted implementation.

## Delayed titles

Title updates append to existing observer journals while preserving saved request identity, billing, and attribution evidence. Retained chats can receive surviving title metadata after their billed debug logs disappear. Source priority and revision order survive restart. Legacy descriptive labels without saved source priority are kept until matching metadata establishes their priority or a custom rename supplies an explicit replacement.
