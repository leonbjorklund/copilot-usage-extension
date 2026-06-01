## GitHub Copilot Tokens and AI Credit Cost

Lightweight Copilot usage viewer for token count and AI credit cost from Copilot log files. Runs locally. Requires `github.copilot.chat.agentDebugLog.fileLogging.enabled`.

Dollar amounts use GitHub's [Copilot usage-based billing docs](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals): 1 AI Credit = $0.01 USD. They are not final billed cost and exclude plans, pooled credits, discounts, taxes, and adjustments.

> Only sessions with AI Credits are counted. Older logs that predate usage-based billing are ignored.

#### Status Bar

<img src="https://github.com/leonbjorklund/copilot-usage-extension/raw/main/docs/statusbar-tooltip.png?v=2" width="400" alt="Status bar tooltip" />

#### Tree View

<img src="https://github.com/leonbjorklund/copilot-usage-extension/raw/main/docs/activity-bar-treeview.png?v=2" width="400" alt="Usage tree view" />

## Reference

- `Copilot Token Cost: Refresh` — re-scans log files and updates totals
- `Copilot Token Cost: Show Scan Diagnostics` — shows details about skipped or unreadable files
- `copilotUsage.dataPath` — extra local folder to scan for Copilot usage data (absolute path)

## Feedback

[Open an issue on GitHub](https://github.com/leonbjorklund/copilot-usage-extension/issues)
