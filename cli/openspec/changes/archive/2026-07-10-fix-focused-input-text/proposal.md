## Why

On light themes, text typed into a focused editor (INSERT mode) is unreadable: opentui's `TextareaRenderable` (and `InputRenderable`, which extends it) keeps separate focused/unfocused text colors, the `textColor` setter updates only the unfocused one, and the focused color keeps its construction default — `#FFFFFF` — painting white text on the light `bgActive` band. Blurred (NORMAL mode) text is legible because it uses the themed `textColor`. This is the same defect family `theme-contrast-aa` eliminated for blocks; the input primitives' themed color contract simply never listed `focusedTextColor`, so the leak survived the audit.

## What Changes

- `TextArea` and `TextInput` pass `focusedTextColor` (theme `fg`, or `fgMuted` while busy — mirroring their `textColor` expression) so INSERT-mode text renders themed in both palette modes.
- The `tui-input-primitives` themed color contract gains `focusedTextColor`, closing the spec omission.
- A regression render test asserts focused-editor text renders in the theme `fg` (not white) under a light theme.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `tui-input-primitives`: the themed color contract for `TextArea`/`TextInput` additionally requires `focusedTextColor` from the theme, with a scenario pinning INSERT-mode readability on light themes.

## Impact

- `src/tui/components/text_area.tsx`, `src/tui/components/text_input.tsx` — one prop each.
- New regression assertions beside the existing theme-contrast render tests.
- No palette, token, or dependency changes; the contrast matrix already enforces `fg` on `bgActive`.
