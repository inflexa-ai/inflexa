# Rework select lists into pure list primitives + file picker

## Why

`SelectList` fuses dialog chrome, the filter input, fuzzy ranking, navigation, and selection into one monolith — it drops category headers the moment a query is typed, and it cannot serve a multi-select host (the file picker) without the prop-flag sprawl the stashed rework attempt demonstrated. The file-picker branch needs pure, composable list primitives whose rendering strategy follows Solid's list-rendering model (`<For>` for stable references, `<Index>` for positionally-updating content), now that the opentui 0.4.2 bump makes `<For>` inside a scrollbox safe (verified by repro; see `HORRIBLE_BUG_FIXES.md` entry 1).

## What Changes

- **New list primitives** `FixedList<T>` and `DynamicList<T>` — lists and nothing else: no dialog chrome, no filter input. Hosts pass a reactive `query` string down; the lists rank with the existing `rankBy` (title 2×, category 1×), then derive the opencode-style grouped representation `[category, items[]][]` so category headers **survive filtering**. Lists own ScrollPane composition, cursor navigation, selection state, and submit.
  - `FixedList`: takes a `readonly` items array, reads it **once at mount** (the enforceable form of "immutable reference"), renders with `<For>` — stable references make filtering reuse rows.
  - `DynamicList`: takes reactive items (sources that mint fresh objects per update, e.g. directory listings), renders with `<Index>` — positional slots update in place instead of full row teardown.
- **Selection modes** `single | multi` on both lists. Single: enter selects-and-submits, cursor row keeps the `>` chevron. Multi: space toggles a ●/○ gutter, enter confirms the batch; hosts can gate the space binding while a filter input is focused. **BREAKING (internal):** the previously specced `radio` mode is dropped — no caller exists; multi covers it.
- **New `SelectDialog`** — the thin DialogPanel + TextInput + FixedList composition that keeps the existing picker call sites (themes, analyses, sessions, projects, inputs, palette) one-liners.
- **New `FilePicker`** built on `DynamicList`: directory browsing with breadcrumb, synthetic `..` row, dirs-first listing, hidden-file toggle, INSERT/NORMAL keyboard modes, selection review, seeded selection, `requireSelection`, absolute-path confirm — functionally per the stashed picker, wired into the new-analysis and add-inputs flows.
- **`SelectList` is deleted. BREAKING (internal):** all seven call sites migrate to `SelectDialog`/the new primitives.
- **Rendering-contract regression sentinel**: a render test covering the `<For>`-inside-scrollbox reuse path (shrink-then-grow, reorder, grouped fragments) so future `@opentui/*` bumps re-verify the fixed 0.4.0 row-drop bug.
- Design gallery exhibits for every new widget/state.

## Capabilities

### New Capabilities

- `list-primitives`: the `FixedList`/`DynamicList` components — query-driven filtering, grouped representation, navigation, selection/submit contracts, and the For/Index rendering split.
- `select-dialog`: the reusable single/multi select dialog composing DialogPanel + TextInput + FixedList; the migration target for every current `SelectList` call site.
- `file-picker`: the multi-select file browser on `DynamicList`, plus its command wiring (new analysis, add inputs).

### Modified Capabilities

- `select-list-modes`: superseded in full — `SelectList` and its `mode`/`radio`/`onAction`/Index-only requirements are removed; behavior moves to `list-primitives` (modes, For/Index contract) and `select-dialog`.
- `tui-components`: the `SelectList` and `FilePicker` requirements are rewritten to the new component set (`FixedList`, `DynamicList`, `SelectDialog`, `FilePicker`); filter-input ownership moves from the list to its hosts.
- `scroll-pane`: the cursor-driven host enumeration changes from `SelectList` to the new list primitives (same `focusOnMount={false}` + `scrollChildIntoView` contract).
- `fuzzy-scoring`: the named ranking consumer changes from "`SelectList`'s row ranking" to the list primitives' ranking (scorer contract itself unchanged).

## Impact

- `cli/src/tui/components/`: `select_list.tsx` removed; `fixed_list.tsx`, `dynamic_list.tsx`, `select_dialog.tsx`, `file_picker.tsx` added (shared list core colocated per the multi-caller rule).
- `cli/src/tui/commands.tsx` (6 picker call sites) and `cli/src/tui/components/command_palette.tsx` migrate to `SelectDialog`.
- New-analysis / add-inputs command flows adopt `FilePicker`; input-change events for sidebar refresh (bus + `types/events.ts` + `db/primary_mutation.ts`, per the stashed wiring).
- Tests: render tests for both primitives and the picker; the For/scrollbox regression sentinel; existing dialog-host render tests that mount `SelectList` update to the new components.
- No new dependencies; `@opentui/core` stays at 0.4.2 (the `<For>` reuse path is verified against exactly this version).
