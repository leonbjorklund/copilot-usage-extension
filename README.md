## GitHub Copilot Tokens and AI Credit Cost

Local Copilot token usage and estimated AI Credit cost from Copilot logs. Requires `github.copilot.chat.agentDebugLog.fileLogging.enabled`. The separate quota row reads account spending and allowance from GitHub.

Dollar amounts use GitHub's [Copilot usage-based billing docs](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals): 1 AI Credit = $0.01 USD. They are not final billed cost and exclude plans, pooled credits, discounts, taxes, and adjustments.

> Only sessions with AI Credits are counted. Older logs that predate usage-based billing are ignored.

Historical sessions remain in the usual display. New usage follows the Copilot account in each window; when the account is unavailable, the extension shows combined local usage. Token and estimated USD totals work without granting GitHub access. Only the quota row and status percentage need that permission.

When permission is needed, the first new successful Copilot Chat request offers access for the matching signed-in account. Dismissing the dialog prevents further automatic offers for that account, including after reload. Click the quota row to retry manually.

Requests whose account is uncertain remain saved locally and are retried without account warnings in the usage display. Show Scan Diagnostics contains the attribution details. Account attribution uses Copilot Chat logs at Info or Trace level.

## Usage display

- The status bar shows today's tokens and estimated cost, or "No sessions today". With quota access, it also shows the percentage spent in the current billing month.
- Hover for today, month, and all-time totals, top models, and top sessions today.
- Click to open Copilot Sessions. The quota row shows spent credits against the allowance. Chats are grouped by their latest request date into Today, Yesterday, and Older.

## Reference

Commands:

- `Copilot Token Cost: Refresh` — re-scans log files and updates totals
- `Copilot Token Cost: Show Scan Diagnostics` — shows details about skipped or unreadable files
- `Copilot Token Cost: Show AI Credit Quota` — grants access to the matching GitHub account or refreshes its quota
- `Open Source Log` — opens the log file a session was read from
- `Sort Sessions by Cost` — orders the session list by AI Credit cost
- `Sort Sessions by Time` — orders the session list by most recent

Settings:

- `copilotUsage.dataPath` — extra local folder to scan for Copilot usage data (absolute path)
