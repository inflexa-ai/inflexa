## MODIFIED Requirements

### Requirement: Direction-B chat shell composition

`app.tsx` SHALL compose the chat screen as: a persistent `StatusBar` across the full width at the top; below it a main row split into a chat column (the message stream, the error banner, the transient notice, and the `ChatBar`, stacked) and, beside it, an optional full-height `Sidebar`. The `Sidebar` SHALL span the full height of that row — alongside BOTH the stream and the input — so when it is shown the chat column (stream and input together) shrinks horizontally to make room (the opencode layout). When the sidebar is hidden the chat column spans the full width. The message stream SHALL render inside a `ScrollPane` (see the `scroll-pane` capability) with `stickyScroll`/`stickyStart="bottom"`; the chat SHALL declare no scroll bindings of its own. The existing overlay dialog host, keyboard gating, streaming-delta flush, and abort behavior SHALL be preserved; dialog-close focus restore follows the "Chat focus is always on a widget" requirement.

There SHALL be NO sticky run-progress row in the chat column: live run progress renders inside the sidebar RUNS section (per `sidebar-live`), and a hidden sidebar deliberately shows no live progress surface — the run-started card in the stream announces the launch, and the sidebar (open by default, `ctrl+b`) carries the live view.

#### Scenario: Sidebar is full height and shrinks the chat column

- **WHEN** the sidebar is shown
- **THEN** it spans the full height beside both the stream and the input, and the chat column (stream + input) narrows to make room

#### Scenario: Hidden sidebar gives full width

- **WHEN** the sidebar is toggled off
- **THEN** the chat column spans the full width and only the status bar, stream, and input remain

#### Scenario: Stream scrolls via ScrollPane

- **WHEN** the chat column renders the message stream
- **THEN** the stream is a `ScrollPane` (sticky-bottom), and no scroll chord is declared in `app.tsx` or `chat.tsx`

#### Scenario: No progress chrome between stream and input

- **WHEN** the newest run is non-terminal
- **THEN** the chat column shows only the stream, banner/notice, and input — the run's live progress renders in the sidebar RUNS section instead

### Requirement: Toggleable four-section sidebar

`Sidebar` SHALL render four sections in fixed order — SESSION, ANALYSIS, DATA PROFILE, RUNS — as a
fixed-width, full-height column with a divider against the chat column. The order is the pipeline
order: the analysis's inputs feed the data profile, and the profile feeds runs. Its width SHALL be
sourced from `size.railWidth` (the design-tokens layer), NOT an inline integer, and it is NOT
mouse-resizable. SESSION SHALL show the short session id (`S·` + the first 4 hex of the id), the
session age as a relative duration (e.g. `6m12s`, the two-unit `Date.relativeAge` rendering), and
the message count from live data. ANALYSIS SHALL show the analysis name, the anchor path with a ✓/⚠ badge
derived from the anchor's `markerWritten`, the input count, and the project name when the analysis
has one. DATA PROFILE and RUNS SHALL render live ledger data per the `sidebar-live` capability
(states, refresh, details views, the active-run progress embed) — the sidebar MUST NOT display mock
fixtures or values fabricated inline at the render site. The sidebar's data SHALL update when the
open analysis or session changes (an in-place `openSession` swap).

The rail's section stack SHALL be vertically scrollable: when the sections outgrow the rail's
height (the RUNS section's progress embed makes its height variable), the rail scrolls rather than
clipping or squeezing sections. The scroll container SHALL NOT take focus on mount (the rail is not
a focus target; mouse-wheel scrolling suffices) and SHALL introduce no scroll keybindings.

The ANALYSIS anchor-path line SHALL render only when the terminal is below the design-system
breakpoint (`size.breakpointWide`); at or above it the path moves to the status bar (see the status
bar requirement) and the ✓/⚠ badge — which reports anchor-marker health, not the path, and never
moves to the header — SHALL join the ANALYSIS meta line (inputs · project) instead.

Section headers SHALL use vertical space responsively: a section whose value is a single short
string (SESSION's short id, ANALYSIS's name) SHALL render `LABEL <flex gap> value` on one row when
the label, a separating gap, and the value fit the rail's usable width — and SHALL fall back to
today's stacked layout (label above a full-width value line) when they do not, so a long analysis
name is never truncated or wrapped inside a right-hand cell. Sections whose first line is a
composite (DATA PROFILE's glyph-bearing `N files · time` line) and row-list sections (RUNS) keep
the stacked layout — the merge models a single plain value, not a styled composite. The fit
decision is measured in cells (one character per cell) against the rail width minus its padding
and border.

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

#### Scenario: Overflowing rail scrolls instead of clipping

- **WHEN** the sections (e.g. RUNS carrying the active-run progress embed) outgrow the rail's height
- **THEN** the rail scrolls vertically — no section is clipped or squeezed away — and the scroll container has not stolen focus from the chat

#### Scenario: Short value shares the label row

- **WHEN** a section's label, gap, and value fit the rail's usable width
- **THEN** they render on one row — label left, value pushed right by a flex gap — saving a vertical row

#### Scenario: Long value falls back to stacked

- **WHEN** an analysis name is too long to share the ANALYSIS label row
- **THEN** the section renders the stacked layout (label above the full-width name), never a name wrapped inside a right-hand cell

#### Scenario: Path yields to the header on wide terminals

- **WHEN** the terminal is at or above `size.breakpointWide` columns
- **THEN** the ANALYSIS section shows no path line, the ✓/⚠ badge joins the meta line, and the status bar carries the path
