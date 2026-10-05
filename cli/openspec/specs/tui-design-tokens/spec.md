# tui-design-tokens Specification

## Purpose
The named layout tokens of the TUI in `src/lib/design_system.ts`: the spacing, the sizes, the strokes, and the dialog size presets. Each layout prop in `src/tui/` reads a token, not a raw number or string. Thus one edit of a token changes each place that uses it.

## Requirements

### Requirement: Named layout, spacing, and stroke tokens

The system SHALL provide three `as const` objects with derived literal-union types — `space`, `size`, `stroke` — in the dependency-light, solid-js-free design-system module `src/lib/design_system.ts`, the single source of truth for non-color layout primitives:

- `space` — spacing counted in terminal cells: `none: 0` (tight pairs, marker│text), `sm: 1` (rows within a block), `md: 2` (between blocks and panels), `lg: 4` (rare major breaks).
- `size` — fixed structural dimensions in cells/rows: `gutter: 2` (the marker column), `statusBar: 1` (row height), `railWidth: 40` (sidebar/rail columns), `composerMin: 1` (grows with input), `paletteRows: 12` (visible before scroll), `breakpointWide: 120` (terminal columns at/above which wide-terminal layouts engage — a calibration value, tunable).
- `stroke` — border roles mapped to opentui `borderStyle`: `panel: "single"`, `overlay: "rounded"`, `focus: "heavy"`, `danger: "double"`.

Each object SHALL be `as const`, and the module SHALL export the union types `Space = keyof typeof space` and `Stroke = keyof typeof stroke`. `railWidth` SHALL be `40` (the existing tuned value), not the design doc's example `30`. `breakpointWide` is the single wide-terminal threshold: any component that places content responsively by terminal width (e.g. the status bar's workspace-path segment vs the sidebar's path line) SHALL compare against this token, never an inline column count, so every responsive surface flips at the same width.

#### Scenario: Tokens are literal-typed constants

- **WHEN** a component imports `space`, `size`, or `stroke`
- **THEN** each value is a literal type (e.g. `space.md` is `2`, not `number`) and the `Space`/`Stroke` union types name the available keys

#### Scenario: A single source for layout primitives

- **WHEN** a developer needs the rail width, gutter width, status-bar height, or a border style
- **THEN** it is read from `size`/`stroke` in `design_system.ts`, defined once

#### Scenario: Responsive placement reads the breakpoint token

- **WHEN** a component decides between a wide-terminal and a narrow-terminal placement
- **THEN** it compares the terminal width against `size.breakpointWide`, not an inline number, and all such surfaces flip at the same threshold

### Requirement: Layout props use tokens, not raw integers

Layout components in `src/tui/` SHALL source spacing (`gap`, `padding*`, `margin*`), fixed dimensions (rail width, status-bar height, gutter, composer min/max height), and `borderStyle` from `design_system.ts` rather than inline integer or string literals. A raw integer in a spacing prop SHALL be replaced by a `space.*` value; a structural dimension by a `size.*` value; a `borderStyle` by a `stroke.*` value. Pre-existing inline values (e.g. the sidebar width `40`, input `minHeight`/`maxHeight`, section paddings) SHALL be refactored to the corresponding token.

#### Scenario: Spacing references a token

- **WHEN** a layout box sets `gap` or `padding`
- **THEN** the value is a `space.*` token, not a raw integer literal

#### Scenario: Structural dimension references a token

- **WHEN** the sidebar sets its width or the status bar its height
- **THEN** it uses `size.railWidth` / `size.statusBar`, not an inline number

### Requirement: Dialog size presets use clamped fixed dimensions; only static-content dialogs are content-height

`src/lib/design_system.ts` MUST define the dialog size presets (`dialogSize`, keys `md`, `lg`,
and `xl`) as fixed column widths with a percentage clamp, and never as a pair of percentages.

Each preset MUST carry a fixed `width` in columns, which is a calibration value that you can
tune: `md: 64`, `lg: 108`, and `xl: 116`. Each preset MUST carry a `maxWidth` clamp of `90%`.
Thus a panel becomes smaller on a narrow terminal, and it never grows on a wide one.

`lg` MUST hold a row that carries facts beside its name. A file entry spends about 35 columns
on its permissions, its size, and its date. A picker that then truncates the names defeats its
own purpose.

A height obeys the same fixed-and-clamp shape, for each tier whose content changes while the
dialog is open. `lg` (a picker, whose list filters) MUST fix its height at `28` rows, with a
`maxHeight` clamp of `80%`. That leaves about 20 rows for the list after the chrome of the
panel, which is a working set and not a keyhole. `xl` MUST fix its height at `85%`.

A panel that resizes as its content changes is worse than trailing empty rows.

Only `md` MUST be content-height (`height: undefined`, `maxHeight: 80%`). Its content is a
prompt line or a confirm message, and that content is static for the life of the dialog.

No preset MUST pair a percentage width with a percentage height. A terminal cell is about 2
times taller than it is wide. Thus a pair of percentages gives a square panel or a portrait
panel, whose proportions track the terminal instead of the content.

A test of these dimensions MUST read them from `dialogSize`, and MUST NOT restate the numbers.
A duplicated number turns each legitimate change of the calibration into a red test. It also
proves nothing about the fixed-against-fraction behavior that the test claims.

#### Scenario: Wide terminal does not balloon a prompt

- **WHEN** an `md` dialog renders on a 250-column terminal
- **THEN** its panel is 64 columns wide, and not a percentage of the terminal width

#### Scenario: Narrow terminal clamps instead of overflowing

- **WHEN** an `md` dialog renders on a 60-column terminal
- **THEN** its panel width is the clamp of 90% of the terminal, and not the fixed 64 columns

#### Scenario: A wide terminal gives the fixed width

- **WHEN** an `lg` panel renders on a 200-column terminal
- **THEN** it measures the `width` of the preset, and not a fraction of 200

#### Scenario: A narrow terminal gives the clamp

- **WHEN** an `lg` panel renders on a 40-column terminal
- **THEN** it measures 36 columns, which is the `maxWidth` clamp

#### Scenario: Filtering never resizes a picker

- **WHEN** a filter reduces a picker from 30 rows to 2 rows
- **THEN** the panel holds the `height` of the preset, with trailing empty rows

#### Scenario: Short prompt shrinks to its content

- **WHEN** the static body of an `md` dialog is shorter than its `maxHeight`
- **THEN** the panel is only as tall as its content, with no fixed-height empty region below it

#### Scenario: Fixed height clamps on short terminals

- **WHEN** an `lg` panel renders on a 15-row terminal
- **THEN** it measures 12 rows or fewer, and its chrome stays complete
