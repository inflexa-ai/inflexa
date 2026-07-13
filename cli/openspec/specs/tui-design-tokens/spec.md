# tui-design-tokens Specification

## Purpose
TBD - created by archiving change inflexa-design-system. Update Purpose after archive.
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

`src/lib/design_system.ts` SHALL define the dialog size presets (`dialogSize`, keys `md`/`lg`/`xl`) as fixed column widths clamped by a percentage, not paired percentages: each preset SHALL carry a fixed `width` in columns (`md: 64`, `lg: 88`, `xl: 116` — calibration values, tunable) and a `maxWidth` percentage clamp (`90%`) so panels shrink on narrow terminals but never balloon on wide ones. Heights follow the same fixed+clamp shape for tiers whose content changes while the dialog is open: `lg` (pickers, whose lists filter) SHALL fix its height in rows (`20`, clamped by `maxHeight: 80%`) and `xl` SHALL fix its height (`85%`) — a panel that resizes as its content changes mid-interaction is worse UX than trailing empty rows. Only `md` SHALL be content-height (`height: undefined`, `maxHeight: 80%`), because its content (a prompt line, a confirm message) is static for the dialog's lifetime. No preset SHALL pair a percentage width with a percentage height, because terminal cells are ~2× taller than wide and paired percentages render square-or-portrait panels whose proportions track the terminal's instead of the content's.

#### Scenario: Wide terminal does not balloon a prompt

- **WHEN** an `md` dialog renders on a 250-column terminal
- **THEN** its panel is 64 columns wide, not a percentage of the terminal width

#### Scenario: Narrow terminal clamps instead of overflowing

- **WHEN** an `md` dialog renders on a 60-column terminal
- **THEN** its panel width is clamped to 90% of the terminal, not the fixed 64 columns

#### Scenario: Filtering never resizes a picker

- **WHEN** an `lg` picker's list is filtered from many rows down to a few
- **THEN** the panel height does not change — overflow scrolls, shortfall leaves empty rows

#### Scenario: Short prompt shrinks to its content

- **WHEN** an `md` dialog's static body is shorter than its `maxHeight` allows
- **THEN** the panel is only as tall as its content — no fixed-height empty region below it

#### Scenario: Fixed height clamps on short terminals

- **WHEN** an `lg` dialog renders on a terminal shorter than its fixed row height allows
- **THEN** the panel height is clamped to the `maxHeight` percentage and the body scrolls

