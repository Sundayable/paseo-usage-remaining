# Usage Remaining — 2026-09-22

## Current goal and result
Claude Opus 5.5 shipped 2026-09-21. The Claude parser hard-coded three rows
(session, weekly, Fable) and would have silently ignored any new model-scoped
weekly limit. It now renders every `weekly_scoped` entry from
`api.anthropic.com/api/oauth/usage` as its own row, so a new Opus 5.5 (or later)
window shows up without a plugin change.

## Implementation
- `server/usage.ts`: `parseClaudeUsage(body)` is a pure, exported parser
  (`ClaudeUsageBody` exported too). Rows: `claude_session`, `claude_week`, then
  one row per `weekly_scoped` limit — Fable keeps `fable_week` / brand `fable`;
  any other scope becomes `claude_scoped_<slug of model id>` with brand `claude`,
  label = `scope.model.display_name` (fallback model id), detail
  `model-scoped weekly limit`. Legacy `seven_day_opus` / `seven_day_sonnet`
  windows are added only when `limits[]` did not already carry that family.
  `seven_day_omelette` remains the Fable fallback when `limits[]` is absent.
- `client/registry.ts` `usageLabel`: a row whose label differs from the head
  row is prefixed with its name (`Claude · 5H 84% · WK 58% · Opus 5.5 WK 75%`).
- `client/usage.tsx` `BrandMark`: Claude-brand rows whose label is not
  `Claude` show their name next to the logo, so two Claude WK chips stay apart.
- `tests/claude-usage.test.mjs`: the exact 2026-09-22 body (3 rows), an added
  Opus 5.5 scope, missing display name + duplicate collapse, legacy
  `seven_day_opus` precedence, and a body without `limits[]`.

## Verification
- `npm run typecheck`: PASS. `npm test`: PASS, 30 tests (Node 26.5).
- `paseo plugin reload usage-remaining` on Paseo 0.8.0 daemon; log shows
  `[usage-remaining] claude: ok via keychain token` after reload.
- Live body on 2026-09-22 has `seven_day_opus: null` and only the Fable scope,
  so the strip is unchanged today; the new row appears the day Anthropic adds one.

## Risks / notes
- Paseo 0.9.0 (released 2026-09-22) is pending on Dan's Mac; the web/native
  composer adapters were verified on 0.8.0 only. After the app update, open a
  workspace and confirm the two-row strip still expands; if not, see the README
  "Paseo 0.8 web compatibility" section and recheck `client/web-composer.ts`.
- `RemainingRowSchema.brand` is unchanged (`claude` reused for scoped rows); no
  client/daemon version skew.
- Not pushed: commit is local on `main` of `Sundayable/paseo-usage-remaining`;
  push needs Dan's approval.

## 2026-09-22 (later): Paseo 0.9.0 composer pills
- Symptom after the 0.9.0 app update (17:31 UTC): no usage chip on agents created
  after the app started. Server side was healthy (`claude: ok via keychain token`).
- Cause: in 0.9.0 `client.paseo.agents.subscribe()` only receives `agent_update`
  while an `agents.list({ subscribe: {} })` observation is open. The plugin listed
  agents once without `subscribe`, so new agents never got a pill.
- Fix (`client/registry.ts`): the first page requests `subscribe: {}` and keeps the
  returned `subscription`; cleanup (and a late reply after cleanup) releases it.
  On 0.8 `subscribe` is a plain request field and no handle is returned.
- Tests: two new cases in `tests/registry.test.mjs`; both fail on the previous
  registry and pass now. `npm run typecheck` PASS, `npm test` 32/32 PASS.
  `paseo plugin reload usage-remaining` done 17:52 UTC.
- Still to confirm by eye: chip visible on a newly created agent in the desktop app.
- Unrelated Paseo 0.9.0 bug seen at the same time: the composer shows "Opus 5" for
  `claude-opus-5-5` agents. `normalizeClaudeRuntimeModelId` (server
  `providers/claude/model-manifest.js`) falls through to an unanchored
  `claude-(opus)-(\d+)` match, so an ID missing from the built-in manifest
  collapses to `claude-opus-5` in `runtimeInfo.model`. Display only: queries use
  `config.model` (still `claude-opus-5-5`). Fix belongs upstream in Paseo.

