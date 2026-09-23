# Copilot Credits rebuild

This plan turns the extension into Copilot Credits: a status bar item and its hover showing the signed-in account's Copilot credit use. Two things matter above all: accurate credit spend and accurate account usage. Run one phase per session with `Implement phase N of docs/plan.md.` Every phase ends with an extension Leon can install and check.

## How to work

- **Fresh approach, audited details.** Decide each approach fresh from the real logs on this machine, Copilot Chat's bundled source and the VS Code API, and re-check the facts below before relying on them. Use the old implementation as an audit source, not as a base. Before rebuilding a piece, read its old code and list its user-visible details and hard-won fixes: formats, styling, theme colors, hover behavior. The old code stays on `main`, so use `git show main:<path>` once it is deleted here. Carry over each detail that fits the design, and report any you drop with the reason.
- **Normal path first.** Several open windows, restarts, account switches and a new month must simply work. Anything rarer gets a sane fallback: a briefly wrong or missing value that the next update corrects is fine. Guard only against values that would stay wrong, and against crashes.
- **Lean code.** Use the fewest files and plain functions that stay correct. Add a class, cache, layer or abstraction only when VS Code requires it or a measurement shows the need.
- **Local only.** Read files on this machine. No network, no GitHub sign-in, no telemetry.
- **Decide plumbing, ask about looks.** State the approach in 2-3 lines before coding. Decide robustness and internals yourself. Ask Leon before changing anything he sees that the design below does not settle.
- **Tests that bite.** Write focused tests for parsing and math: quota lines, the account, today and daily values, the model tally, number formatting. Break the code under each new test once and confirm the test fails.
- **Finish the phase.** Run `npm run compile`, `npm test` and `npm run package`, and confirm `npx vsce ls` lists only shipped files. Have a subagent review the diff. Then give Leon `npm run install:local` and the phase's checks. Work on the `credits-rebuild` branch and commit only when Leon asks.
- **Stay in your phase.** A phase is done when its "Done when" list holds.

## Design

### Status bar

- Text: `3.1% • 76.5/100%`, meaning today's share of the monthly allowance, then the month used out of 100%. Past the allowance: `3.1% • 100/103.2%`.
- No icon and no words. Clicking does nothing.
- At startup it shows the last saved numbers at once, then updates when Copilot reports. With nothing saved yet (a fresh install) it shows `Waiting for Copilot`.
- It sits on the right, next to Copilot's own status bar icon.

### Hover

```
Today: 3.1%  (2 480)                                   leon-work  (i)
---------------------------------------------------------------------
Month: 76.5% / 100%  (61 200 / 80 000 credits)     100.9% monthly pace
[30 daily bars]
25 Aug                                                          23 Sep
---------------------------------------------------------------------
Model use this month
1. claude-opus-5.5                                  131 sessions · 94%
2. gpt-6-luna                                        12 sessions · 3%
3. gpt-5.6-luna                                       7 sessions · 2%
```

- **Today:** bold label, today's share, two spaces, today's credits in brackets. On the right, the signed-in account in the description color, then the info link.
- **Month:** bold label, then the original format `76.5% / 100%  (61 200 / 80 000 credits)`. Past the allowance: `100% / 103.2%  (80 000 / 82 560 credits)`. On the right, `100.9% monthly pace`: the share used by the reset if the average daily use so far continues.
- **Graph:** the signed-in account's daily use over the last 30 days. Bars for the current month are bright and earlier ones dim, with the first and last date underneath. Each bar's hover text reads `23 Sep · 3.1%`.
- **Model use this month:** the top 3 models by credits this month, across every account. `N sessions` counts the chats that used the model this month; the share is its part of all credits recorded this month. The section stays hidden until something is recorded.
- **Numbers:** a non-breaking space separates thousands (`61 200`). Percentages show at most one decimal and drop a trailing zero (`76%`, not `76.0%`).
- **Unlimited or zero-allowance accounts:** pick a sane fallback. The old labels were "Unlimited Copilot quota" and "No Copilot credit allowance".

### Data

Quota, for everything except Model use:

- Copilot Chat writes `[ChatQuota]` lines to its output log at Trace level: `processQuotaHeaders` on every HTTP chat response, `processUserInfoQuotaSnapshot` on each new Copilot token, and `processQuotaSnapshots` on WebSocket turns. Each carries JSON with `quota` (the allowance), `percentRemaining`, `additionalUsageUsed` (spend past the allowance), `resetDate`, `unlimited` and `hasQuota`.
- The lines name no account. A reading belongs to the account in the latest `Got Copilot token for <login>` line of the same log. When that log has none, use the last account seen in any window, then the last saved one.
- Every window reads every window's Copilot log from the running VS Code session, so all windows show the newest reading.
- Keep a small saved record per account: its latest reading plus the last reading of each day for about 35 days. Today is the latest reading minus the account's last reading before local midnight. A day's bar is that day's last reading minus the previous day's. Across a monthly reset, count from zero.

Model use:

- Source: Copilot's debug logs, `llm_request` events with `attrs.model`, `attrs.copilotUsageNanoAiu` (credits = value / 1e9) and `ts`. A chat is one `debug-logs/<sessionId>/` folder, and every file in it counts for that chat, subagent logs included.
- Copilot deletes old chats and trims large logs, so keep a monthly tally of credits and chats per model that holds on to what was seen. Reading a chat again must leave its count unchanged.

Setup and old data:

- At startup, silently set Copilot Chat's log level to Trace and `github.copilot.chat.agentDebugLog.fileLogging.enabled` to true, with no prompt or notification. Leave a setting alone when the user has explicitly turned it off.
- The new build deletes the old build's stored data once: `account-tracking/`, `quota-history.jsonl` and `scan-cache/` in the extension's global storage. Losing that history is accepted.

