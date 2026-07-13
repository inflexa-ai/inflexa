## MODIFIED Requirements

### Requirement: Direction-B chat shell composition

`app.tsx` SHALL compose the chat screen as: a persistent `StatusBar` across the full width at the top; below it a main row split into a chat column (the message stream, the error banner, the transient notice, the sticky run-progress row, and the `ChatBar`, stacked) and, beside it, an optional full-height `Sidebar`. The `Sidebar` SHALL span the full height of that row — alongside BOTH the stream and the input — so when it is shown the chat column (stream and input together) shrinks horizontally to make room (the opencode layout). When the sidebar is hidden the chat column spans the full width. The message stream SHALL render inside a `ScrollPane` (see the `scroll-pane` capability) with `stickyScroll`/`stickyStart="bottom"`; the chat SHALL declare no scroll bindings of its own. The existing overlay dialog host, keyboard gating, streaming-delta flush, and abort behavior SHALL be preserved; dialog-close focus restore follows the "Chat focus is always on a widget" requirement.

The sticky run-progress row is a shell part (`src/tui/layout/run_progress_row.tsx`) mounted between the stream and the input area. It SHALL render iff the sidebar-live active-run progress snapshot is non-null (the newest run is non-terminal), composing the design system's run block (progress bar, done/total, a bounded step window) from that snapshot, and SHALL disappear when the run reaches a terminal status. As fixed chrome directly below a `flexGrow` scrollbox it MUST follow the scrollbox-bleed recipe: a full-width box painted with the app background and `flexShrink={0}`, so the stream — not the chrome — absorbs any vertical squeeze. The row SHALL be gallery-showcased.

#### Scenario: Sidebar is full height and shrinks the chat column

- **WHEN** the sidebar is shown
- **THEN** it spans the full height beside both the stream and the input, and the chat column (stream + input) narrows to make room

#### Scenario: Hidden sidebar gives full width

- **WHEN** the sidebar is toggled off
- **THEN** the chat column spans the full width and only the status bar, stream, and input remain

#### Scenario: Stream scrolls via ScrollPane

- **WHEN** the chat column renders the message stream
- **THEN** the stream is a `ScrollPane` (sticky-bottom), and no scroll chord is declared in `app.tsx` or `chat.tsx`

#### Scenario: Active run pins a progress row above the input

- **WHEN** the newest run is non-terminal
- **THEN** the chat column shows the run-progress row (bar, done/total, step window) pinned between the stream and the input, updating as the sidebar refresh loop publishes new snapshots

#### Scenario: Progress row leaves when the run ends

- **WHEN** the run reaches a terminal status
- **THEN** the progress row unmounts and the stream reclaims its rows

#### Scenario: Progress row survives the squeeze

- **WHEN** the terminal is short enough that the chat column must shrink
- **THEN** the progress row keeps its rows (painted, `flexShrink={0}`) and the stream yields, with no scrollbox content bleeding through the row

### Requirement: Persistent status bar

`StatusBar` SHALL render a left region, an OPTIONAL middle region, and a right region. Left = `inflexa` in `theme().accent` plus a screen title or the active analysis name. The middle region is parameterized by the caller: in the chat it SHALL show the live session state (`ready`/`thinking`/`error`), each with a leading glyph (e.g. `● ready`), colored `theme().success`/`theme().warn`/`theme().error` and sourced from the shared chat-status store (see "Chat status lives in a shared reactive store"); in `config` it SHALL show the unsaved-changes indicator in `theme().warn` and SHALL render nothing when there are no unsaved changes. Right = affordance hint labels sourced from the central keymap. `StatusBar` SHALL import only `theme` (no `modules/`/`db/` imports) and SHALL be composed by both `app.tsx` and `app_config.tsx`, replacing their hand-rolled header boxes. All colors SHALL come from `theme()`; no hex is inlined.

The chat's `StatusBar` SHALL additionally accept an OPTIONAL workspace-path segment, rendered as a muted ` | <path>` segment immediately after the state segment — part of the left-flowing segments, NOT the right-aligned hints region. `app.tsx` SHALL pass it only when the terminal width is at or above the design-system breakpoint token (`size.breakpointWide`), sourcing the value from the workspace store's `workingDir` with the home directory contracted to `~`; below the breakpoint the prop is absent and the path renders in the sidebar instead (see the sidebar requirement). `StatusBar` itself stays dumb — it renders whatever path string it is given and keeps its no-domain-imports rule.

#### Scenario: Shows analysis name and live state