## 2026-09-23: Claude chip vanished (Claude Code login expired)
- Symptom: no Claude/Fable chips since 2026-09-22 15:15 PT; agent pills said "Usage unavailable".
- Cause: not the plugin. The interactive Claude Code login's `refreshTokenExpiresAt`
  passed (2026-09-22 14:36 PT) and Claude Code blanked `accessToken`/`refreshToken` in
  keychain `Claude Code-credentials` and `~/.claude/.credentials.json`. Only the env
  setup token (`~/.config/agent-core/auth/claude.env`) was left, and `oauth/usage`
  answers it 403. The plugin retried the 403 every poll and drew an hourly 429. After
  the 6 h last-good TTL the rows went `unavailable`, and the client hides those.
- Fix (`server/usage.ts`): a 403 puts the token on a 6 h persisted cooldown.
  `claudeLoginExpired()` detects a keychain/file `claudeAiOauth` block with no live
  token. In that state the plugin drops cached Claude/Fable rows and returns
  `claudeSignedOutRows()`: status `error`, session chip "login expired", detail
  "run `claude auth login`". `client/registry.ts` `usageLabel` names that state on
  agent pills ("Claude · login expired"). A machine that never signed in is unchanged.
- Tests: 3 new cases in `tests/claude-usage.test.mjs`, 1 in `tests/registry.test.mjs`.
  `npm run typecheck` PASS, `npm test` 35/35 PASS. Reloaded 21:25 UTC; log shows
  `claude: Claude Code login expired ...`.
- Recovery is `claude auth login` (the browser flow) on Dan's Mac; expect it about monthly.


## 2026-10-18: Follow the Claude worker credential

- Branch: `fix/claude-worker-usage`. The installed checkout already contained three local commits (`f5ea5ad`, `1297d89`, `c996da5`) beyond remote main. They are preserved as prerequisites on this branch; main is not pushed or merged.
- `claude.env` now takes priority over the daemon environment and the interactive Keychain/file login. All Claude rows carry `workers` or `fallback`; dashboard details identify the credential source, optional fingerprint-bound account label, and primary lookup failure.
- `server/claude-poll.ts` owns credential-bound samples, per-token five-minute attempt limits, single-flight requests, persisted 429/403 cooldowns, and cache expiry. Old global Claude rows cannot masquerade as worker usage. Plugin cleanup flushes its cache atomically before a reload.
- No inference requests run inside the plugin. A setup token can successfully run workers while lacking the scope needed by the usage endpoint. Such a token yields an explicit fallback/unavailable result, not a fabricated quota.
- Source installed from the branch checkout with `paseo plugin reload usage-remaining`; `paseo plugin ls usage-remaining --json` confirms `running`. The original directory remains intact. Backup (source, configuration and cache; dependencies remain in the original directory): `~/.paseo/plugin-backups/usage-remaining-20261018-112706`.
- Validation: `npm run typecheck` PASS; `npm test` PASS (52 tests, including process-to-process cache/account-switch/cooldown coverage); `git diff --check` PASS; `gitleaks dir . --redact` found no leaks. Live `usage.list` confirms the Keychain result is labelled `Claude (fallback)` and the worker account is named in its details.
- Visual QA limitation: native computer-use timed out. The installed web UI loaded locally, but its websocket connection was correctly refused by the daemon's Origin policy (HTTP 403). No Origin allowlist or daemon settings were widened. Existing native/web composer regression tests pass; an actual phone/native visual inspection is not claimed.
- The reported worker-token 429 was preserved conservatively through 2026-10-18 19:18:55 UTC. The one-shot post-cooldown RPC completed at 19:19:00 UTC: the actual env-token request again returned HTTP 429, confirmed in the plugin log. The live RPC therefore shows explicitly labelled Keychain fallback values (100% session / 100% week), with the worker account and HTTP 429 in the detail. Another per-token cooldown is active; the company account's current weekly quota remains unavailable. A separately authorized diagnostic had confirmed a different organization and nonzero session utilization; that old sample was not injected into the chip or used to invent a weekly value.
- Rollback: unregister the directory source (`paseo plugin remove usage-remaining`, which keeps its files), then install `~/.paseo/plugins/usage-remaining --id usage-remaining` and reload. Restoring the backup cache would also restore the old account-selection behavior; prefer the new credential-scoped cache unless reverting the code.
