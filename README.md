# usage-remaining

A [Paseo](https://paseo.sh) plugin that shows how much AI usage you have **left** — right above the composer.

Two lines, always visible while you work:

- **5H** — 5-hour session limits (Claude, Codex when active)
- **WK** — weekly limits (Claude, Fable, Codex, Grok) and Cursor's monthly plan

Each entry shows the provider logo, remaining %, and time until reset (e.g. `1h 23m` under 24 hours, or `1d 6h`). Click the pill for a full dashboard, or open it from the sidebar ("Remaining") and the Command Center.

## What it reads

| Provider | Source | Notes |
| --- | --- | --- |
| Claude (session + weekly + Fable weekly) | Claude Code login (macOS Keychain / `~/.claude/.credentials.json` / `CLAUDE_CODE_OAUTH_TOKEN`) | Fable's model-scoped weekly limit is shown as its own entry |
| Codex | Codex CLI login (`~/.codex/auth.json`) | Windows classified by reported length; plans that report only a weekly window (e.g. Pro) show no Codex 5H entry |
| Grok | Grok CLI login (`~/.grok/auth.json`) | Supports unified-billing (weekly %) and legacy monthly credits |
| Cursor | Cursor desktop / `cursor-agent` login | Individual plans only — team-billed seats don't expose plan usage |

Everything is read **locally and read-only**. No credentials are written, logged, or sent anywhere except each provider's own usage API.

## Install

Requires Paseo **0.7.0+**.

1. In Paseo: **Settings → Plugins → Enable plugins**
2. In a terminal:

```bash
paseo plugin add Sundayable/paseo-usage-remaining
```

That's it. Open any workspace — the usage pill appears above the composer.

Update later with:

```bash
paseo plugin update usage-remaining
```

## Behavior details

- Refreshes every 60s. Claude is polled at most every 5 min: Anthropic's usage endpoint blocks the whole account for about an hour when it is polled too often, and one 429 puts the plugin into an account-wide cooldown for the `retry-after` the server sends. Expired Claude tokens are skipped without a request.
- The pill and dashboard include a manual refresh button. A manual refresh re-queries Codex, Grok, and Cursor immediately; Claude still keeps its 5-minute minimum interval and any active cooldown. After a manual refresh, the button shows a shared 2-minute countdown before it can be pressed again.
- If a provider's token is mid-rotation (common while agents run), the plugin serves the **last good value** from a small local cache (`$PASEO_HOME/usage-remaining.cache.json`) instead of flickering to "—". Absolute reset timestamps are cached, so countdown labels keep updating even while the provider API is rate-limited.
- Rows with no data are hidden from the pill but shown in the dashboard.
- A cached row is dropped once its own reset time passes, so a stale pre-reset % is never shown next to `now`.

## Caveats

- Paseo's plugin API is experimental; a Paseo update may require a plugin update.
- Provider usage endpoints are unofficial and can change without notice.
- Cursor team-billed seats return no plan usage from the endpoint this plugin uses.

## Credits

Provider endpoint and credential-file handling is based on Paseo's own open-source quota-fetcher ([getpaseo/paseo](https://github.com/getpaseo/paseo), Apache-2.0). Provider logos are the trademarks of their respective owners, used for identification only.

## License

MIT
