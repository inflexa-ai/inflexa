# list-primitives Specification

## Purpose

The `FixedList`/`DynamicList` pure list components: query-driven fuzzy filtering, category grouping that survives filtering, cursor navigation, single/multi selection with the opencode-style indicator vocabulary, and the For/Index rendering split (reference-keyed for fixed sources, position-keyed for changing ones).

## Requirements

### Requirement: Two pure list components

The system MUST give `FixedList<T>` and `DynamicList<T>` in `src/tui/components/` as pure
list surfaces. They MUST render no dialog chrome (no `DialogPanel`) and no filter input.
They MUST NOT bind esc, because dismissal is the structural concern of the dialog host.

Both MUST consume a row as `SelectItem<T>`: `value`, `title`, and the optional
`description`, `hint`, `meta`, `prefix`, `category`, `categoryLabel`, `tone`, and `pinned`.
Both MUST share one internal core (ranking, grouping, cursor, selection, row rendering).

`prefix` renders BEFORE the title, in the secondary `fgMuted` tier, and it MUST NOT rank.
A fixed-width column that folds into `title` would score against the fuzzy filter. Thus a
query of `rwx` would match each directory of the file picker.

`prefix` MUST NOT use the recessive `fgSubtle` tier. That tier is for content whose loss
costs the user nothing. A permission triple is the one place its bits appear, because a
`tone` marks a denied read alone. Thus the column holds the 4.5:1 text floor.

`prefix` MUST NOT shrink. A short mode string reads as a DIFFERENT mode, and not as a
short one.

`tone` names a MEANING, and never a color. It MUST stay a closed union, and today it
holds `"warning"` alone. A row that could name any theme role would let a caller paint
for decoration, and the tier vocabulary would drift.

A `tone` MUST outrank the cursor highlight of the row. The user lands on a row to read it,
thus the mark that gives the reason to notice that row MUST stay.

A single component with a matrix of mode flags and chrome flags MUST NOT come back.

#### Scenario: Lists render no chrome

- **WHEN** a `FixedList` or `DynamicList` is mounted outside any dialog
- **THEN** it renders only its rows (plus empty-state/detail lines) — no panel border, no title bar, no input, and esc is not consumed by the list

#### Scenario: Shared item shape

- **WHEN** a caller maps domain data to rows
- **THEN** it produces `SelectItem<T>` values and handles selection callbacks generically over `T`

#### Scenario: A prefix does not rank

- **GIVEN** rows whose `prefix` holds a permission triple, and a row titled `data`
- **WHEN** the query is `d`
- **THEN** the `data` row ranks first, and no row ranks on its prefix

#### Scenario: A tone survives the cursor

- **GIVEN** a row that carries `tone: "warning"`
- **WHEN** the cursor lands on that row
- **THEN** the title keeps the warning color of the theme, and the cursor color does not take it

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

Both lists MUST accept an optional reactive `query` string prop, and MUST NOT own a
filter input. When `query` is empty or absent, the items render in the given order.

When `query` is not empty, the list MUST rank with the shared `rankBy`
(`src/lib/fuzzy.ts`) over weighted fields: `title` at weight 2, and the group header text
at weight 1.

The group header text is `categoryLabel` when the row carries one, and `category`
otherwise. The ranked field MUST be the text that the user can read. A caller that groups
on an opaque id would otherwise score that id, which no user types.

A row can declare `pinned`, which exempts it from that ranking. A pinned row that the
query drops MUST be appended again after the ranked matches. A pinned row that the query
matches MUST keep its earned rank, and MUST NOT appear two times.

`pinned` exists for an ESCAPE-HATCH row, which is a row whose action is "supply a value
that these rows cannot express". There the query is text that the label of the row does
not match. Thus a rank of that row would hide it at the keystroke that calls for it.
`pinned` MUST NOT give an ordinary row priority.

#### Scenario: Host owns the input

- **WHEN** a host renders a filterable list
- **THEN** the host renders its own `TextInput` and passes the typed value as `query`
- **AND** the list renders no input

#### Scenario: Ranking matches the shared scorer

- **WHEN** `query` is not empty
- **THEN** row order is `rankBy` order, and a title hit weighs 2 times a header-only hit
- **AND** an empty query keeps the input order

#### Scenario: The visible label is what ranks

- **GIVEN** rows grouped on an opaque anchor id, with a folder path as the label
- **WHEN** the query holds part of that folder path
- **THEN** those rows survive the filter, and the anchor id itself matches nothing

#### Scenario: A pinned row outlives a query nothing matches

- **WHEN** the query matches no title of a row, and no title of the pinned row
- **THEN** the pinned row is still listed, thus `emptyText` does not render
- **AND** it is the cursor row, and it is selectable
- **AND** a cleared query restores the full set, with the pinned row present one time

### Requirement: Category grouping survives filtering

Both lists MUST derive the grouped representation `[category, SelectItem<T>[]][]` from the
**ranked** rows. An uncategorized row groups under the empty key and takes no header.

`category` is the group KEY. `categoryLabel` is the header TEXT. When a row carries no
`categoryLabel`, the header text MUST be the `category` string.

A caller that groups on an opaque identity MUST use this pair. An example is the analysis
switcher, which groups on an anchor id and titles the group with the anchor folder.

