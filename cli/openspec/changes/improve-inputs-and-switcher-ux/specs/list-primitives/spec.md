## MODIFIED Requirements

### Requirement: Two pure list components

The system MUST give `FixedList<T>` and `DynamicList<T>` in `src/tui/components/` as pure
list surfaces. They MUST render no dialog chrome (no `DialogPanel`) and no filter input.
They MUST NOT bind esc, because dismissal is the structural concern of the dialog host.

Both MUST consume a row as `SelectItem<T>`: `value`, `title`, and the optional
`description`, `hint`, `meta`, `category`, `categoryLabel`, `tone`, and `pinned`. Both
MUST share one internal core (ranking, grouping, cursor, selection, row rendering).

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

#### Scenario: A tone survives the cursor

- **GIVEN** a row that carries `tone: "warning"`
- **WHEN** the cursor lands on that row
- **THEN** the title keeps the warning color of the theme, and the cursor color does not take it

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
