## ADDED Requirements

### Requirement: SelectList selection mode prop

`SelectList` SHALL accept a `mode` prop of type `"single" | "multi" | "radio"`, defaulting to `"single"`. The mode SHALL drive three aspects of the widget: the gutter column, the keyboard behavior for space/enter, and the footer hint text. All three modes SHALL share the same fuzzy filtering, cursor navigation, scrollbox rendering, and empty-state behavior.

#### Scenario: Default mode is single

- **WHEN** a caller renders `SelectList` without a `mode` prop
- **THEN** the widget behaves identically to the pre-change single-select behavior (enter picks, no gutter, no confirm step)

#### Scenario: Mode prop is typed

- **WHEN** a caller passes `mode="multi"` or `mode="radio"`
- **THEN** TypeScript accepts the value; any other string is a type error

### Requirement: Single mode behavior

In `"single"` mode, `SelectList` SHALL behave as the current implementation: pressing enter on the highlighted row calls `onSelect(value)`. There SHALL be no gutter column, no selection state, and no explicit confirm step. Esc calls `onCancel()`.

#### Scenario: Enter picks and dismisses

- **WHEN** the user presses enter in single mode
- **THEN** `onSelect` is called with the highlighted item's value

#### Scenario: No gutter in single mode

- **WHEN** `SelectList` renders in single mode
- **THEN** no selection markers (○/●) appear in the row rendering

### Requirement: Multi mode behavior

In `"multi"` mode, `SelectList` SHALL display a gutter column with ○ (unselected) and ● (selected) markers. Space SHALL toggle the highlighted row's selection. Enter SHALL call `onConfirm(selectedValues)` with the current selection as an array. Esc SHALL call `onCancel()`. The footer hints SHALL reflect the multi-mode keys (space to toggle, enter to confirm, esc to cancel) and the current selection count.

#### Scenario: Space toggles selection

- **WHEN** the user presses space on a highlighted row in multi mode
- **THEN** the row's selection state toggles (○ → ● or ● → ○) and the selection count in the footer updates

#### Scenario: Enter confirms with selection

- **WHEN** the user presses enter in multi mode
- **THEN** `onConfirm` is called with an array of all selected items' values

#### Scenario: Gutter markers render

- **WHEN** `SelectList` renders in multi mode
- **THEN** each row shows ○ or ● in a gutter column based on its selection state

#### Scenario: Footer shows selection count

- **WHEN** 3 items are selected in multi mode
- **THEN** the footer includes "3 selected"

### Requirement: Radio mode behavior

In `"radio"` mode, `SelectList` SHALL display a gutter column with ○ (unselected) and ● (selected) markers. At most one row SHALL be selected at a time. Space or enter on a row SHALL select it (deselecting the previous selection). Enter SHALL also call `onConfirm([selectedValue])` with the single selected value. Esc SHALL call `onCancel()`.

#### Scenario: Space selects and deselects previous

- **WHEN** item A is selected and the user presses space on item B in radio mode
- **THEN** item A becomes ○ and item B becomes ●

#### Scenario: Enter selects and confirms

- **WHEN** the user presses enter on a row in radio mode
- **THEN** that row is selected (deselecting any previous) and `onConfirm` is called with the single value

#### Scenario: Only one selected at a time

- **WHEN** the user toggles through multiple rows in radio mode
- **THEN** at most one row shows the ● marker at any time

### Requirement: Multi/radio initial selection

In `"multi"` and `"radio"` modes, `SelectList` SHALL accept an optional `initialSelected` prop of type `ReadonlySet<T>`. When provided, the matching items SHALL render as pre-selected (●) on mount. When omitted, the selection starts empty.

#### Scenario: Pre-selected items render with filled marker

- **WHEN** `initialSelected` contains values matching two items
- **THEN** those two rows show ● on mount; all others show ○

#### Scenario: Empty initial selection

- **WHEN** `initialSelected` is omitted
- **THEN** all rows show ○ on mount

### Requirement: Action callback for enter-overloading

`SelectList` SHALL accept an optional `onAction?: (value: T) => boolean` callback. In multi and radio modes, when the user presses enter, `SelectList` SHALL call `onAction(highlightedValue)` first. If `onAction` returns `true`, the enter is treated as handled and the default confirm behavior is suppressed. If `onAction` returns `false` or is not provided, the default confirm runs.

#### Scenario: Caller intercepts enter

- **WHEN** `onAction` is provided and returns `true` for a highlighted item
- **THEN** `onConfirm` is NOT called; the caller handled the action (e.g. directory navigation)

#### Scenario: Caller does not intercept

- **WHEN** `onAction` is not provided or returns `false`
- **THEN** the default confirm behavior runs (calling `onConfirm`)

### Requirement: SelectList uses Index inside scrollbox

`SelectList` SHALL render its scrollbox children using Solid's `<Index>` component (position-keyed), NOT `<For>` (reference-keyed). This prevents the opentui scrollbox bug where `<For>`'s `insertBefore` DOM operations silently drop rows when the filtered array shrinks then grows.

**Caveat (opentui + Solid `<For>` in scrollbox):** Solid's `<For>` tracks children by reference and uses `insertBefore` DOM operations to reorder/reinsert them when the source array changes. opentui's scrollbox does NOT support `insertBefore` — it silently drops children that go through that path, producing "Anchor with id ... does not exist within the parent scroll-box-content, skipping insertBefore" warnings and a list with fewer visible rows than expected. This manifests whenever the filtered array shrinks then grows (e.g. the user types a filter character then deletes it — the restored rows are lost). The fix is `<Index>` (position-keyed), which never reorders — it adds/removes at the end and updates existing slots in place. This caveat applies to ALL opentui scrollbox usage, not just SelectList — any component rendering a reactive array inside a `<scrollbox>` SHALL use `<Index>`, not `<For>`.

#### Scenario: Filter then clear restores all rows

- **WHEN** the user types a filter character that hides some rows, then deletes it
- **THEN** all original rows reappear — none are silently dropped

#### Scenario: Index accessor pattern

- **WHEN** the row render body accesses item data inside `<Index>`
- **THEN** it reads from the accessor (`item()`) since `<Index>` provides `Accessor<T>` per slot
