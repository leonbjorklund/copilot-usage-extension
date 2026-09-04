## GitHub Copilot Tokens and AI Credit Cost

Lightweight Copilot usage viewer for token count and AI credit cost from Copilot log files. Token counts and cost need `github.copilot.chat.agentDebugLog.fileLogging.enabled`. The AI Credit quota row works without it.

Log reading is entirely local and no usage data leaves your machine. The only endpoint the extension contacts is your own AI Credit quota at GitHub, read through the GitHub account VS Code is already signed in to. Click the top row of the tree to grant access once; until you do, no request is made. After that the row re-reads on startup and shortly after Copilot bills new credits, at most once a minute. That endpoint is the unofficial one Copilot Chat itself uses, so the row can stop reporting if GitHub changes it; nothing else in the extension depends on it.

The quota row shows credits left, the credits included in your plan, and the percentage remaining. Its tooltip adds the account, credits used, the reset date, and any overage. An account with no Copilot subscription gets no row.

Dollar amounts use GitHub's [Copilot usage-based billing docs](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals): 1 AI Credit = $0.01 USD. They are not final billed cost and exclude plans, pooled credits, discounts, taxes, and adjustments.

> Only sessions with AI Credits are counted. Older logs that predate usage-based billing are ignored.

#### Status Bar

<img src="https://github.com/leonbjorklund/copilot-usage-extension/raw/main/docs/statusbar-tooltip.png?v=2" width="400" alt="Status bar tooltip" />

#### Tree View

<img src="https://github.com/leonbjorklund/copilot-usage-extension/raw/main/docs/activity-bar-treeview.png?v=2" width="400" alt="Usage tree view" />

## Reference

Commands:

- `Copilot Token Cost: Refresh` — re-scans log files and updates totals
- `Copilot Token Cost: Show Scan Diagnostics` — shows details about skipped or unreadable files
- `Copilot Token Cost: Show AI Credit Quota` — grants access to your existing GitHub session so the quota row can read your remaining AI Credits. Clicking the quota row does the same thing
- `Open Source Log` — opens the log file a session was read from, or offers a list when there is more than one (right-click a session row; it is not in the Command Palette)
- `Sort Sessions by Cost` — orders the session list by AI Credit cost
- `Sort Sessions by Time` — orders the session list by most recent

The two sort commands are also an icon in the view title bar, showing whichever order you are not using. The choice persists across windows.

Settings:

- `copilotUsage.dataPath` — extra local folder to scan for Copilot usage data (absolute path). Ignored in workspaces you have not trusted
