## MODIFIED Requirements

### Requirement: Relocated dialog widgets compose DialogPanel without behavior change

`SelectList` (with `SelectItem`; its fuzzy ranking is delegated to the shared `rankBy` in `src/lib/fuzzy.ts`, called with a title-2×/category-1 weighted field list — no scorer or ranker is defined in the component), `PromptDialog`, and `ResultsDialog` SHALL live in `src/tui/components/`, each in its own file, and SHALL render their body through `DialogPanel`. Their observable behavior — filtering/ranking, navigation keys, submit/cancel/close keys, focus-on-mount, empty-state messages, and footer hint text — SHALL be unchanged from before the move.

`SelectList` SHALL support a `mode` prop (`"single" | "multi" | "radio"`) that drives its gutter column, keyboard behavior, and footer hints (see the `select-list-modes` capability). In `"single"` mode (the default), behavior SHALL be identical to the pre-change implementation. `SelectList` SHALL render its scrollbox children using `<Index>` (not `<For>`) to avoid the opentui scrollbox `insertBefore` bug. `SelectList` SHALL keep its highlighted-row description line inside its own body (above the footer).

`FilePicker` SHALL delegate its list rendering and selection management to `SelectList` in `"multi"` mode, retaining only filesystem-specific concerns: cwd/breadcrumb signals, directory navigation, INSERT/NORMAL keyboard modes, hidden-file toggle, review mode, and open-in-explorer. `FilePicker` SHALL use `onAction` to intercept enter on directory rows for navigation instead of confirm.

#### Scenario: SelectList single-mode behavior preserved

- **WHEN** a caller renders `SelectList` from `src/tui/components/select_list.tsx` without a `mode` prop
- **THEN** fuzzy filtering, Up/Down + Ctrl+P/Ctrl+N navigation, Enter-to-select, Esc-to-cancel, and the grouped/empty-state rendering behave exactly as before

#### Scenario: SelectList multi-mode used by FilePicker

- **WHEN** `FilePicker` renders its file listing
- **THEN** it uses `SelectList` with `mode="multi"`, passing filesystem rows as items and using `onAction` to handle directory navigation on enter

#### Scenario: SelectList scrollbox uses Index

- **WHEN** `SelectList` renders its list rows inside the scrollbox
- **THEN** it uses `<Index>` (position-keyed) instead of `<For>` (reference-keyed), preventing silent row drops on filter-then-clear

#### Scenario: PromptDialog and ResultsDialog relocated

- **WHEN** a caller needs a single-line prompt or a read-only results list
- **THEN** it imports `PromptDialog` / `ResultsDialog` from `src/tui/components/`, and Enter-submit / Esc-cancel and scroll / Esc-q-Enter-close behave exactly as before

#### Scenario: Footer hints unchanged for single mode

- **WHEN** `SelectList` renders in single mode
- **THEN** its footer hint text matches the pre-change text verbatim

#### Scenario: Footer hints reflect mode in multi/radio

- **WHEN** `SelectList` renders in multi or radio mode
- **THEN** its footer shows mode-appropriate hints (space to toggle, enter to confirm, selection count)
