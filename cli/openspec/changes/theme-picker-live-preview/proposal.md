# Theme picker live preview

## Why

Picking a theme in the chat TUI is select → exit → reopen for every candidate (issue [#245](https://github.com/inflexa-ai/inflexa/issues/245)): the palette's "Change theme" picker applies a theme only on select, so comparing themes means committing each one. The `inflexa config` screen already solves this — moving the highlight previews the theme live and a discard reverts it — and the maintainer's response on the issue commits to bringing the same behavior to the main theme picker in the app.

## What Changes

- The palette "Change theme" picker (`ThemePicker` in `src/tui/commands.tsx`) previews the highlighted theme **immediately** as the cursor moves — the whole running render root recolors, dialog included — matching the config screen's behavior.
- Any non-commit close (esc, click-outside, ctrl+c) **reverts** the live theme to the persisted one; only selecting a row persists via `writeConfig`.
- Filtering participates in the preview: the cursor's move to the best match previews that theme, and a filter that matches nothing reverts the preview to the persisted theme until rows return.
- The picker opens with the cursor **on the currently-persisted theme**, not row 0 — without this, opening the dialog would instantly flash to the first listed theme.
- `SelectDialog` forwards the list's existing `onCursorChange` callback and a new `initialValue` prop to its `FixedList`.
- The list primitives (`ListCore` behind `FixedList`/`DynamicList`) gain mount-time cursor seeding by value (`initialValue`); absent or unmatched values keep today's row-0 start.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `theme-system`: the chat TUI's palette theme picker gains live preview on highlight, revert on non-commit close, and opens on the persisted theme — the config screen's preview contract extended to the second switch surface.
- `select-dialog`: the accepted prop surface grows by `onCursorChange` (forwarded to the list) and `initialValue` (initial cursor row by value).
- `list-primitives`: both lists accept an optional `initialValue` that seeds the mount-time cursor onto the row carrying that value.

## Impact

- `src/tui/commands.tsx` — `ThemePicker` wires preview/revert/seed; no new command surface.
- `src/tui/components/dialog/select_dialog.tsx` — two forwarded props.
- `src/tui/components/list_core.tsx` (+ the `FixedList`/`DynamicList` prop docs) — initial-cursor seeding.
- Tests: list-primitive/select-dialog render tests for cursor seeding; theme picker preview/revert behavior.
- No config schema change, no new dependencies, no CLI command surface change (agent command policy untouched).
