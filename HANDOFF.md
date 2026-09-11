# Usage Remaining — 2026-09-11

## Current goal and result
Keep the original rich 5H/WK display while preventing ANY overlap with transcript
text or the input draft. The gray single-provider change and the subsequent
transparent overlay were rejected by Dan. The current fix addresses layout space.

## Root cause
Paseo 0.8 ComposerTrackBar is position:absolute, transparent, and assumes 32px
single-row pills. Merely expanding its icon to two lines does not reserve space.
The earlier isolated fixture omitted the surrounding transcript/absolute bar and
therefore did not test the actual overlap failure. Its PASS was insufficient.

## Implementation
- `client/web-composer.ts` validates the real ancestor structure, including the
  display:contents tooltip wrapper, before modifying any styles.
- The whole containing track becomes relative and flex-shrink:0, taking real
  height in the transcript's flex column. Its opaque theme background prevents
  bleed-through; wrapped chips and neighboring task/diff badges reserve height.
- The button retains Paseo's rounded border and opaque surface behind colored data.
- Cleanup restores all styles/attributes and is idempotent. A theme change cleans
  up and reapplies safely. Unknown geometry keeps the standard fallback.
- Provider data, credentials, drafts and application binary remain unchanged.
- Native iOS/Android still use the standard compact button + dashboard.

## Verification
- `npm run typecheck`: PASS.
- `npm test`: PASS, 11 tests including real tooltip wrapper, space reservation,
  safe fallback, cleanup and theme remount, plus registration lifecycle tests.
- `paseo plugin reload usage-remaining`: running.
- Real Mac Paseo screenshot: long finished response and footer above a separate
  framed usage panel; neighboring '6 subagents' pill and draft input stay clear.
- Updated browser fixture includes real absolute-track structure, 24 long messages,
  a final sentence, neighboring task/diff badge and preserved input draft.
- 390x844 light: tail bottom 613.06 <= bar top 629; bar bottom 732 <= input top 732.
  All providers visible; viewport/scrollWidth both 390.
- 320x568 after appending long streamed text: tail bottom 320.19 <= bar top 336;
  bar height grows to 120; input starts at 456. Viewport/scrollWidth both 320.
- 1200x850 dark: tail bottom 659.72 <= bar top 676; bar bottom/input top both 738.
  Opaque band rgb(22,24,29), reset labels and rounded frame visually verified.
- Physical iOS/Android: NOT_RUN. Do not claim native rich-layout acceptance.

## Fixture and release
Local synthetic-only browser fixture: /tmp/paseo-rich-usage-qa.nhLV48
No credentials or production API requests in the fixture.
GitHub: https://github.com/Sundayable/paseo-usage-remaining
Dan's existing GitHub-update authorization covers this corrective change.
Optional CI remains docs/ci-workflow.example.yml; OAuth lacks workflow scope.

## Future changes
Recheck transcript, footer, track, neighboring badges and draft TOGETHER on future
Paseo upgrades. Widget-only screenshots cannot prove absence of overlap.
The adapter depends on the observed 0.8.0 DOM; unknown layouts use safe fallback.
Do not restart the daemon; reload only the plugin to preserve active agents.
