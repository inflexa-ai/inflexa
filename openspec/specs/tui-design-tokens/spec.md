# tui-design-tokens Specification

## Purpose
TBD - created by archiving change inf-design-system. Update Purpose after archive.
## Requirements
### Requirement: Named layout, spacing, and stroke tokens

The system SHALL provide three `as const` objects with derived literal-union types — `space`, `size`, `stroke` — in the dependency-light, solid-js-free design-system module `src/lib/design_system.ts`, the single source of truth for non-color layout primitives:

- `space` — spacing counted in terminal cells: `none: 0` (tight pairs, marker│text), `sm: 1` (rows within a block), `md: 2` (between blocks and panels), `lg: 4` (rare major breaks).
- `size` — fixed structural dimensions in cells/rows: `gutter: 2` (the marker column), `statusBar: 1` (row height), `railWidth: 40` (sidebar/rail columns), `composerMin: 1` (grows with input), `paletteRows: 12` (visible before scroll).
- `stroke` — border roles mapped to opentui `borderStyle`: `panel: "single"`, `overlay: "rounded"`, `focus: "heavy"`, `danger: "double"`.

Each object SHALL be `as const`, and the module SHALL export the union types `Space = keyof typeof space` and `Stroke = keyof typeof stroke`. `railWidth` SHALL be `40` (the existing tuned value), not the design doc's example `30`.

#### Scenario: Tokens are literal-typed constants

- **WHEN** a component imports `space`, `size`, or `stroke`
- **THEN** each value is a literal type (e.g. `space.md` is `2`, not `number`) and the `Space`/`Stroke` union types name the available keys

#### Scenario: A single source for layout primitives

- **WHEN** a developer needs the rail width, gutter width, status-bar height, or a border style
- **THEN** it is read from `size`/`stroke` in `design_system.ts`, defined once

### Requirement: Layout props use tokens, not raw integers

Layout components in `src/tui/` SHALL source spacing (`gap`, `padding*`, `margin*`), fixed dimensions (rail width, status-bar height, gutter, composer min/max height), and `borderStyle` from `design_system.ts` rather than inline integer or string literals. A raw integer in a spacing prop SHALL be replaced by a `space.*` value; a structural dimension by a `size.*` value; a `borderStyle` by a `stroke.*` value. Pre-existing inline values (e.g. the sidebar width `40`, input `minHeight`/`maxHeight`, section paddings) SHALL be refactored to the corresponding token.

#### Scenario: Spacing references a token

- **WHEN** a layout box sets `gap` or `padding`
- **THEN** the value is a `space.*` token, not a raw integer literal

#### Scenario: Structural dimension references a token

- **WHEN** the sidebar sets its width or the status bar its height
- **THEN** it uses `size.railWidth` / `size.statusBar`, not an inline number

