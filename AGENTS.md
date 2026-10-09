# Copilot Credits

VS Code extension that shows the signed-in account's Copilot credit use in a status bar item and its hover. It reads Copilot's log files on this machine.

## Project map

- `src/extension.ts`: activation, polling, settings setup and the status bar item.
- `src/quota.ts`: reads quota lines from Copilot Chat's output logs, assigns them to accounts, and does the today, month and pace math.
- `src/models.ts`: tallies credits by model from Copilot's debug logs and VS Code's agent session usage logs.
- `src/hover.ts`: builds the hover's markdown and the daily bar images.
- `test/`: Vitest tests, one file per source file.
- `esbuild.js`: bundles `src/extension.ts` into `dist/extension.js`.

## Commands

- `npm test`: run the tests.
- `npm run compile`: type check and build.
- `npm run preview`: tests, build, then a VS Code development window; add `-- -Mock` for made-up data. Its scripts are gitignored.
- `npm run package`: tests, type check and production build into a `.vsix`. It must pack only `LICENSE`, `package.json`, `README.md`, `logos/logo.png` and `dist/extension.js`.
- `npm run install:local`: package and install into VS Code.
- Release (no CI): `npm version patch --no-git-tag-version`, commit, tag `vX.Y.Z`, push `main` and the tag, `npm run package`, `gh release create vX.Y.Z <vsix> --notes "<short notes>"`, then `npx vsce publish --packagePath <vsix>`.

## Data sources

`<data>` = VS Code user data dir (`%APPDATA%\Code`, `~/Library/Application Support/Code`, `~/.config/Code`).

- Quota: `<data>/logs/<session>/window<N>/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log`, `[ChatQuota]` lines (Trace only)
- Model credits: `debug-logs/<chat>/*.jsonl` under `<data>/User/workspaceStorage/<id>/GitHub.copilot-chat/` and `<data>/User/globalStorage/github.copilot-chat/`, `llm_request` lines
- Agent sessions: `<data>/User/agentHostUsage/<session>.jsonl`, `modelCall` lines
- Copilot Chat source: `resources/app/extensions/copilot/dist/extension.js` inside the VS Code install (on Windows under a `<commit>` folder)

## Working rules

- Make the normal path work: several windows, restarts, account switches and a new month. A rare case may show a wrong value briefly if the next update fixes it. Guard against values that stay wrong, and against crashes.
- Stay local: no network calls, sign-in or telemetry.
- Display this window's latest `Got Copilot token for <login>` account when it has quota history; otherwise display the account with the newest quota reading. Keep collecting every window's readings and combining model use across accounts. No account picker.
- VS Code's hover sanitizer keeps `img` with data URIs, allows only color, background-color, display:inline-block and border-radius in `span` styles, and drops custom classes, `<style>` and `<svg>`. Without a link, the hover closes when the mouse moves onto it.
- Add focused tests for parsing and math, and break the code once to see each new test fail.
- Finish with `npm run package` and a subagent review of the diff.
