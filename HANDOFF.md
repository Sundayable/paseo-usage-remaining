# Usage Remaining — 2026-09-11

## Goal and state
Restore the ORIGINAL rich 5H/WK usage display, including all provider logos,
colored percentages, reset countdowns and refresh. The preceding compact gray
provider-only fix was rejected by Dan. Original UI recovered from commit 755f745.

## Implementation
- `client/usage.tsx`: restores original UsagePill and GroupHeader, mounted through
  a custom icon component on the stable 0.8 button API.
- `client/web-composer.ts`: web-only compatibility adapter expands our direct
  icon slot and enclosing button, hides duplicate label, restores styles and
  accessibility state on cleanup; fails closed on a changed host structure.
- `client/registry.ts`: retains 0.8 registration lifecycle and accepts custom icon.
- Provider fetchers and credentials are unchanged. No Paseo app patch/restart.
- Native iOS/Android retain the compact provider-specific fallback + full dashboard.

## Verification
- `npm run typecheck`: PASS against pinned 0.8.0 SDK.
- `npm test`: PASS, 8 lifecycle/label/error/DOM-adapter regression tests.
- `paseo plugin reload usage-remaining` and plugin status: running.
- Actual Mac app: original two rows, provider logos, green/red percentages,
  reset times and refresh visible; not a gray provider-only pill.
- Isolated browser fixture uses the actual plugin component with synthetic usage
  and the observed host button structure. At 390px: all six available rows fit,
  document scrollWidth equals viewport width; reset labels hidden as designed.
- Browser fixture at 1200px with dark theme: color/contrast and reset labels pass.
- Inline refresh starts the 2-minute cooldown without opening the dashboard;
  clicking the usage body opens the dashboard. Both checked in browser fixture.
- Actual physical iOS/Android app: NOT_RUN; rich inline adapter is web-only.

## QA fixture
Temporary local-only harness: /tmp/paseo-rich-usage-qa.nhLV48
No credentials or production API calls. Synthetic fixture values only.

## GitHub
https://github.com/Sundayable/paseo-usage-remaining
Dan's earlier instruction to update GitHub remains in scope for the corrected UI.
The optional CI workflow is docs/ci-workflow.example.yml because the current
GitHub OAuth login lacks workflow scope. CI is not active; local checks pass.

## Risks
The web compatibility adapter uses the observed direct-parent structure because
Paseo 0.8 removed arbitrary composer components. A future host layout change may
fall back to the standard button. Recheck after Paseo upgrades. SDK types remain
pinned to actual stable 0.8.0; current online docs include newer subscription APIs.
