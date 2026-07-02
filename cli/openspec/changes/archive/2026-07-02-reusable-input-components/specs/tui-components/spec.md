## MODIFIED Requirements

### Requirement: Relocated dialog widgets compose DialogPanel without behavior change

`SelectList` (with `SelectItem`; its fuzzy ranking is delegated to the shared `rankBy` in `src/lib/fuzzy.ts`, called with a title-2×/category-1 weighted field list — no scorer or ranker is defined in the component), `PromptDialog`, and `ResultsDialog` SHALL live in `src/tui/components/`, each in its own file, and SHALL render their body through `DialogPanel`. Their observable behavior — filtering/ranking, navigation keys, submit/cancel/close keys, focus-on-mount, empty-state messages, and footer hint text — SHALL be unchanged from before the move. `SelectList` SHALL keep its highlighted-row description line inside its own body (above the footer).

`SelectList` SHALL use the shared `TextInput` component (with `chrome="bare"`) for its filter input instead of a raw opentui `<input>` element. `PromptDialog` SHALL use the shared `TextArea` component (with `chrome="compact"`) for its text entry instead of a raw opentui `<textarea>` element. `ExportOptionsDialog` SHALL use the shared `TextArea` component (with `chrome="bare"`) for its optional text field instead of a raw opentui `<textarea>` element.

#### Scenario: SelectList behavior preserved

- **WHEN** a caller renders `SelectList` from `src/tui/components/select_list.tsx`
- **THEN** fuzzy filtering, Up/Down + Ctrl+P/Ctrl+N navigation, Enter-to-select, Esc-to-cancel, and the grouped/empty-state rendering behave exactly as before

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
- **THEN** it imports `PromptDialog` / `ResultsDialog` from `src/tui/components/`, and Enter-submit / Esc-cancel and scroll / Esc-q-Enter-close behave exactly as before

#### Scenario: Footer hints unchanged

- **WHEN** any of the three dialogs renders
- **THEN** its footer hint text matches the pre-refactor text verbatim
