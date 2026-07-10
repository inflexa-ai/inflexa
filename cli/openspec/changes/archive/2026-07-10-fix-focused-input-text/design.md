## Context

`TextareaRenderable` holds `_unfocusedTextColor` and `_focusedTextColor`; `updateColors()` picks by focus state. The `set textColor` accessor writes only `_unfocusedTextColor`, and `@opentui/solid` applies JSX props through setters after construction — so a `<textarea>`/`<input>` given only `textColor` keeps `defaults.focusedTextColor = "#FFFFFF"` for its focused state (verified in `@opentui/core` 0.4.2). `text_area.tsx` and `text_input.tsx` pass `textColor`/`focusedBackgroundColor` but not `focusedTextColor`.

## Goals / Non-Goals

**Goals:** INSERT-mode text readable in every built-in theme; the input primitives' color contract names every color the renderable can paint text with.

**Non-Goals:** No palette changes (the `fg`-on-`bgActive` pair already passes the contrast matrix); no changes to placeholder or cursor behavior (the busy-state hidden cursor stays intentional).

## Decisions

- Mirror the existing `textColor` expression exactly (`props.busy ? theme().fgMuted : theme().fg`) for `focusedTextColor`, rather than always `fg`: a busy editor keeps its dimmed reading in both focus states, and the two props can never drift apart semantically.
- Assert the regression at the rendered-span level (the `captureSpans()` idiom from `theme_contrast.render.test.tsx`) rather than on props, so a future opentui change to the focused/unfocused split fails the test too.

## Risks / Trade-offs

- [opentui may later make `textColor` also seed the focused color] → harmless; the explicit prop stays correct and the render test keeps passing.
