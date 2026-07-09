# tui-layout Delta

## MODIFIED Requirements

### Requirement: Toggleable four-section sidebar

`Sidebar` SHALL render four sections in fixed order — SESSION, ANALYSIS, DATA PROFILE, RUNS — as a
fixed-width, full-height column with a divider against the chat column. The order is the pipeline
order: the analysis's inputs feed the data profile, and the profile feeds runs. Its width SHALL be
sourced from `size.railWidth` (the design-tokens layer), NOT an inline integer, and it is NOT
mouse-resizable. SESSION SHALL show the short session id (`S·` + the first 4 hex of the id), the
session age as a relative duration (e.g. `6m`, the `Date.relativeAge` rendering), and the message
count from live data. ANALYSIS SHALL show the analysis name, the anchor path with a ✓/⚠ badge
derived from the anchor's `markerWritten`, the input count, and the project name when the analysis
has one. DATA PROFILE and RUNS SHALL render live ledger data per the `sidebar-live` capability
(states, refresh, details views) — the sidebar MUST NOT display mock fixtures or values fabricated
inline at the render site. The sidebar's data SHALL update when the open analysis or session
changes (an in-place `openSession` swap).

#### Scenario: Sidebar renders live sections for an open analysis

- **WHEN** the sidebar renders for an open analysis
- **THEN** SESSION/ANALYSIS show live SQLite-backed data and DATA PROFILE/RUNS show live ledger-backed states per `sidebar-live` — nothing rendered is mock

#### Scenario: Sections render in pipeline order

- **WHEN** the sidebar renders
- **THEN** the sections appear top-to-bottom as SESSION, ANALYSIS, DATA PROFILE, RUNS

#### Scenario: Anchor badge reflects marker state

- **WHEN** the analysis's anchor has `markerWritten = false`
- **THEN** the ANALYSIS section shows the ⚠ badge rather than ✓

#### Scenario: Sidebar width comes from a token

- **WHEN** the sidebar is rendered
- **THEN** its column width is `size.railWidth`, not a raw integer literal

#### Scenario: Sidebar follows an in-place swap

- **WHEN** `openSession` swaps the analysis or session
- **THEN** every section re-renders from the new scope's data
