## Why

`SelectList` uses Solid's `<For>` inside an opentui scrollbox, which silently drops rows when the filtered array shrinks then grows (the `insertBefore` DOM operation the scrollbox doesn't support). The file picker already works around this with `<Index>`, but SelectList carries the same latent bug. Meanwhile, multi-select behavior (gutter markers, space-to-toggle, confirm-with-count) is hand-built inside FilePicker — duplicating rendering logic that belongs in the shared list widget.

## What Changes

- Switch `SelectList`'s scrollbox rendering from `<For>` to `<Index>`, fixing the latent filter-then-clear row-drop bug.
- Add a `mode` prop to `SelectList`: `"single"` (current pick-one-and-done), `"multi"` (gutter toggles, space to toggle, explicit confirm), `"radio"` (single tracked selection with explicit confirm). Each mode drives the gutter column, keyboard behavior, and footer hints.
- Extract the selection gutter, toggle logic, and confirm/cancel flow from `FilePicker` into `SelectList`'s multi mode.
- Slim `FilePicker` to own only filesystem chrome (breadcrumbs, cwd, dir navigation, hidden toggle, INSERT/NORMAL modes) and delegate list rendering + selection to `SelectList` in `"multi"` mode.
- Update all existing `SelectList` consumers (command palette, theme picker, analysis/session switchers, file picker review mode) — no behavior change for single-mode callers.

## Capabilities

### New Capabilities

- `select-list-modes`: Selection mode system for `SelectList` — single, multi, and radio modes with mode-driven gutter, keyboard, and confirm behavior.

### Modified Capabilities

- `tui-components`: `SelectList` switches from `<For>` to `<Index>`, gains a `mode` prop and selection state management. `FilePicker` delegates its list rendering to `SelectList` in multi mode.

## Impact

- `src/tui/components/select_list.tsx` — core changes: `<Index>`, mode prop, selection gutter, toggle/confirm keyboard.
- `src/tui/components/file_picker.tsx` — slimmed: filesystem chrome stays, list rendering + selection gutter replaced by `SelectList` multi-mode usage.
- `src/tui/components/command_palette.tsx` — trivial: explicit `mode="single"` or rely on default.
- `src/tui/commands.tsx` — trivial: same as above for ThemePicker, SwitchAnalysis, SwitchSession dialogs.
- `src/tui/components/file_picker.test.tsx` — update assertions if gutter rendering changes.
- No new dependencies. No API changes outside `src/tui/components/`.
