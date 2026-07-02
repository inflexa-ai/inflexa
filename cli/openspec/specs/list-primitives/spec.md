# list-primitives Specification

## Purpose

The `FixedList`/`DynamicList` pure list components: query-driven fuzzy filtering, category grouping that survives filtering, cursor navigation, single/multi selection with the opencode-style indicator vocabulary, and the For/Index rendering split (reference-keyed for fixed sources, position-keyed for changing ones).

## Requirements

### Requirement: Two pure list components

The system SHALL provide `FixedList<T>` and `DynamicList<T>` in `src/tui/components/` as pure list surfaces: they SHALL render no dialog chrome (no `DialogPanel`), no filter input, and SHALL NOT bind esc (dismissal is the dialog host's structural concern). Both SHALL consume rows as `SelectItem<T>` (`value`, `title`, optional `description`, `hint`, `category`) and share one internal core (ranking, grouping, cursor, selection, row rendering) colocated with them. A single component with a mode/chrome flag matrix SHALL NOT be reintroduced.

#### Scenario: Lists render no chrome

- **WHEN** a `FixedList` or `DynamicList` is mounted outside any dialog
- **THEN** it renders only its rows (plus empty-state/detail lines) — no panel border, no title bar, no input, and esc is not consumed by the list

#### Scenario: Shared item shape

- **WHEN** a caller maps domain data to rows
- **THEN** it produces `SelectItem<T>` values and handles selection callbacks generically over `T`

### Requirement: FixedList reads an immutable items reference once

`FixedList` SHALL type its items as `readonly Readonly<SelectItem<T>>[]` and SHALL read the prop exactly once at mount (a deliberate non-reactive read): replacing the array later SHALL have no effect. This read-once contract is what licenses reference-keyed rendering — item references are stable for the component's lifetime.

#### Scenario: Mutation is a type error

- **WHEN** code attempts `items.push(...)` or assignment through the `items` prop type
- **THEN** TypeScript rejects it

#### Scenario: Replacement is inert

- **WHEN** the host swaps in a different items array after mount
- **THEN** the rendered list is unchanged; hosts with changing data use `DynamicList`

### Requirement: FixedList renders rows with For

`FixedList` SHALL render its rows with Solid's `<For>` (reference-keyed): filtering produces subsets/reorders of stable references, so surviving rows are reused and moved, never re-created. This is verified safe against `@opentui/core` 0.4.2 (on 0.4.0 the scrollbox `insertBefore` path silently dropped re-inserted rows — see `HORRIBLE_BUG_FIXES.md` entry 1).

#### Scenario: Filter then clear restores all rows

- **WHEN** the user types a query that hides rows, then clears it
- **THEN** every original row is visible again — none silently dropped

### Requirement: DynamicList renders reactive items with Index

`DynamicList` SHALL read its `items` prop reactively and SHALL render rows with Solid's `<Index>` (position-keyed): sources that mint fresh objects per update (e.g. directory listings) update positional slots in place instead of tearing down every row. Slot bodies SHALL read reactive data through accessors (`item()`, thunked derivations), never captured plain values.

#### Scenario: Items replacement updates in place

- **WHEN** the host replaces `items` with a same-length array of fresh objects
- **THEN** existing row slots update their content; no full unmount/remount of every row

#### Scenario: Accessor discipline

- **WHEN** a row body renders cursor/selection state
- **THEN** it reads via accessor functions so `<Index>` slots track updates

### Requirement: Query-driven filtering

Both lists SHALL accept an optional reactive `query` string prop and SHALL NOT own a filter input. When `query` is empty or absent, items render in the given order. When non-empty, the list SHALL rank with the shared `rankBy` (`src/lib/fuzzy.ts`) over weighted fields: `title` at weight 2, `category` at weight 1.

#### Scenario: Host owns the input

- **WHEN** a host renders a filterable list
- **THEN** the host renders its own `TextInput` and passes the typed value as `query`; the list renders no input

#### Scenario: Ranking matches the shared scorer

- **WHEN** `query` is non-empty
- **THEN** row order is `rankBy` order (title hits weighted 2× over category-only hits); an empty query preserves input order

### Requirement: Category grouping survives filtering

Both lists SHALL derive the grouped representation `[category, SelectItem<T>[]][]` from the **ranked** rows (group headers emitted from the tuples, uncategorized rows grouped under the empty key with no header). Because grouping happens after ranking, a category whose items partially match SHALL keep its header above the surviving items. The cursor SHALL index a flat projection of the grouped tuples.

#### Scenario: One survivor keeps its header

- **WHEN** a query leaves exactly one item in a category
- **THEN** that category header renders above the single item

#### Scenario: Headers are not cursor targets

- **WHEN** the user navigates with the cursor
- **THEN** the cursor lands only on item rows, never on category headers

### Requirement: Cursor navigation and scroll-into-view

Both lists SHALL own cursor state and register their keys via `useDialogBindings` (auto-suspended under a stacked dialog; gated by `!dialogIsOpen()` outside one), in two layers split by the bare-printable-key rule:

- **Always-on** (safe beside a focused editor): ↑/↓, ctrl+p/ctrl+n, page-up/page-down (±10 rows), enter.
- **Bare-printable** (gated by a `bareKeysEnabled` passthrough, which hosts with a focusable filter input MUST wire to `!inputFocused`): the vim cursor keys j/k (down/up), gg (first row), G (last row) — and space-toggle in multi mode.

The list SHALL compose `ScrollPane` with `focusOnMount={false}` (the pane is never focused) and keep the cursor row visible via `scrollChildIntoView`, pulling a group header into view when the cursor sits on a group's first item. The cursor SHALL clamp when filtering shrinks the set. The whole layer set SHALL also accept an `enabled` passthrough so hosts can suspend the list entirely.

#### Scenario: Navigation keys move the cursor

- **WHEN** the user presses ↓ or ctrl+n
- **THEN** the cursor moves to the next item row and scrolls into view

#### Scenario: Vim keys move the cursor when no editor is focused

- **WHEN** `bareKeysEnabled` is true (no filter input holds focus) and the user presses j, k, gg, or G
- **THEN** the cursor moves down / up / to the first row / to the last row — and when an input is focused, those keys type into it instead

#### Scenario: Host gates the layer

- **WHEN** a host passes `enabled: () => false`
- **THEN** none of the list's bindings fire

#### Scenario: Cursor clamps on shrink

- **WHEN** the cursor is on the last row and a query removes rows below the new end
- **THEN** the cursor moves to the new last row

### Requirement: Selection modes single and multi

Both lists SHALL accept `mode?: "single" | "multi"` (default `"single"`).

- **single**: enter SHALL call `onSelect(value)` for the cursor row — select-and-submit in one stroke. No gutter, no selection state. The cursor row SHALL render the `>` chevron indicator (`GLYPHS.chevronRight`) with the `bgActive` row background.
- **multi**: each row SHALL render a gutter of `GLYPHS.circle` (●, selected) / `GLYPHS.circleHollow` (○, unselected); space SHALL toggle the cursor row; enter SHALL call `onConfirm(values)` with the selected values — including when no rows are visible (an empty filter result or listing must not strand a batch accumulated elsewhere). An optional `initialSelected: ReadonlySet<T>` SHALL seed the selection. An optional `onAction?: (value: T) => boolean` SHALL run before the default enter behavior — returning `true` suppresses it (e.g. directory navigation). An optional `canToggle?: (value: T) => boolean` SHALL veto toggling a specific value (a navigation-only row like `..`); a row it refuses SHALL render a blank gutter (neither ● nor ○) even when its value sits in the selection set, since a selected-looking row that space refuses to clear would misreport what confirm hands back. An optional `onCursorChange?: (value: T | undefined) => void` SHALL notify hosts of the cursor row so host-side keys (open-in-explorer) can act on it.

There SHALL be no `radio` mode.

#### Scenario: Single-mode enter selects and submits

- **WHEN** the user presses enter in single mode
- **THEN** `onSelect` fires with the cursor row's value; no separate confirm step exists

#### Scenario: Multi-mode space toggles, enter confirms

- **WHEN** the user toggles two rows with space and presses enter
- **THEN** both rows showed ● after toggling and `onConfirm` receives exactly those two values

#### Scenario: Seeded selection renders filled markers

- **WHEN** `initialSelected` matches two rows at mount
- **THEN** those rows render ● and all others ○

#### Scenario: onAction intercepts enter

- **WHEN** `onAction` returns `true` for the cursor row
- **THEN** neither `onSelect` nor `onConfirm` fires for that press

#### Scenario: Empty listing still confirms the batch

- **WHEN** two rows are selected, a filter then matches nothing, and the user presses enter
- **THEN** `onConfirm` receives both selected values

#### Scenario: A non-toggleable row shows no gutter

- **WHEN** `canToggle` refuses a row whose value happens to be in the selection set
- **THEN** the row renders a blank gutter — not ●, not ○

### Requirement: Empty state and detail line

Both lists SHALL render an `emptyText` fallback when no rows survive filtering (hosts MAY substitute an error text). When the cursor row has a `description`, the list SHALL render it as a bottom detail line inside a full-width painted box (per the scrollbox-overlap rule — a bare `<text>` under a `flexGrow` scrollbox leaks bled content).

#### Scenario: Empty state

- **WHEN** the query matches nothing
- **THEN** the list renders `emptyText` in muted color instead of rows

#### Scenario: Detail line is painted full-width

- **WHEN** the cursor row has a `description`
- **THEN** it renders below the scroll area in a full-width box with an opaque background

### Requirement: For-in-scrollbox regression sentinel

The change SHALL add a render test (headless `testRender` + `captureCharFrame`) exercising `<For>` inside a `<scrollbox>` through: shrink-then-grow with stable references, reordered subsets, and grouped tuples rendering fragments with nested `<For>` — asserting every row present and zero `insertBefore` warnings. The test exists so a future `@opentui/*` bump that regresses the 0.4.0 row-drop bug fails loudly.

#### Scenario: Sentinel guards the reuse path

- **WHEN** the sentinel runs against the installed `@opentui/core`
- **THEN** all rows render after each mutation and no `skipping insertBefore` warning is emitted
