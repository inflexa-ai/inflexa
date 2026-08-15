## Why

In the first real session the eyes returned a screenshot with clipped metric cards, and the agent reported a clean layout. The look happened, and the judgment missed a visible defect. The page also animates in on scroll, thus a capture can catch content mid-fade.

## What Changes

- The examination guidance names the concrete faults of a look: clipped text, a truncated number, an overflowing card, a raw column name on an axis, and an unreadable precision.
- The capture settles the animation before the screenshot, through reduced-motion emulation. The print form respects the same preference already.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-session-agent`: the prompt obligations gain the fault checklist of the look.
- `report-verification`: the eyes-tool requirement gains the settled capture.

## Impact

- `harness/src/prompts/report-session.ts` — the checklist joins the look step.
- `harness/src/lib/page-capture.ts` — the reduced-motion emulation before the navigation.
- No contract change, no tool-surface change, and no store change.
