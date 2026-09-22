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
