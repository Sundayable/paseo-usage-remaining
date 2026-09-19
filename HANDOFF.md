# Usage Remaining — Factory Droid provider — 2026-09-18

## Current goal and result
Add Factory's Droid as a sixth provider. Done: `factory_5h` and `factory_week`
rows, brand `factory`, label "Droid". Credential is `FACTORY_API_KEY` only.

## Endpoint
`GET https://api.factory.ai/api/billing/limits`, headers
`Authorization: Bearer <FACTORY_API_KEY>`, `Accept: application/json`,
`X-Factory-Client: cli`. The host is hardcoded: the CLI can retarget it, but an
overridable base URL is the one place a credential's destination would be
configurable, and no other provider in this repo does that. Body:

```json
{ "limits": { "standard": { "fiveHour": { "usedPercent": 40, "windowEnd": "…Z" },
                            "weekly":   { … }, "monthly": { … } },
              "core": { "fiveHour": { … }, "weekly": { … }, "monthly": { … } } },
  "extraUsageBalanceCents": 0, "overagePreference": null,
  "extraUsageAllowed": false, "canManageOverage": false }
```

Read out of `~/.local/bin/droid` 0.212.1 (`G$R()` calls `wi("/api/billing/limits")`;
`wi` prepends `W1().apiBaseUrl` = `https://api.factory.ai` and merges
`O$T()` = the Bearer header; the usage panel reads `limits.standard` / `limits.core`).
Nothing under `~/.factory/` was read: `auth.v2.*` is encrypted and out of scope.

## Implementation
- `server/usage.ts`: `parseFactoryLimits()` is a pure, exported parser taking an
  injectable `now`. Standard drives the chips; monthly and Core land in `detail`
  (`monthly 90% left · core 75% left`), so no split the API does not report is invented.
- Window semantics copied from the CLI (`YHC`/`jHC`): a bucket whose `windowEnd`
  has already passed is the *next*, untouched window — the CLI shows it as 0% used
  with no countdown. Treating that as "no data" would drop the chip for the first
  hours of every window, exactly the Grok post-reset bug. So an elapsed window is
  100% remaining with `detail: "no usage yet this window"` and no `resetIso`.
- A live window with a non-finite `usedPercent` stays `unavailable` (matches the
  CLI's own `"—"` for that case).
- `fetchFactory()`: no key → both rows `unavailable` with `detail: "set FACTORY_API_KEY"`;
  non-200 → `unavailable` with `Factory API <status>`, which `withLastGood` upgrades
  to a dimmed `error` chip when a recent good value is cached. All requests go through
  `fetchWithTimeout`; failures log as `[usage-remaining] factory: …`.
- `shared/usage.ts`: `factory` added to the brand enum. `client/logos.ts`: Factory's
  real mark from `app.factory.ai/favicon.ico` (a 900px PNG despite the extension),
  cropped to the artwork and area-averaged to 128px, source at `assets/factory.png`.
  The mark is an eight-petal pinwheel of thin strokes: legible at the 22px size and
  at 14px on a Retina panel (28 physical px), soft at 14px on a 1x display.
  `index.client.tsx`: `droid`/`factory` keywords.
- `tests/factory-limits.test.mjs`: happy path with Core detail, elapsed-window and
  zero-usage bodies, unrecognised/absent bodies, missing env var, and the API-error
  → `withLastGood` placeholder.

## Verification
- `npm ci`, `npm run typecheck`: PASS. `npm test`: PASS, 30 tests (was 24).
- Live `GET /api/billing/limits`: **HTTP 200**. Host, Bearer auth and every field
  name read out of the binary were confirmed unchanged. Shape (figures are
  representative, not the tester's own):

```json
{ "usesTokenRateLimitsBilling": true,
  "limits": {
    "standard": { "fiveHour": { "usedPercent": 0,  "windowEnd": null, "secondsRemaining": null },
                  "weekly":   { "usedPercent": 40, "windowEnd": "2026-09-22T00:00:00.000Z", "secondsRemaining": 302400 },
                  "monthly":  { "usedPercent": 25, "windowEnd": "2026-10-01T00:00:00.000Z", "secondsRemaining": 1080000 } },
    "core":     { "fiveHour": { "usedPercent": 0,  "windowEnd": null, "secondsRemaining": null },
                  "weekly":   { "usedPercent": 30, "windowEnd": "2026-09-24T00:00:00.000Z", "secondsRemaining": 475200 },
                  "monthly":  { "usedPercent": 10, "windowEnd": "2026-10-17T00:00:00.000Z", "secondsRemaining": 2462400 } } },
  "overagePreference": null, "canManageOverage": true,
  "extraUsageBalanceCents": 0, "extraUsageAllowed": true }
```

- Two fields the binary read had not shown: `secondsRemaining` (a skew-free companion
  to `windowEnd`; unused, `windowEnd` is sufficient) and `usesTokenRateLimitsBilling`,
  an account flag. Accounts without token-rate-limits billing may return another shape
  entirely; the parser degrades to `unavailable` rather than guessing.
- An **idle 5-hour window is `windowEnd: null`**, not an elapsed timestamp — no window
  opens until Droid is used. That is the live-path case, not a corner case, and it is
  pinned in `tests/factory-limits.test.mjs` with the verbatim body above.
- `fetchUsage({force:true})` produced a live `factory_5h` row at 100% with detail
  `no usage yet this window · core 100% left`, and a `factory_week` row whose
  percentage, countdown and `monthly … · core …` detail all matched the raw body's
  figures after the used→remaining inversion.
- Live in Paseo: plugin registered and loaded; the daemon log shows no factory errors.
  The dashboard card and the compact composer strip both render the Droid rows with the
  Factory mark — `Droid 100%` under 5H and `Droid 63% · 3d` under WK (screenshots taken
  2026-09-19). The mark is an eight-petal pinwheel, so it is crisp at the 22px card size
  and holds up at the 14px strip size on a Retina panel (28 physical px); on a 1x display
  it will be softer.

## Risks / notes
- The endpoint is unofficial and undocumented; it was reverse-read from the CLI binary
  and then confirmed against one live 200 on one account (Standard + Core, overage on).
- The key currently lives only at `.agents.providers.factory-droid.env.FACTORY_API_KEY`
  in `~/.paseo/config.json`, which Paseo passes to the droid *provider* subprocess. The
  plugin server runs in the *daemon*, so it does not inherit that. Until the export is in
  `~/.zshrc` and the daemon has restarted, the strip will read `set FACTORY_API_KEY`.
- `~/.paseo/*-daemon.log` matches the string `FACTORY_API_KEY` only inside a droid
  ACP auth-error message ("Login required ... or set a FACTORY_API_KEY environment
  variable"). Checked: the key *value* does not appear in the log. Those errors are
  independent of this plugin, but they corroborate that the daemon environment has
  no Factory key today.
- Factory reports three standard windows; only fiveHour and weekly get chips, because
  the strip has two groups. Monthly is in the weekly row's detail. If a plan is ever
  bound by monthly first, the chip will look healthier than the account really is.
- If `limits.core` disappears from the response the rows are unaffected — the Core
  aside is simply dropped.

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
