# Account tracking

Accepted attribution and storage behavior. See [AGENTS.md](../../AGENTS.md) for development commands and quota authentication rules, and [account attribution research](ACCOUNT-ATTRIBUTION-RESEARCH.md) for correlation evidence and limitations.

## Attribution and storage

- `src/dev/accountUsagePoc.ts` owns forward-only attribution. Its ledger lives in `context.globalStorageUri/account-poc`; each process appends its own observer journal. Preserve existing journals and `start.json`. Clearing them loses saved observations and resets the tracking boundary.
- A billed request needs a unique window match and successful authentication evidence for account attribution. Requests around account switches and chats that predate a switch remain saved but are excluded from account-specific totals when ownership is uncertain. A delayed session header can recover attribution later. Historical usage before the saved start time stays in the ordinary display from available local logs, without account labels or assignment to an account. The historical records do not enter the account ledger.
- When this window's account is known, display historical usage plus its confirmed newer requests. When the account is unknown, display historical usage plus all saved newer requests across accounts, including unresolved requests. Keep uncertainty and exclusion details in diagnostics, with no waiting banner, switch warning, or instruction to start a new chat. GitHub quota permission never gates local usage. Window-log read failures retain confirmed usage beside an error; account-storage failures fall back to the successful local scan beside an error. Preserve journals and the tracking boundary on failure.
- After successful sign-in evidence arrives, polling displays that account's saved usage without waiting for quota. Attribution searches retained Stable and Insiders window logs on Windows, macOS, and Linux. Status-bar percentage and the quota row show spending against the matching account's GitHub allowance; the percentage requires a current UTC calendar-month reset date.
- Quota consent markers are separate from usage journals and the tracking boundary. Resetting consent must preserve usage storage.
- The ledger reader stops with an error above 256 observer journals or 32 MiB per file; log discovery stops above 512 window folders. Automatic compaction is not implemented. Preserve data if these limits are reached; do not reset or delete journals as recovery.

## Delayed titles

Title updates append to existing observer journals while preserving saved request identity, billing, and attribution evidence. Retained chats can receive surviving title metadata after their billed debug logs disappear. Source priority and revision order survive restart. Legacy descriptive labels without saved source priority are kept until matching metadata establishes their priority or a custom rename supplies an explicit replacement.

## Remaining native checks

Before publication, complete these checks in the normal-profile development preview. Automated tests do not establish native behavior or live billing correctness. Native macOS/Linux hosts remain untested.

1. With accounts A and B already signed in, keep one window on A. In another window, run `Accounts: Manage Extension Account Preferences`, select Copilot Chat, switch to B, and start a new chat. Pass: each window shows its matching quota and confirmed newer usage plus shared historical usage. Fail: a request confirmed for B appears in A's newer usage, or either quota follows the wrong account. Requests around a switch or in an older resumed chat must remain excluded in Show Scan Diagnostics.
2. Rename a tracked chat twice, then run `Developer: Reload Window` without sending requests. Pass: the latest title survives and totals remain unchanged. Fail: an older title returns or usage duplicates.
3. Run `View: Focus Status Bar`, select the usage item with arrow keys, and press `Ctrl+K Ctrl+I`. Pass: totals, titles, and the billing link remain readable and keyboard accessible, including with a screen reader. Fail: information or link access requires a mouse.

### Consent cancellation and reload

First-message consent and percentage loading after Allow have been confirmed manually. Cancellation and reload still need the following check.

1. Run `Accounts: Manage Trusted Extensions For Account`, select the account Copilot uses, uncheck `Copilot Token Cost`, and confirm. This revokes only this extension's access, not Copilot's sign-in.
2. If this account has already received the automatic offer, close its preview windows, back up and remove only its marker under `context.globalStorageUri/quota-consent`. The filename is the SHA-256 hex digest of the lowercase GitHub login. Preserve `account-poc`, all journals, and `start.json`. Reinstalling or revoking GitHub permission alone does not clear this marker.
3. Open the preview, leave the credits row alone, and send a new Copilot Chat message. Pass: no startup dialog; one GitHub access dialog appears after the successful panel request; choosing Allow loads the matching account's percentage. Fail: no dialog, duplicate dialogs, or another account's quota.
4. On a separate reset test, dismiss the dialog, reload, and send another message. Pass: no repeat dialog, and clicking the credits row still allows manual access.
