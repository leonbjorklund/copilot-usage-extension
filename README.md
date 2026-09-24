# Copilot Credits

See how much of your monthly GitHub Copilot credit allowance you use, in the VS Code status bar. Copilot Credits reads Copilot Chat's own log files on your machine. It makes no network calls, needs no sign-in and sends no telemetry.

After installing, quit and reopen VS Code once, so every window starts writing the logs Copilot Credits reads. Reloading a window is not enough.

## Status bar

The item sits next to Copilot's own status bar icon and reads like `3.1% • 76.5/100%`. The first number is today's share of your monthly allowance. The second is the share of this month's allowance used so far. Past the allowance it reads like `3.1% • 100/103.2%`.

Other texts you may see:

- `Waiting for Copilot`: no usage reported yet. It changes after your next Copilot Chat message.
- `Restart to see Credit usage`: this window's Copilot Chat does not report usage yet. Quit and reopen VS Code. If you set Copilot Chat's log level yourself, change it to `trace` in **Preferences: Configure Runtime Arguments** first.
- `Unlimited Copilot quota` or `No Copilot credit allowance`: your plan has no monthly allowance to count.

## Hover

Hover the item to see:

- Today's share and credits, and the account Copilot Chat signed in with.
- The month's share and credits of your allowance, and the monthly pace: the share you will have used by the reset if your average daily use so far continues.
- A graph of your last 30 days. Bars for this month are bright. Hover a bar to see that day's share.
- Model use this month: your top 5 models by credits, how many chat sessions used each, and each model's share. It counts every account's chats in this VS Code since its debug logs were turned on, GPT models included, and leaves out Copilot use elsewhere, like on github.com.

## How it works

Copilot Chat logs your remaining allowance after each response, but only at the Trace log level. Copilot Credits reads those lines from every open window and saves a small daily record per account in VS Code's extension storage, so the numbers show at once after a restart. Copilot reports the share of your allowance left in steps of 0.1%, and the credits shown come from that share, so they move in steps of 80 credits on an 80 000 credit allowance. The share can stay flat through dozens of requests, then drop several tenths at once.

Model use comes from Copilot's debug logs, which record each request's model and credits. These logs also store each chat in full on your disk, including your messages, the replies and tool output, and they can take gigabytes of space.

Copilot Credits turns both logs on without a prompt:

- Copilot Chat's default log level becomes Trace. VS Code saves it in `argv.json`.
- `github.copilot.chat.agentDebugLog.fileLogging.enabled` becomes true in your user settings, which Settings Sync copies to your other machines.

A value you already set yourself stays as you set it, so setting the debug log setting to false keeps it off. Uninstalling leaves both in place. To undo them after uninstalling, run **Preferences: Configure Runtime Arguments** and remove `github.copilot-chat=trace` from `log-level`, then remove the setting from your user settings.
