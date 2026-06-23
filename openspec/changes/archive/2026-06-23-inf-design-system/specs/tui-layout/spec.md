## MODIFIED Requirements

### Requirement: Toggleable four-section sidebar

`Sidebar` SHALL render four sections in fixed order — SESSION, CONTEXT, ANALYSIS, RUNS — as a fixed-width, full-height column with a divider against the chat column. Its width SHALL be sourced from `size.railWidth` (the design-tokens layer), NOT an inline integer, and it is NOT mouse-resizable. SESSION SHALL show the short session id (`S·` + the first 4 hex of the id), the session age as a relative duration (e.g. `6m ago`), and the message count from live data. ANALYSIS SHALL show the analysis name, the anchor path with a ✓/⚠ badge derived from the anchor's `markerWritten`, the input count, and the project name when the analysis has one. CONTEXT (tokens · % · cost) and RUNS (live/completed rows) SHALL render values from the mock data models supplied by the `tui-mock-data` capability; that data SHALL be identifiable as mock/sample (sourced from the named mock module, never presented as live telemetry), and the sidebar MUST NOT display values fabricated inline at the render site. The sidebar's data SHALL update when the open analysis or session changes (an in-place `openSession` swap).

#### Scenario: Real data for SESSION and ANALYSIS

- **WHEN** the sidebar renders for an open analysis
- **THEN** SESSION shows id/age/message-count and ANALYSIS shows name, anchor path, inputs, and project from live queries

#### Scenario: Anchor badge reflects marker state

- **WHEN** the analysis's anchor has `markerWritten = false`
- **THEN** the ANALYSIS section shows the ⚠ badge rather than ✓

#### Scenario: CONTEXT and RUNS render mock data from the mock module

- **WHEN** the sidebar renders CONTEXT and RUNS
- **THEN** they show token/cost and run rows from the `tui-mock-data` fixtures (not inline-fabricated values), and the source is the named mock module

#### Scenario: Sidebar width comes from a token

- **WHEN** the sidebar is rendered
- **THEN** its column width is `size.railWidth`, not a raw integer literal

#### Scenario: Sidebar follows an in-place switch

- **WHEN** the user switches to a different analysis via the palette
- **THEN** the sidebar's SESSION and ANALYSIS sections update to the new analysis without a process restart

### Requirement: Layout composition kit directory

The system SHALL house the chat TUI's Direction-B app-shell composition kit under `src/tui/layout/`, one component per file with no barrel/index re-exports — today `status_bar.tsx`, `message_block.tsx`, `input_bar.tsx`, and `sidebar.tsx`. (The gutter marker set is NOT a shell-composition part; it is design-system vocabulary and lives in `src/lib/design_system.ts` so the `components/` block widgets may import it — see the "Shared gutter marker set" requirement.) A `layout/` part MAY be single-caller and MAY import domain types/queries (`src/types/`, `src/db/`, `src/modules/`), because it is structural app-shell composition rather than a reusable domain-agnostic widget. This is a deliberate, scoped exception to the "don't extract single-caller sub-components" rule, and `CLAUDE.md`'s Project-structure section SHALL document `src/tui/layout/` and this exception. `layout/` components MUST NOT be imported by `src/modules/` (presentation depends on logic, never the reverse).

#### Scenario: Kit part lives in layout/

- **WHEN** a part composes the chat shell (status bar, message block, input bar, or sidebar)
- **THEN** it resides in `src/tui/layout/` as its own file, imported directly by its caller

#### Scenario: Single-caller, domain-coupled part is allowed

- **WHEN** a `layout/` part is composed by only `app.tsx` and imports domain types or db queries
- **THEN** it still belongs in `layout/` (the single-caller and components/-membership rules do not apply to the shell kit)

### Requirement: Shared gutter marker set

The system SHALL define the gutter marker set as a shared constant (`MARKERS`) in `src/lib/design_system.ts` (the merged design-system module — solid-js-free, importable by both the shell and the `components/` block widgets without a components→layout dependency) — one entry per kind: `you >`, `assistant <`, `thinking ◆`, `tool ▸`, `run ●`, `fileEdit ✎`, `ok ✓`, `error ✗` — each mapping to its glyph and an existing `ThemeColors` role (the `thinking` and `tool` kinds use the dedicated `thinking`/`tool` roles; `run` uses `warning`). The set is the single source for every block's marker: `MessageBlock` (shell) reads `you`/`assistant`, and the `components/` block widgets read the rest.

#### Scenario: Message block reads the marker set

- **WHEN** a user or assistant turn renders
- **THEN** its gutter marker glyph and color come from the shared marker set in `src/lib/design_system.ts`, not an inline literal

#### Scenario: Block widgets read the marker set

- **WHEN** a thinking / tool / run / file-edit / error block widget renders
- **THEN** its marker glyph and role come from the shared set, imported from the tui root (no components→layout import)
