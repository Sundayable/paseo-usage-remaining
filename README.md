# usage-remaining

A [Paseo](https://paseo.sh) plugin that shows how much AI usage you have **left** — right above the composer.

The original two-line display is preserved on Paseo Desktop, web, and compatible native clients:

- **5H** — provider logos, colored remaining percentages, and session reset times
- **WK** — Claude, Fable, Codex, Grok, and Cursor (monthly) with their reset times

Green, yellow, and red percentages show remaining capacity. Refresh inline, or click
for the full dashboard. On narrow web screens the reset labels and refresh button
move out of the inline display; all providers still fit, and the dashboard has details.

On iOS, the colored two-row display stays above the input. Tap it to open all providers in a scrollable sheet.
Cards show each provider’s logo and name, colored remaining capacity, and one reset
label. Narrow screens stack the header above a 44px refresh button. The full
dashboard uses the same responsive cards. Failed refreshes preserve the last values
and show an error.

## What it reads

| Provider | Source | Notes |
| --- | --- | --- |
| Claude (session + weekly + Fable weekly) | Claude Code login (macOS Keychain / `~/.claude/.credentials.json` / `CLAUDE_CODE_OAUTH_TOKEN`) | Fable's model-scoped weekly limit is shown as its own entry |
| Codex | Codex CLI login (`~/.codex/auth.json`) | Windows classified by reported length; plans that report only a weekly window (e.g. Pro) show no Codex 5H entry |
| Grok | Grok CLI login (`~/.grok/auth.json`) | Supports unified-billing (weekly %) and legacy monthly credits |
| Cursor | Cursor desktop / `cursor-agent` login | Individual plans only — team-billed seats don't expose plan usage |

Everything is read **locally and read-only**. No credentials are written, logged, or sent anywhere except each provider's own usage API.

## Install

Requires Paseo **0.8.0 stable** on the daemon and client. Early 0.8 betas use an older composer API. The last revision for Paseo 0.7 is commit `8e4da65`.

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

- Refreshes every 60s. Claude is polled at most every 5 min. Anthropic's usage endpoint answers `429` (retry-after about an hour) for tokens it will not serve: expired access tokens and long-lived `claude setup-token` tokens. A fresh token from an interactive Claude Code login answers normally. The plugin skips expired tokens without a request, prefers keychain/file tokens over the env setup token, and remembers a per-token cooldown across reloads.
- If the Claude rows stay hidden, the keychain token has expired and nothing is refreshing it (Paseo-launched agents use the setup token). Run `claude` once without `CLAUDE_CODE_OAUTH_TOKEN` in the environment; Claude Code refreshes the keychain credential and the rows return within 5 min.
- The wide inline display and dashboard include a manual refresh button. A manual refresh re-queries Codex, Grok, and Cursor immediately; Claude still keeps its 5-minute minimum interval and any active cooldown. After a manual refresh, the button shows a shared 2-minute countdown before it can be pressed again.
- If a provider's token is mid-rotation (common while agents run), the plugin serves the **last good value** from a small local cache (`$PASEO_HOME/usage-remaining.cache.json`) instead of flickering to "—". Absolute reset timestamps are cached, so countdown labels keep updating even while the provider API is rate-limited.
- Provider windows with no data are omitted from the inline display and explained in the dashboard. If none are available, it says `Usage unavailable`.
- The original rich display uses the 0.8 web compatibility adapter described below. Native clients use a guarded native adapter to restore the same colored two-row display, with a scrollable sheet on tap.
- Source changes require `npm run typecheck` followed by `paseo plugin reload usage-remaining`. The 0.8.0 desktop client updates without a daemon restart.
- A cached row is dropped once its own reset time passes, so a stale pre-reset % is never shown next to `now`.
- On native clients the plugin hides Paseo's own git diff badge (`+123 -45`) from the
  composer track, so the phone shows usage only. Paseo 0.8 has no setting for that
  badge, so the native adapter hides the node and restores it when the plugin is
  disabled or unloaded. Desktop and web keep the badge.

## Paseo 0.8 web compatibility

Paseo 0.8 replaced arbitrary composer components with fixed button descriptors.
Its normal button forces muted text, a 160px maximum width, and a clipped 16px icon.
The plugin registers through the supported `button` API, then mounts the original
React Native usage component in its own web icon slot. The original button's
opaque surface, border, and rounded frame remain behind the colored data.

Paseo's track normally floats absolutely over the transcript. A two-row widget
must not remain in that overlay: `client/web-composer.ts` makes the containing
track a normal, nonshrinking flex row with an opaque background. The transcript
viewport gives up exactly the track's height; wrapping provider chips or adjacent
task/diff badges increases the reserved space instead of covering chat text.

The adapter verifies the expected direct ancestors (including the desktop's
`display: contents` tooltip wrapper) before expanding anything. It changes only
this agent's containing track and its own button, and restores all changed styles
and accessibility attributes on unmount. If safe space cannot be reserved, it
leaves the standard button intact. Native clients use `client/native-composer.ts` to expand the owned native icon slot
and reserve track height through `setNativeProps`. The host icon slot centers its
single child, so the adapter also sets `alignItems: 'flex-start'` and the two rows
start at the button's own text edge instead of sitting in a wide centered gutter. It validates the observed Fabric
host structure before touching any styles and restores changed properties on
teardown. This relies on internal React Native host handles; unknown structures
retain the standard button and sheet. Actual iPhone verification covered the
restored always-visible display, app re-entry, opening/closing the sheet, and
scrolling through Cursor. Android remains unverified.
Future host changes require rechecking the adapter against the installed app.

## Caveats

- Paseo's plugin API is experimental; a Paseo update may require a plugin update. This revision uses the stable 0.8 button registration API (`button`, `update`, `remove`) and runtime-entry layout (`index.client.tsx` / `index.server.ts`, `client/` `server/` `shared/`) and declares `requirements.paseo >=0.8.0`.
- Provider usage endpoints are unofficial and can change without notice.
- Cursor team-billed seats return no plan usage from the endpoint this plugin uses.

## Credits

Provider endpoint and credential-file handling is based on Paseo's own open-source quota-fetcher ([getpaseo/paseo](https://github.com/getpaseo/paseo), Apache-2.0). Provider logos are the trademarks of their respective owners, used for identification only.

## License

MIT

## Development

```bash
npm ci
npm run typecheck
npm test
paseo plugin reload usage-remaining
```

Tests use Node.js 22.18+ native TypeScript stripping. They cover paginated agent
bootstrap, live updates, moving/removing agents, teardown races, unavailable usage,
and scoped web style restoration/fallback.
SDK dependencies are pinned to the installed stable Paseo 0.8.0 API; the live docs may
show a newer subscription API that is not yet in that release.