- **WHEN** a chat is open and the assistant is streaming
- **THEN** the status bar shows the analysis name on the left and `thinking` (in the warn color) in the middle

#### Scenario: Reused by the config screen

- **WHEN** `inflexa config` renders
- **THEN** its header is the shared `StatusBar`, not a separately hand-rolled box

#### Scenario: Optional middle region in config

- **WHEN** `inflexa config` has unsaved changes
- **THEN** the status bar's middle region shows the unsaved indicator, and renders nothing when there are no unsaved changes

#### Scenario: Wide terminal shows the workspace path in the header

- **WHEN** the chat renders on a terminal at or above `size.breakpointWide` columns
- **THEN** the status bar shows the home-contracted working directory immediately after the state segment, before the right-aligned hints

#### Scenario: Narrow terminal keeps the header path-free

- **WHEN** the chat renders on a terminal below `size.breakpointWide` columns
- **THEN** the status bar shows no path segment (the sidebar carries the path)

### Requirement: Fixed-gutter message block

`MessageBlock` SHALL render a fixed-width gutter column (2 spaces) whose marker swaps by role, taken from the shared gutter marker set (`markers.ts`): `>` for the user (`theme().user`) and `<` for the assistant (`theme().assistant`), followed by the role label and the markdown body. The gutter width SHALL be constant regardless of marker, so future block types align identically. Streaming assistant text SHALL render from the live stream signal and flush into the message store on completion, exactly as before this change. No meta footer (model · duration · tokens) SHALL be rendered, because that data is not tracked; fabricating it is NOT permitted.

A user turn SHALL additionally differentiate itself with a left border rule in the user color (`border={["left"]}`, `theme().user`) on its parts container — the design system's quoted-content idiom. The rule MUST NOT break gutter alignment: the border glyph consumes one cell, so the user body's left padding SHALL shrink by one cell to keep body text in the same column as assistant bodies, and the header line (the `>` marker in the gutter) SHALL stay outside the bordered box. Assistant turns are unchanged.

#### Scenario: Role selects the marker

- **WHEN** a user turn and an assistant turn render
- **THEN** the user turn shows `>` in the user color and the assistant turn shows `<` in the assistant color, both in the same 2-space gutter column

#### Scenario: Streaming behavior preserved

- **WHEN** the assistant response streams in
- **THEN** deltas render live and flush into the store on completion, identical to the pre-change behavior

#### Scenario: User turns carry the rule, aligned

- **WHEN** a user turn renders above an assistant turn
- **THEN** the user body shows a left rule in the user color, and both bodies' text starts in the same column (the rule + reduced padding equals the assistant's gutter indent)

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
(states, refresh, details views) — the sidebar MUST NOT display mock fixtures or values fabricated
inline at the render site. The sidebar's data SHALL update when the open analysis or session
changes (an in-place `openSession` swap).

The ANALYSIS anchor-path line SHALL render only when the terminal is below the design-system
breakpoint (`size.breakpointWide`); at or above it the path moves to the status bar (see the status
bar requirement) and the ✓/⚠ badge — which reports anchor-marker health, not the path, and never
moves to the header — SHALL join the ANALYSIS meta line (inputs · project) instead.

Section headers SHALL use vertical space responsively: a section whose value is a single short
string (SESSION's short id, ANALYSIS's name) SHALL render `LABEL <flex gap> value` on one row when
the label, a separating gap, and the value fit the rail's usable width — and SHALL fall back to
today's stacked layout (label above a full-width value line) when they do not, so a long analysis
name is never truncated or wrapped inside a right-hand cell. Sections whose first line is a
composite (DATA PROFILE's glyph-bearing `N files · age` line) and row-list sections (RUNS) keep the
stacked layout — the merge models a single plain value, not a styled composite. The fit decision is
measured in cells (one character per cell) against the rail width minus its padding and border.

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

#### Scenario: Short value shares the label row

- **WHEN** a section's label, gap, and value fit the rail's usable width
- **THEN** they render on one row — label left, value pushed right by a flex gap — saving a vertical row

#### Scenario: Long value falls back to stacked

- **WHEN** an analysis name is too long to share the ANALYSIS label row
- **THEN** the section renders the stacked layout (label above the full-width name), never a name wrapped inside a right-hand cell

#### Scenario: Path yields to the header on wide terminals

- **WHEN** the terminal is at or above `size.breakpointWide` columns
- **THEN** the ANALYSIS section shows no path line, the ✓/⚠ badge joins the meta line, and the status bar carries the path
