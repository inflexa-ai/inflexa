# Design: retry-the-capture-at-the-viewport

## Context

`capturePage` (`src/lib/page-capture.ts:102-149`) navigates, settles, and screenshots with `fullPage: true`. The screenshot call throws a protocol error when the compositor cannot hold the full-page bitmap. Today that throw ends the capture, the eyes tool maps it onto `capture-failed`, and no seen stamp lands. The record then refuses with `never-seen` forever on that environment.

## Decisions

### D1: The retry sits inside `capturePage`, not in the eyes tool

The capture module owns the screenshot mechanics, and both capture callers get the same degradation. The eyes tool keeps its one job: map the capture onto the typed look result.

### D2: One retry, viewport alone, same page instance

The page already navigated and settled, thus the retry reuses it and costs one screenshot call. The retry drops `fullPage` and captures the window: 1440 by 900, the reader viewport. A second failure propagates as today, because a viewport bitmap that also fails names a broken browser and not a tall page.

### D3: `coverage` is a required field with two values

`PageCapture.coverage` is `"full" | "viewport"`. Required, because an optional flag invites a caller that forgets the partial case. The two capture callers compile against the new field, and the change is internal to the package, thus no consumer migration exists.

### D4: A viewport look counts as a look

The look-before-record rule asks that the agent saw the current document. A viewport picture is a true picture of that document, thus the seen stamp lands. The tool result names the coverage, and the agent judges what it saw. The alternative — refusing the stamp — would rebuild the exact deadlock that this change removes.

## Risks / Trade-offs

- A viewport look shows the top window alone, thus a below-fold defect can pass the look. The coverage marker makes that visible to the agent, and the environment fix of the embedder makes the case rare.
