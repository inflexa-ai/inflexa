# tui-components — delta

## MODIFIED Requirements

### Requirement: Relocated dialog widgets compose DialogPanel without behavior change

`SelectDialog` (with `SelectItem`; its fuzzy ranking is delegated through the list primitives to the shared `rankBy` in `src/lib/fuzzy.ts`, called with a title-2×/category-1 weighted field list — no scorer or ranker is defined in the component), `PromptDialog`, and `ResultsDialog` SHALL live in `src/tui/components/`, each in its own file, and SHALL render their body through `DialogPanel`. Their observable behavior — filtering/ranking, navigation keys, submit/cancel/close keys, focus-on-mount, empty-state messages, and footer hint text — SHALL follow the `select-dialog` capability for `SelectDialog` and remain unchanged for `PromptDialog`/`ResultsDialog`.

`SelectDialog` SHALL delegate list rendering, navigation, and selection to `FixedList` (see the `list-primitives` capability) and SHALL own the filter `TextInput`, passing its value down as the list's `query`. The highlighted-row description line renders inside the list body (above the footer) per `list-primitives`.

`FilePicker` SHALL delegate its list rendering and selection management to `DynamicList` in `"multi"` mode, retaining only filesystem-specific concerns: cwd/breadcrumb signals, directory navigation, INSERT/NORMAL keyboard modes, hidden-file toggle, review mode, and open-in-explorer. `FilePicker` SHALL use `onAction` to intercept enter on directory rows for navigation instead of confirm.

`SelectDialog` SHALL use the shared `TextInput` component (with `chrome="bare"`) for its filter input instead of a raw opentui `<input>` element. `PromptDialog` SHALL select its text-entry primitive with a `multiline` prop: when `multiline` is false (the default), it SHALL render the shared `TextInput` component (`chrome="bare"` — the dialog panel border is the sole chrome) with enter-to-submit and NO newline chord; when `multiline` is true, it SHALL render the shared `TextArea` component (`chrome="bare"`) with the submit/newline chords and `height` semantics intact. In neither case SHALL an INSERT/NORMAL mode word appear inside a modal dialog. `ExportOptionsDialog` SHALL use the shared `TextArea` component (with `chrome="bare"`) for its optional text field instead of a raw opentui `<textarea>` element.

`ResultsDialog` SHALL render its line list inside a `ScrollPane` (see the `scroll-pane` capability) instead of a raw focused `<scrollbox>`, inheriting the canonical scroll key set (`gg`/`G`/`j`/`k`/arrows/`ctrl+d`/`ctrl+u`/page/home/end at ScrollPane step sizes). Its footer hint SHALL describe the scroll keys from the shared chord definitions (via `chordLabel`), not hand-written key text.

#### Scenario: SelectDialog single-mode behavior

- **WHEN** a caller renders `SelectDialog` from `src/tui/components/select_dialog.tsx` without a `mode` prop
- **THEN** fuzzy filtering (headers preserved), Up/Down + Ctrl+P/Ctrl+N navigation, Enter-to-select, Esc-to-cancel, and the grouped/empty-state rendering behave per the `select-dialog` capability

#### Scenario: DynamicList multi-mode used by FilePicker

- **WHEN** `FilePicker` renders its file listing
- **THEN** it uses `DynamicList` with `mode="multi"`, passing filesystem rows as reactive items and using `onAction` to handle directory navigation on enter

#### Scenario: Rendering strategy follows the list primitives

- **WHEN** `SelectDialog` or `FilePicker` renders list rows inside the scroll surface
- **THEN** the underlying primitive applies its specced strategy — `<For>` in `FixedList` (stable references), `<Index>` in `DynamicList` (positional updates)

#### Scenario: SelectDialog uses TextInput

- **WHEN** `SelectDialog` renders its filter input
- **THEN** it uses the shared `TextInput` component with `chrome="bare"`, not a raw opentui `<input>`

#### Scenario: Single-line prompt uses TextInput

- **WHEN** `PromptDialog` renders without `multiline` (the default)
- **THEN** it renders the shared `TextInput` (`chrome="bare"`): enter submits, no key inserts a newline, no second border, and no mode word is shown

#### Scenario: Multiline prompt opts into TextArea

- **WHEN** `PromptDialog` renders with `multiline` set
- **THEN** it renders the shared `TextArea` (`chrome="bare"`) with the submit chord, the newline chord, and the `height` prop honored

#### Scenario: ExportOptionsDialog uses TextArea

- **WHEN** `ExportOptionsDialog` renders its optional text field
- **THEN** it uses the shared `TextArea` component with `chrome="bare"`, not a raw opentui `<textarea>`

#### Scenario: PromptDialog and ResultsDialog relocated

- **WHEN** a caller needs a single-line prompt or a read-only results list
- **THEN** it imports `PromptDialog` / `ResultsDialog` from `src/tui/components/`, and Enter-submit / Esc-cancel and Esc-q-Enter-close behave exactly as before

#### Scenario: ResultsDialog scrolls via ScrollPane

- **WHEN** `ResultsDialog` is open with more lines than fit the viewport
- **THEN** `gg`/`G`/`j`/`k`/arrows/page keys scroll the list at ScrollPane step sizes, and the footer hint text is derived from the shared chord definitions

#### Scenario: Footer hints reflect the dialog mode

- **WHEN** `SelectDialog` renders in single or multi mode
- **THEN** its footer shows mode-appropriate hints (single: move/select/cancel; multi: toggle/confirm/cancel plus selection count), all labels derived via `chordLabel`
