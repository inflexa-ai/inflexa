## Why

Every TUI input surface (chat InputBar, PromptDialog, ExportOptionsDialog, SelectList) hand-wires the same themed color props and reinvents its own keybinding setup. The user encounters inconsistent behavior across input contexts — different submit chords, different mode indicators, different visual treatments. A shared pair of input primitives eliminates the duplication, gives users a consistent interaction model everywhere they type, and makes adding new input surfaces trivial.

## What Changes

- Extract a **`TextArea`** component (`components/text_area.tsx`) wrapping opentui's `<textarea>` with themed styling, INSERT/NORMAL mode tracking, submit/newline chords, and a three-tier chrome system (`full`/`compact`/`bare`).
- Extract a **`TextInput`** component (`components/text_input.tsx`) wrapping opentui's `<input>` with themed styling and per-keystroke `onInput` for filter/search patterns. No mode concept.
- Rename `input_bar.tsx` → `chat_bar.tsx` in `layout/` — it composes `TextArea` with `chrome="full"` and adds the external INSERT/NORMAL footer row.
- Migrate **PromptDialog** to use `TextArea` with `chrome="compact"` (mode word in border title).
- Migrate **ExportOptionsDialog** to use `TextArea` with `chrome="bare"` (inside DialogPanel's own border).
- Migrate **SelectList** to use `TextInput` with `chrome="bare"`.
- Add **design gallery** entries showcasing both components in all chrome tiers and mode states.

## Capabilities

### New Capabilities
- `tui-input-primitives`: The shared TextInput and TextArea components — their props, chrome tiers, mode signaling, keybinding contracts, and visual styling.

### Modified Capabilities
- `tui-components`: New entries in the shared components directory (TextInput, TextArea join DialogPanel, SelectList, emphasis).
- `tui-layout`: `input_bar.tsx` renamed to `chat_bar.tsx`; ChatBar now composes TextArea instead of owning the raw textarea.

## Impact

- `src/tui/components/text_area.tsx` — new file
- `src/tui/components/text_input.tsx` — new file
- `src/tui/layout/input_bar.tsx` → `src/tui/layout/chat_bar.tsx` — renamed + refactored to compose TextArea
- `src/tui/components/dialog/prompt_dialog.tsx` — refactored to use TextArea
- `src/tui/components/dialog/export_options_dialog.tsx` — refactored to use TextArea
- `src/tui/components/select_list.tsx` — refactored to use TextInput
- `src/tui/layout/design_gallery.tsx` — new gallery entries
- `src/tui/app.tsx` — import path update (InputBar → ChatBar)
- No new dependencies. No API changes. No database changes.
