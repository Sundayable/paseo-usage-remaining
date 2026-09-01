# usage-remaining

A [Paseo](https://paseo.sh) plugin that shows how much AI usage you have **left** — right above the composer.

Two lines, always visible while you work:

- **5H** — 5-hour session limits (Claude, Codex when active)
- **WK** — weekly limits (Claude, Fable, Codex, Grok) and Cursor's monthly plan

Each entry shows the provider logo, remaining %, and time until reset (e.g. `1d 6h`). Click the pill for a full dashboard, or open it from the sidebar ("Remaining") and the Command Center.

## What it reads

| Provider | Source | Notes |
| --- | --- | --- |
| Claude (session + weekly + Fable weekly) | Claude Code login (macOS Keychain / `~/.claude/.credentials.json` / `CLAUDE_CODE_OAUTH_TOKEN`) | Fable's model-scoped weekly limit is shown as its own entry |
| Codex | Codex CLI login (`~/.codex/auth.json`) | Session/weekly windows classified by reset horizon |
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

- Refreshes every 60s (Claude throttled to 2 min to respect Anthropic's rate limits).
- If a provider's token is mid-rotation (common while agents run), the plugin serves the **last good value** from a small local cache (`$PASEO_HOME/usage-remaining.cache.json`) instead of flickering to "—".
- Rows with no data are hidden from the pill but shown in the dashboard.

## Caveats

- Paseo's plugin API is experimental; a Paseo update may require a plugin update.
- Provider usage endpoints are unofficial and can change without notice.
- Cursor team-billed seats return no plan usage from the endpoint this plugin uses.

## Credits

Provider endpoint and credential-file handling is based on Paseo's own open-source quota-fetcher ([getpaseo/paseo](https://github.com/getpaseo/paseo), Apache-2.0). Provider logos are the trademarks of their respective owners, used for identification only.

## License

MIT
