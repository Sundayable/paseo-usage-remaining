# Usage Remaining — Cursor token moved to the macOS Keychain — 2026-09-19

## Symptom
Cursor row read `not signed in or no usage data` on macOS even with the desktop app
signed in and `cursor-agent status` reporting `Logged in as <user>`.

## Root cause
`readCursorToken()` probed three places: `CURSOR_ACCESS_TOKEN`/`CURSOR_TOKEN`, the
desktop app's `state.vscdb` (`cursorAuth/accessToken`, `cursorAuthStatus`), and
`~/.cursor/auth.json`. Current Cursor (3.9.16) writes none of them on macOS:

- `state.vscdb` keeps only `cursorAuth/cachedEmail`, `cachedSignUpType`,
  `onboardingDate`, `stripeMembershipType`. `accessToken` is gone. Confirmed with the
  WAL replayed onto a copy — a read-only SQLite connection sees a stale pre-WAL view,
  which is its own trap when diagnosing this.
- `cursor-agent login` on macOS writes no `auth.json`; it uses the Keychain too.
- The token lives at Keychain service `cursor-access-token`, account `cursor-user`.

Linux is unaffected: no Keychain, so `cursor-agent` still writes
`~/.config/cursor/auth.json` and that path stays live.

## Fix
`readCursorToken()` now probes the Keychain via `security find-generic-password`
before the SQLite and file paths, the same mechanism `readClaudeCredentials()` already
uses. Tried with and without the `-a cursor-user` account filter. Every failure mode
(not macOS, item absent, access denied) is swallowed and falls through to the old paths.

## Verification
- `npm run typecheck`: PASS. `npm test`: PASS, 24 tests (no new pure logic to test —
  this is credential I/O).
- Before: `cursor_month — unavailable`. After: `cursor_month 50% available, reset 2d 2h`.
- The endpoint returns 200 with the Keychain token; same body shape as a Linux host
  reading `auth.json`, so the two paths are interchangeable.

## Known issue left open
The detail string reads `used $629 · included $20`, which implies massive overspend.
It does not: the API returns `totalSpend = includedSpend + bonusSpend`
(62914 = 2000 + 60914), where the bonus is free provider-granted usage. The chip
percentage is correct — it comes from `totalPercentUsed` and matches Cursor's own
"You've used 50% of your included total usage". Only the detail line misleads, by
comparing a bonus-inclusive total against the included amount alone. Not fixed here.

# Usage Remaining — 2026-09-13

## Current goal and result
Grok chip vanished from the WK strip after the xAI weekly reset (2026-09-13
18:57 UTC). Fixed at the parser, and the strip no longer drops a provider silently.

## Root cause
`cli-chat-proxy.grok.com/v1/billing?format=credits` serialises protobuf to JSON:
fields at their default value are omitted. Right after a reset `creditUsagePercent`
is 0 and therefore absent (also no `monthlyLimit`/`used`), while `currentPeriod`
is present. `fetchGrok` treated that as "no usage data" → row `unavailable`.
`withLastGood` then saw the cached row's `resetIso` in the past and also returned
`unavailable`, and `UsagePill` filters to `available` only → chip gone for the
first hours of every weekly period (until usage > 0.5%).

## Implementation
- `server/usage.ts`: `parseGrokBilling()` is a pure, exported parser. Order:
  `creditUsagePercent` → `monthlyLimit`/`used` → live period with no usage fields
  = 100% remaining (`detail: "no usage yet this period"`) → otherwise unavailable.
- `withLastGood(rows, now, cache)`: when a provider had a recent good value but
  its cached window has reset and the API is not answering, return status
  `error` with `—` (kept brand/label) instead of `unavailable`. Testable via
  injected `now`/`cache`. `resetLabel(iso, now)` for deterministic countdowns.
- `fetchWithTimeout` (15 s AbortController) on all four provider requests;
  rejected fetches and Grok non-200/unparsable bodies are logged as
  `[usage-remaining] <provider>: …` (previously only Claude logged).
- `client/usage.tsx` `UsagePill`: strip shows `status !== "unavailable"`, so
  `error` rows render as dimmed muted `—` chips. Cards/labels unchanged.
- `tests/grok-billing.test.mjs`: exact post-reset body, percent/limit paths,
  and `withLastGood` placeholder + fresh-countdown behaviour.

## Verification
- `npm run typecheck`: PASS. `npm test`: PASS, 24 tests.
- `paseo plugin reload usage-remaining` → `running`; direct `fetchUsage()` returns
  `grok_week available 100% 6d`; Paseo desktop strip shows Grok 100% 6d between
  Codex and Cursor (screenshot taken 2026-09-13 14:28 PT).

## Risks / notes
- If xAI ever omits `currentPeriod` too, the row is unavailable (correct: no plan).
- `error` chips only appear for providers that had data within the 6 h last-good
  TTL; a genuinely signed-out provider still hides after that.
- Next: none required. If a chip disappears again, read `~/.paseo/daemon.log`
  for `[usage-remaining] <provider>:` lines first.
