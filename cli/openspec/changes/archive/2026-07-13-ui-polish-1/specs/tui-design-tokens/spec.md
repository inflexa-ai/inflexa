## MODIFIED Requirements

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
