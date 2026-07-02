# select-dialog Specification

## Purpose

The reusable picker dialog composing `DialogPanel` + filter `TextInput` + `FixedList` — the dialog form of the list primitives, serving every "choose one of these" command.

## Requirements

### Requirement: SelectDialog composes panel, input, and FixedList

The system SHALL provide `SelectDialog<T>` in `src/tui/components/dialog/` (it is a content dialog — it lives with the dialog family, not beside the pure list primitives): a `DialogPanel` containing a filter `TextInput` (`chrome="bare"`, registered via `useDialogEntry().setInitialFocus` so the host applies focus on push and reveal) and a `FixedList` receiving the input's value as `query`. It SHALL accept `title`, `placeholder`, `items`, `emptyText`, optional `grouped` rendering, `mode` (`single` default), `initialSelected` (multi), `onSelect` (single) / `onConfirm` (multi), and `onCancel` wired through `useDialogCancel`. Its footer hints SHALL be derived from shared chord definitions via `chordLabel`, never hand-written key text, and SHALL reflect the mode (single: move/select/cancel; multi: toggle/confirm/cancel plus selection count).

#### Scenario: Single-select picker parity

- **WHEN** a picker renders `SelectDialog` with items and `onSelect`
- **THEN** the filter input has focus on open, typing filters with headers preserved, ↑/↓ + ctrl+p/n move, enter selects-and-submits, and esc cancels via the dialog host

#### Scenario: Multi mode surfaces the batch flow

- **WHEN** `SelectDialog` renders with `mode="multi"`
- **THEN** rows show the ●/○ gutter, enter calls `onConfirm` with the selected values, and the footer shows the selection count

#### Scenario: Footer labels are derived

- **WHEN** the footer hints render
- **THEN** every key label comes from `chordLabel` over the shared chord definitions

### Requirement: SelectDialog replaces SelectList at every call site

All current `SelectList` consumers — the theme, analysis, session, project (set/list/delete), and input pickers in `src/tui/commands.tsx`, and the `CommandPalette` adapter — SHALL render `SelectDialog` instead. `src/tui/components/select_list.tsx` SHALL be deleted, with no compatibility shim or re-export left behind.

#### Scenario: Call sites migrate

- **WHEN** any picker command runs after the change
- **THEN** it opens a `SelectDialog` with unchanged observable behavior (title, placeholder, filtering, selection, cancel)

#### Scenario: SelectList is gone

- **WHEN** the codebase is searched for `SelectList` or `select_list.tsx`
- **THEN** no source references remain
