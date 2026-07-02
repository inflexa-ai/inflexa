## MODIFIED Requirements

### Requirement: Relocated dialog widgets compose DialogPanel without behavior change

`SelectList` (with `SelectItem`; its fuzzy ranking is delegated to the shared `rankBy` in `src/lib/fuzzy.ts`, called with a title-2×/category-1 weighted field list — no scorer or ranker is defined in the component), `PromptDialog`, and `ResultsDialog` SHALL live in `src/tui/components/`, each in its own file, and SHALL render their body through `DialogPanel`. Their observable behavior — filtering/ranking, navigation keys, submit/cancel/close keys, focus-on-mount, empty-state messages, and footer hint text — SHALL be unchanged from before the move.

`SelectList` SHALL support a `mode` prop (`"single" | "multi" | "radio"`) that drives its gutter column, keyboard behavior, and footer hints (see the `select-list-modes` capability). In `"single"` mode (the default), behavior SHALL be identical to the pre-change implementation. `SelectList` SHALL render its scrollbox children using `<Index>` (not `<For>`) to avoid the opentui scrollbox `insertBefore` bug. `SelectList` SHALL keep its highlighted-row description line inside its own body (above the footer).

`FilePicker` SHALL delegate its list rendering and selection management to `SelectList` in `"multi"` mode, retaining only filesystem-specific concerns: cwd/breadcrumb signals, directory navigation, INSERT/NORMAL keyboard modes, hidden-file toggle, review mode, and open-in-explorer. `FilePicker` SHALL use `onAction` to intercept enter on directory rows for navigation instead of confirm.

`SelectList` SHALL use the shared `TextInput` component (with `chrome="bare"`) for its filter input instead of a raw opentui `<input>` element. `PromptDialog` SHALL use the shared `TextArea` component (with `chrome="compact"`) for its text entry instead of a raw opentui `<textarea>` element. `ExportOptionsDialog` SHALL use the shared `TextArea` component (with `chrome="bare"`) for its optional text field instead of a raw opentui `<textarea>` element.

`ResultsDialog` SHALL render its line list inside a `ScrollPane` (see the `scroll-pane` capability) instead of a raw focused `<scrollbox>`, inheriting the canonical scroll key set (`gg`/`G`/`j`/`k`/arrows/`ctrl+d`/`ctrl+u`/page/home/end at ScrollPane step sizes). Its footer hint SHALL describe the scroll keys from the shared chord definitions (via `chordLabel`), not hand-written key text.

#### Scenario: SelectList single-mode behavior preserved

- **WHEN** a caller renders `SelectList` from `src/tui/components/select_list.tsx` without a `mode` prop
- **THEN** fuzzy filtering, Up/Down + Ctrl+P/Ctrl+N navigation, Enter-to-select, Esc-to-cancel, and the grouped/empty-state rendering behave exactly as before

#### Scenario: SelectList multi-mode used by FilePicker

- **WHEN** `FilePicker` renders its file listing
- **THEN** it uses `SelectList` with `mode="multi"`, passing filesystem rows as items and using `onAction` to handle directory navigation on enter

#### Scenario: SelectList scrollbox uses Index

- **WHEN** `SelectList` renders its list rows inside the scrollbox
- **THEN** it uses `<Index>` (position-keyed) instead of `<For>` (reference-keyed), preventing silent row drops on filter-then-clear

#### Scenario: SelectList uses TextInput

- **WHEN** `SelectList` renders its filter input
- **THEN** it uses the shared `TextInput` component with `chrome="bare"`, not a raw opentui `<input>`

#### Scenario: PromptDialog uses TextArea

- **WHEN** `PromptDialog` renders its text entry
- **THEN** it uses the shared `TextArea` component with `chrome="compact"`, not a raw opentui `<textarea>`

#### Scenario: ExportOptionsDialog uses TextArea

- **WHEN** `ExportOptionsDialog` renders its optional text field
- **THEN** it uses the shared `TextArea` component with `chrome="bare"`, not a raw opentui `<textarea>`

#### Scenario: PromptDialog and ResultsDialog relocated

- **WHEN** a caller needs a single-line prompt or a read-only results list
- **THEN** it imports `PromptDialog` / `ResultsDialog` from `src/tui/components/`, and Enter-submit / Esc-cancel and Esc-q-Enter-close behave exactly as before

#### Scenario: ResultsDialog scrolls via ScrollPane

- **WHEN** `ResultsDialog` is open with more lines than fit the viewport
- **THEN** `gg`/`G`/`j`/`k`/arrows/page keys scroll the list at ScrollPane step sizes, and the footer hint text is derived from the shared chord definitions

#### Scenario: Footer hints unchanged for single mode

- **WHEN** `SelectList` renders in single mode
- **THEN** its footer hint text matches the pre-change text verbatim

#### Scenario: Footer hints reflect mode in multi/radio

- **WHEN** `SelectList` renders in multi or radio mode
- **THEN** its footer shows mode-appropriate hints (space to toggle, enter to confirm, selection count)
