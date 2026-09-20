## GitHub Copilot Tokens and AI Credit Cost

Lightweight Copilot usage viewer for token count and AI credit cost from Copilot log files. Runs locally. Shows monthly credit use and estimated monthly pace. Requires `github.copilot.chat.agentDebugLog.fileLogging.enabled`.

Dollar amounts are estimates using [GitHub's rate](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals) of $0.01 USD per AI Credit.

#### Status Bar

<img src="https://github.com/leonbjorklund/copilot-usage-extension/raw/main/docs/statusbar-tooltip.png?v=3" width="400" alt="Status bar tooltip" />

#### Tree View

<img src="https://github.com/leonbjorklund/copilot-usage-extension/raw/main/docs/activity-bar-treeview.png?v=3" width="400" alt="Usage tree view" />

## Install from source

Requires Node.js, npm, and VS Code 1.120 or newer. Make sure `code`, `code-insiders`, or both are on PATH.

```sh
npm ci
npm run install:local
```

The installer runs tests and builds one VSIX, then installs it into every detected editor and opens a new window in each. If one editor fails, it still tries the other and reports failure. Existing windows may need `Developer: Reload Window` to load the updated extension.

## Reference

Commands:

- `Copilot Token Cost: Refresh` — re-scans log files and updates totals
- `Copilot Token Cost: Show Scan Diagnostics` — shows details about skipped or unreadable files
- `Open Source Log` — opens the log file a session was read from
- `Sort Sessions by Cost` — orders the session list by AI Credit cost
- `Sort Sessions by Time` — orders the session list by most recent

Settings:

- `copilotUsage.dataPath` — extra local folder to scan for Copilot usage data (absolute path)
