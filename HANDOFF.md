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
- Native iOS/Android now open MobileUsageSheet using the supported popover API.
  The host owns sheet scrolling/safe areas; shared UsageContent avoids nested scroll
  containers. Cards show provider names and a single reset label; narrow headers
  stack above a 44px refresh button. Refresh failures retain values and show errors.

## Verification
- `npm run typecheck`: PASS.
- `npm test`: PASS, 12 tests including real tooltip wrapper, space reservation,
  safe fallback, cleanup and theme remount, plus registration lifecycle and native sheet registration tests.
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

## Mobile follow-up verification
- Native-selected component rendered with React Native Web and synthetic data:
  320x568 light, 390x844 dark. This is browser component QA, not a native app run.
- 320px sheet content width/scrollWidth 305/305 (15px browser scrollbar), scroll
  height 754 in 440px host fixture. Last card bottom 552 <= viewport bottom 568.
- Provider names Claude, Fable, Codex, Grok, Cursor and all six limits present.
- Refresh height 44px; click enters disabled shared 2:00 cooldown.
- Simulated refresh failure shows error while retaining the last good percentages.
- Final web regression: 320px tail bottom 320.06 <= bar top 336; bar bottom/input
  top 456. 1200px dark tail 659.72 <= bar 676; bar bottom/input 738. No horizontal
  overflow. Desktop keeps the original colored two-row display.
- No booted simulator or connected device was listed by simctl/devicectl.
  Physical iOS/Android remains NOT_RUN; relay client version alone is not evidence.
- Current user authorization: “뭐 다 하고 깃허브까지 마무리 짓고”.

## Corrected native inline requirement and physical iPhone verification
Dan clarified that a gray provider button plus sheet was NOT the requested fix.
The original colored logos and ALL available limits must stay visible above input.

- Added client/native-composer.ts. It validates the current Fabric host ancestry,
  expands only the owned native icon slot/button, hides its redundant host label,
  and changes the shared track to normal nonshrinking layout with opaque background.
- Native adapter relies on internal host handles. Unknown shapes remain unchanged;
  cleanup restores styles; partial failure rolls back even if a node unmounts.
- Native sheet content has its own maxHeight min(440, screen height * 0.6): the host
  alone did not cap measured height and its title rose under the physical notch.
- npm run typecheck PASS; npm test PASS 16. Reload running without restarting daemon.
- PHYSICAL IPHONE PASS through iPhone Mirroring, 2026-09-11 ~17:12–17:14 Vancouver:
  colored 5H/WK strip always visible above input, all available provider logos and
  percentages. App background/re-entry and plugin reload retained it.
- Actual final values observed: Claude 5H 78%, Claude WK 93%, Fable 91%, Codex 85%,
  Grok 0%, Cursor 80%. Dynamic values are not fixed acceptance targets.
- Transcript and input remain separate from the strip. Input focus tested without
  typing; Mirroring suppresses the software keyboard, so expanded keyboard NOT_RUN.
- Tap opened the bounded sheet; scroll reached Cursor; dismiss restored inline view.
  Manual refresh/cooldown verified on physical iPhone earlier in this same run.
- Android and native dark mode NOT_RUN. Prior statements that physical iOS was
  unavailable are superseded by this actual physical-device verification.
- Temporary native diagnostic text was removed; no credentials/log data exposed.

## 2026-09-11 later: left-aligned strip and hidden host diff badge
Dan's phone screenshot showed the two rows centered inside the pill (equal ~33pt
gutters) and asked to drop Paseo's own `+928 -45` git badge from the composer.

- Cause of the gutter: Paseo's plugin icon slot style is
  `{width:16,height:16,alignItems:'center',justifyContent:'center',overflow:'hidden'}`.
  Once the adapter widens that slot, its `alignItems:'center'` centers our rows.
  `client/native-composer.ts` now also patches `alignItems:'flex-start'`, so the
  rows start at the button's own text edge. Cleanup restores `center`.
- The diff badge is the host's `testID="composer-diff-stat-pill"` (0.8 renders it
  from `useVisibleWorkspaceDiffStat`; there is no user setting). The native adapter
  hides that node with `display:'none'`. It mounts only while the workspace has
  changes and re-renders on every count change, so a 400ms timer re-applies the
  style when `canonical.currentProps` identity changes and rescans the track every
  5 ticks to catch mount/unmount/remount. Cleanup clears the timer and restores it.
- Scope: native only. Desktop/web keep the diff badge; the web slot is width:auto
  and already left-aligned, so `web-composer.ts` is unchanged.
- A missing or unpatchable badge never blocks the usage strip.

### Verification
- `npx tsc --noEmit`: PASS. `npm test`: PASS, 19 tests (3 new: hide+restore,
  re-render/remount re-hide, missing badge stays harmless).
- `paseo plugin reload usage-remaining`: running.
- Physical iPhone: NOT_RUN. iPhone Mirroring reports "iPhone in Use"; the device
  must be locked before the mirrored check can run. Do not claim visual acceptance
  until the phone shows the rows flush left and no `+/-` badge.