## Facts found on 2026-09-23

These were observed once. Re-check each one you rely on.

- **Output log path:** `%APPDATA%\Code\logs\<session>\window<N>\exthost\GitHub.copilot-chat\GitHub Copilot Chat.log`, with rotated copies such as `GitHub Copilot Chat.1.log`.
- **Output logs are short-lived.** VS Code keeps only the newest 10 log sessions, and every `code` command-line call creates one, so output logs rarely outlive a day.
- **Quota lines are coarse.** They appear only at Trace. `percentRemaining` has one decimal, and 0.1% was 80 credits on an 80 000 allowance. The value lags: it stayed flat through 55-91 requests, then dropped 0.3-0.8 points at once.
- **GPT models are missing from the output log.** Requests through the Responses API write no request, cost or quota lines there. The debug logs have them, and the quota still counts their spend.
- **Units match.** The quota's unit matched the debug-log credits: that day the quota dropped about 2 480 credits and the debug logs recorded 2 570.
- **Account lines are occasional.** They appear at window start and when a token refreshes, not on a schedule. Two of nine window logs had lost their first lines that day, account line included.
- **Debug log location:** `%APPDATA%\Code\User\workspaceStorage\<id>\GitHub.copilot-chat\debug-logs\`, or `globalStorage\github.copilot-chat\debug-logs\` for windows with no folder open.
- **Copilot prunes debug logs.** It keeps 50 chats per folder and trims files over 100 MB to their newest 60 MB. The debug logs name no account. The debug log setting takes effect after a window reload.
- **Most requests carry a cost.** 96% of `llm_request` lines had a positive `copilotUsageNanoAiu`. Free models log 0, and failed requests omit the field. `spanId` repeats across a resumed chat.
- **Hover limits.** The VS Code hover keeps tables, `img` tags with `data:` URIs and `width`/`height`/`title`, and `span` color styles. It stays open under the mouse only while it contains a link. Reassigning `statusBar.tooltip` redraws an open hover, so assign it only when the markdown changed.
- **Copilot Chat's source** ships with VS Code at `resources\app\extensions\copilot\dist\extension.js` under the install folder.

## Phases

### Phase 1: fresh start and the numbers

Build:

- Replace AGENTS.md with the rules from "How to work" and the facts that stay true. Every old safeguard goes.
- Remove the old implementation: every source and test file, and every `package.json` contribution besides the status bar. That covers the view container, views, welcome view, commands, menus, the `copilotUsage.dataPath` setting and the restricted-mode note. Rename the extension to "Copilot Credits" and rewrite its description and keywords.
- Build fresh:
  - the Trace setup
  - the quota reading across windows
  - the account
  - the saved record
  - the status bar with its startup and waiting states
  - the one-time removal of old stored data
- Leave the hover out for now. Check whether the Trace setting takes effect without a restart. If it needs one, ask Leon how the waiting state should say so.

Done when:

- Only new code remains, and compile, tests and package pass.
- The status bar behaves as the design describes in every state.
- Every user-visible detail of the old status bar, quota reading and Trace setup is carried over or reported as dropped with a reason.

Leon checks:

- **Name:** in the Extensions view the extension is "Copilot Credits", and the Copilot Sessions icon is gone from the activity bar.
- **Numbers:** the status bar reads like `3.1% • 76.5/100%`. Pass: the second number matches the usage Copilot shows when you click its status bar icon.
- **Windows:** with two windows open, chat in one. Pass: the other window's numbers change within a few seconds. Fail: it keeps the old number.
- **Restart:** reload a window. Pass: the numbers appear at once. Fail: it shows `Waiting for Copilot` or nothing.

### Phase 2: the hover

Build: the hover as designed, without Model use. That means today with the account, the month with the pace, and the 30-day graph.

The graph and the hover markup must look exactly like the old ones. That covers bar sizes, theme colors, bar scaling, the axis and date labels, full-width tables, bold labels, dimmed spans and separators. The old graph renderer (`src/ui/usageGraph.ts` on `main`) is small and pure, so reuse it and change only what the new data needs.

Done when:

- Every hover line and state in the design renders, and tests cover the formatting.
- Every user-visible detail of the old hover and graph (theme colors, bar scaling, date labels, the info link) is carried over or reported as dropped with a reason.

Leon checks:

- **Layout:** hover the status bar. Pass: from top to bottom you see today and the account, a separator, then the month with the pace and the graph with its dates.
- **Stays open:** move the mouse into the hover. Pass: it stays open.
- **Graph:** hover the last bar. Pass: it is today and reads like `23 Sep · 3.1%`.

### Phase 3: model use

Build: the debug log setting, the monthly tally and the Model use section.

Done when:

- The section shows the top 3 models by credits with chats and share.
- It survives a restart, and reading a chat again never counts it twice.
- Every user-visible detail of the old model list and debug-log reading is carried over or reported as dropped with a reason.

Leon checks:

- **Models:** reload a window, chat once, then hover. Pass: "Model use this month" lists your models, GPT included.
- **Restart:** quit and reopen VS Code. Pass: the list is unchanged.

### Phase 4: finish

Build:

- Update the README for the new extension. Ask Leon for a hover screenshot to use in it.
- Write the final package description, keep only the tests that earn their place, and review the whole codebase for leftovers.
- Build a clean VSIX.
- Delete this plan. Its lasting rules live in AGENTS.md.
- Nothing is pushed or published.

Done when: the README matches the extension, and `npx vsce ls` lists only shipped files.

Leon checks:

- **README:** read it. Pass: every statement matches what you see.
- **Install:** run `npm run install:local` and reload. Pass: Copilot Credits loads with no error notification.