Grouping happens after ranking. Thus a category whose items match in part MUST keep its
header above the items that survive. The cursor MUST index a flat projection of the
grouped tuples.

#### Scenario: One survivor keeps its header

- **WHEN** a query leaves exactly one item in a category
- **THEN** that category header renders above the single item

#### Scenario: Headers are not cursor targets

- **WHEN** the user navigates with the cursor
- **THEN** the cursor lands only on item rows, never on category headers

#### Scenario: The key and the header text are separate

- **GIVEN** two rows that carry the same `categoryLabel` and different `category` values
- **WHEN** the list groups them
- **THEN** they render as two groups, each under its own header of that same text

#### Scenario: An absent label keeps the old behavior

- **WHEN** a row carries a `category` and no `categoryLabel`
- **THEN** the header text is the `category` string

### Requirement: Cursor navigation and scroll-into-view

Both lists SHALL own cursor state and register their keys via `useDialogBindings` (auto-suspended under a stacked dialog; gated by `!dialogIsOpen()` outside one), in two layers split by the bare-printable-key rule:

- **Always-on** (safe beside a focused editor): ↑/↓, ctrl+p/ctrl+n, page-up/page-down (±10 rows), enter.
- **Bare-printable** (gated by a `bareKeysEnabled` passthrough, which hosts with a focusable filter input MUST wire to `!inputFocused`): the vim cursor keys j/k (down/up), gg (first row), G (last row) — and space-toggle in multi mode.

End-of-list behavior splits by component through a `wrapNavigation` option on the shared core:

- **`FixedList`** SHALL enable it: single-step movement (↑/↓, ctrl+p/ctrl+n, j/k) wraps between the first and last item rows — stepping down from the last row lands on the first, stepping up from the first lands on the last (modular, so a single-row list is a no-op).
- **`DynamicList`** SHALL NOT enable it: single-step movement clamps at the ends, because a source that refilters or refreshes underfoot makes a surprise jump to the far end disorienting.
- Page movement (±10 rows) SHALL clamp at the ends in BOTH lists — the deliberate "slam toward the end" gesture must land on the end, not overshoot past it — and `gg`/`G` remain absolute jumps.

The list SHALL compose `ScrollPane` with `focusOnMount={false}` (the pane is never focused) and keep the cursor row visible via `scrollChildIntoView` — a wrap jump scrolls the destination row into view exactly as `gg`/`G` do — pulling a group header into view when the cursor sits on a group's first item. The cursor SHALL clamp when filtering shrinks the set. The whole layer set SHALL also accept an `enabled` passthrough so hosts can suspend the list entirely.

#### Scenario: Navigation keys move the cursor

- **WHEN** the user presses ↓ or ctrl+n
- **THEN** the cursor moves to the next item row and scrolls into view

#### Scenario: Vim keys move the cursor when no editor is focused

- **WHEN** `bareKeysEnabled` is true (no filter input holds focus) and the user presses j, k, gg, or G
- **THEN** the cursor moves down / up / to the first row / to the last row — and when an input is focused, those keys type into it instead

#### Scenario: FixedList wraps at the bottom

- **WHEN** the cursor sits on a `FixedList`'s last item row and the user presses ↓, ctrl+n, or j
- **THEN** the cursor lands on the first item row and it scrolls into view

#### Scenario: FixedList wraps at the top

- **WHEN** the cursor sits on a `FixedList`'s first item row and the user presses ↑, ctrl+p, or k
- **THEN** the cursor lands on the last item row and it scrolls into view

#### Scenario: DynamicList clamps at the ends

- **WHEN** the cursor sits on a `DynamicList`'s last item row and the user presses ↓
- **THEN** the cursor stays on the last row — no wrap

#### Scenario: Page movement clamps everywhere

- **WHEN** the cursor is within ten rows of an end and the user presses page-down (or page-up toward the start)
- **THEN** the cursor lands on the end row in both list components, never wrapping past it

#### Scenario: Host gates the layer

- **WHEN** a host passes `enabled: () => false`
- **THEN** none of the list's bindings fire

#### Scenario: Cursor clamps on shrink

- **WHEN** the cursor is on the last row and a query removes rows below the new end
- **THEN** the cursor moves to the new last row

### Requirement: Initial cursor seeding by value

Both lists SHALL accept an optional `initialValue?: T`. At mount, the cursor SHALL seed onto the row in the flat grouped projection whose `value` strict-equals (`===`) it; when the prop is absent or no row matches, the cursor SHALL start at row 0 as before. Seeding SHALL take effect before mount-time effects run, so the first `onCursorChange` fires with the seeded row and scroll-into-view brings it (and its group header, when it starts a group) into view. The seed is mount-time only: it SHALL NOT override the existing cursor-reset behavior — a new query still moves the cursor to the best match, and a replaced `DynamicList` items array still restarts from the top.

#### Scenario: Cursor opens on the seeded row

- **WHEN** a list mounts with `initialValue` matching a row's value
- **THEN** that row is the cursor row, it is scrolled into view, and the mount-time `onCursorChange` reports it

#### Scenario: Unmatched seed falls back to row 0

- **WHEN** a list mounts with an `initialValue` no row carries
- **THEN** the cursor starts at row 0

#### Scenario: Seeding does not pin the cursor

- **WHEN** the user types a query after mounting with a seeded cursor
- **THEN** the cursor moves to the best-ranked match exactly as without seeding

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
