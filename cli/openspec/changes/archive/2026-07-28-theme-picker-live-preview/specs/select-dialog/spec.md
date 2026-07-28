## MODIFIED Requirements

### Requirement: SelectDialog composes panel, input, and FixedList

The system SHALL provide `SelectDialog<T>` in `src/tui/components/dialog/` (it is a content dialog — it lives with the dialog family, not beside the pure list primitives): a `DialogPanel` containing a filter `TextInput` (`chrome="bare"`, registered via `useDialogEntry().setInitialFocus` so the host applies focus on push and reveal) and a `FixedList` receiving the input's value as `query`. It SHALL accept `title`, `placeholder`, `items`, `emptyText`, optional `grouped` rendering, `mode` (`single` default), `initialSelected` (multi), `initialValue` (forwarded to the list as the mount-time cursor seed), `onSelect` (single) / `onConfirm` (multi), `onCursorChange` (forwarded to the list's cursor callback, so a host can react to the highlighted row — e.g. the theme picker's live preview), and `onCancel` wired through `useDialogCancel`. Its footer hints SHALL be derived from shared chord definitions via `chordLabel`, never hand-written key text, and SHALL reflect the mode (single: move/select/cancel; multi: toggle/confirm/cancel plus selection count).

#### Scenario: Single-select picker parity

- **WHEN** a picker renders `SelectDialog` with items and `onSelect`
- **THEN** the filter input has focus on open, typing filters with headers preserved, ↑/↓ + ctrl+p/n move, enter selects-and-submits, and esc cancels via the dialog host

#### Scenario: Multi mode surfaces the batch flow

- **WHEN** `SelectDialog` renders with `mode="multi"`
- **THEN** rows show the ●/○ gutter, enter calls `onConfirm` with the selected values, and the footer shows the selection count

#### Scenario: Footer labels are derived

- **WHEN** the footer hints render
- **THEN** every key label comes from `chordLabel` over the shared chord definitions

#### Scenario: Cursor callback and initial cursor forward to the list

- **WHEN** a host passes `onCursorChange` and `initialValue` to `SelectDialog`
- **THEN** the list opens with the cursor on the row whose value strict-equals `initialValue`, and every cursor move (including filter-driven moves and the list emptying) reaches the host's `onCursorChange`
