# Copilot Credits

VS Code extension showing the signed-in account's Copilot credit use in a status bar item and its hover. Accurate credit spend and accurate account usage matter above all. Entry point: `src/extension.ts`, bundled by esbuild to `dist/extension.js`. The rebuild follows `docs/plan.md` until its last phase deletes it.

## How to work

- **Fresh approach, audited details.** Decide each approach from the real logs on this machine, Copilot Chat's bundled source and the VS Code API, and re-check the facts below before relying on them. The old implementation stays on `main` (`git show main:<path>`): use it as an audit source for user-visible details and hard-won fixes, never as a base. Carry over each detail that fits the design, and report any you drop with the reason.
- **Normal path first.** Several open windows, restarts, account switches and a new month must simply work. Anything rarer gets a sane fallback: a briefly wrong or missing value that the next update corrects is fine. Guard only against values that would stay wrong, and against crashes.
- **Lean code.** Use the fewest files and plain functions that stay correct. Add a class, cache, layer or abstraction only when VS Code requires it or a measurement shows the need.
- **Local only.** Read files on this machine. No network, no GitHub sign-in, no telemetry.
- **Decide plumbing, ask about looks.** State the approach in 2-3 lines before coding. Decide robustness and internals yourself. Ask Leon before changing anything he sees that the design does not settle.
- **Tests that bite.** Write focused tests for parsing and math: quota lines, the account, today and daily values, the model tally, number formatting. Break the code under each new test once and confirm the test fails.
- **Finish the change.** Run `npm run compile`, `npm test` and `npm run package`, and confirm `npx vsce ls` lists only shipped files. Have a subagent review the diff. Then give Leon `npm run install:local` and the checks. Commit only when Leon asks.

## Facts

Checked on 2026-09-23 against VS Code 1.139 and its built-in Copilot Chat 0.67. Re-check each fact you rely on.

- **Output log:** `%APPDATA%\Code\logs\<session>\window<N>\exthost\GitHub.copilot-chat\GitHub Copilot Chat.log`, beside a separate `GitHub Copilot Chat Hooks.log`. Lines read `2026-09-23 10:04:50.301 [trace] message` in local time with CRLF endings, and multi-line messages continue without that prefix. A window reload keeps `window<N>` and appends to the same file.
- **Rotation:** at 5 MB the log is renamed to `.1.log`, up to `.6.log`. When the rename fails, as it did on this machine, the file is emptied in place, so a log can shrink at any moment and lose its first lines, account line included.
- **Short-lived sessions:** VS Code keeps the current log session plus the 9 newest and deletes the rest 10 seconds after each start. Every `code` command-line call, `npm run preview` included, adds a session folder.
- **Quota lines** appear only at Trace: `[ChatQuota] processQuotaHeaders` on every HTTP chat response, `processUserInfoQuotaSnapshot` after each new Copilot token, and `processQuotaSnapshots` on WebSocket turns. Each carries flat JSON with `quota`, `percentRemaining`, `additionalUsageUsed`, `resetDate`, `unlimited` and `hasQuota`, in varying key order. `percentRemaining` has one decimal and lags: it stays flat through dozens of requests, then drops several tenths at once. Without a server reset date, Copilot invents one a month ahead.
- **Account line:** `[info] Got Copilot token for <login>` comes before the quota snapshot of that token. It appears at window start and when a new token is fetched, so a long-running window logs hours of readings after one account line. Anonymous access logs the literal word `devDeviceId`. Enterprise managed logins contain `_`.
- **Trace:** `workbench.action.setDefaultLogLevel` with `(1, 'github.copilot-chat')` saves the default in argv.json. It switches only the calling window's existing Copilot Chat channel, and only while that channel sits at the previous default. Other open windows, reloads and windows opened from inside VS Code keep their startup level until VS Code is quit and reopened. A window opened with the `code` command reads argv.json afresh. No Copilot setting controls its log level.
- **GPT models are missing from the output log:** their Responses API requests write no request or cost lines there. The debug logs have them, and the quota still counts their spend.
- **Units match:** the quota's unit matched the debug-log credits.
- **Debug logs:** `%APPDATA%\Code\User\workspaceStorage\<id>\GitHub.copilot-chat\debug-logs\`, or `globalStorage\github.copilot-chat\debug-logs\` for windows with no folder open. Copilot keeps 50 chats per folder and trims files over 100 MB to their newest 60 MB. They name no account. The debug log setting takes effect after a window reload.
- **Request costs:** most `llm_request` lines carry a positive `copilotUsageNanoAiu`. Free models log 0, and failed requests omit the field. `spanId` repeats across a resumed chat.
- **Status bar:** Copilot's own item is anchored right of the language mode (priority 100.1); priority 100.05 lands directly right of it.
- **Hover limits:** the hover keeps tables, `img` tags with `data:` URIs and `width`/`height`/`title`, and `span` color styles. It stays open under the mouse only while it contains a link. Reassigning `statusBar.tooltip` redraws an open hover, so assign it only when the markdown changed.
- **Copilot Chat's source** ships with VS Code at `resources\app\extensions\copilot\dist\extension.js` under the install folder.
