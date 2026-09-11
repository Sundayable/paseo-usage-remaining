# Usage Remaining — 2026-09-11

## Goal and state
Restore missing composer usage in Paseo 0.8.0 and update the GitHub repository.
Local plugin reloaded and running; desktop composer and dashboard verified.

## Cause and change
0.8.0 stable removed the old `Component`/`onPress` composer contribution and
function cleanup. It now requires `button` plus `update()`/`remove()` registration.
Pinned all Paseo SDK dev dependencies to 0.8.0 so typecheck catches this mismatch.
`client/registry.ts` owns paginated bootstrap, live agent updates, usage polling,
identity-preserving labels, moved/removed agents and teardown race handling.
The native pill shows the current provider's quota; clicking opens all providers.
Server credentials and provider fetchers were not changed.

## Verification
- `npm run typecheck`: PASS against 0.8.0 SDK.
- `npm test`: PASS, 5 lifecycle/label/error regression tests.
- `git diff --check`: PASS.
- `paseo plugin reload usage-remaining` + `paseo plugin ls --json`: running.
- Real local desktop client: Codex weekly percentage visible; pill opens dashboard.
- Wide desktop and compact desktop window: visually checked in light theme.
- Physical iPhone / Android and dark theme: NOT_RUN.

## Release
Repository: https://github.com/Sundayable/paseo-usage-remaining
Dan requested GitHub update in chat. See git history and remote for release commit.
GitHub Actions runs typecheck and regression tests on pushes and pull requests.

## Limits and next checks
This targets stable 0.8.0; early beta or 0.7 clients need an app update.
The current public docs describe a newer owned subscription API than the published
0.8.0 SDK. Keep the installed SDK contract until the app/runtime is upgraded.
Do not restart the daemon to reload this plugin; active agents must be preserved.
