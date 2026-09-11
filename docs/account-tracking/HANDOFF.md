# Account tracking handoff

This release contains account-specific AI Credit tracking and its regression fixes. Run `npm run preview` for an Extension Development Host using the normal VS Code profile, real logs, and live quota.

Before publication, finish native account-switching, delayed-title, and consent cancellation/reload checks in the development host. The owner confirmed first-message consent and percentage loading after Allow on 2026-09-11. Successful automated tests do not establish the remaining native behavior or live billing correctness.

## Account tracking

- `src/dev/accountUsagePoc.ts` owns forward-only attribution. Its ledger lives in `context.globalStorageUri/account-poc`; each process appends its own observer journal. Preserve existing journals and `start.json`. Clearing them loses saved observations and resets the tracking boundary.
- A billed request needs a unique window match and successful authentication evidence. Requests around account switches and chats that predate a switch are excluded. A delayed session header can recover attribution later. Historical usage before the saved start time is never assigned to the current account.
- Confirmed usage stays visible when other requests cannot be attributed. Unresolved records remain in diagnostics and are retried; they do not create a permanent waiting banner. Unknown current account identity shows a waiting state. Window-log read failures show an error while available confirmed usage remains visible.
- After successful sign-in evidence arrives, polling displays that account's saved usage without waiting for quota. Status-bar percentage and the quota row use the matching account's live GitHub balance.
- When quota access needs permission, the first new successful panel chat request in this window triggers the GitHub access dialog for the matching signed-in account. Startup history and title-generation requests do not trigger it. An exclusive per-account marker in `context.globalStorageUri/quota-consent` remembers the offer across windows and reloads, including cancellation. The quota row remains available for a manual retry. This marker is separate from usage journals and the tracking boundary.
- The ledger reader stops with an error above 256 observer journals or 32 MiB per file; log discovery stops above 512 window folders. Automatic compaction is not implemented. Preserve data if these limits are reached; do not reset or delete journals as recovery.
- [Account attribution research](ACCOUNT-ATTRIBUTION-RESEARCH.md) records the original source investigation and correlation limitations. This handoff describes the accepted implementation.

## Delayed titles

Title updates append to existing observer journals while preserving saved request identity, billing, and attribution evidence. Retained chats can receive surviving title metadata after their billed debug logs disappear. Source priority and revision order survive restart. Legacy descriptive labels without saved source priority are kept until matching metadata establishes their priority or a custom rename supplies an explicit replacement.

## First-message consent check

Automated coverage verifies approval, cancellation, concurrent windows, restart, account changes, and startup-history exclusion. Use these steps to repeat the consent check in the normal-profile preview.

1. Run `Accounts: Manage Trusted Extensions For Account`, select the account Copilot uses, uncheck `Copilot Token Cost`, and confirm. This revokes only this extension's access, not Copilot's sign-in.
2. If this account has already received the automatic offer, close its preview windows, back up and remove only its marker under `context.globalStorageUri/quota-consent`. The filename is the SHA-256 hex digest of the lowercase GitHub login. Preserve `account-poc`, all journals, and `start.json`. Reinstalling or revoking GitHub permission alone does not clear this marker.
3. Open the preview, leave the credits row alone, and send a new Copilot Chat message. Pass: no startup dialog; one GitHub access dialog appears after the successful panel request; choosing Allow loads the matching account's percentage. Fail: no dialog, duplicate dialogs, or another account's quota.
4. On a separate reset test, dismiss the dialog, reload, and send another message. Pass: no repeat dialog, and clicking the credits row still allows manual access.
