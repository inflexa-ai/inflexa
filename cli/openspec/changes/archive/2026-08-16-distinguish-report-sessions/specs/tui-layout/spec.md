## MODIFIED Requirements

### Requirement: Persistent status bar

`StatusBar` MUST render a left region, an OPTIONAL middle region, and a right region. The left region holds `inflexa` in `theme().accent`, plus a screen title or the active analysis name. The caller parameterizes the middle region. In the chat it MUST show the live session state (`ready`/`thinking`/`error`), each with a leading glyph (for example `● ready`). The state colors are `theme().success`, `theme().warn`, and `theme().error`, from the shared chat-status store (see "Chat status lives in a shared reactive store"). In `config` it MUST show the unsaved-changes indicator in `theme().warn`, and it MUST render nothing when no unsaved change exists.

The right region holds affordance hint labels from the central keymap. `StatusBar` MUST import only `theme` (no `modules/` or `db/` imports). Both `app.tsx` and `app_config.tsx` MUST compose it, in place of a hand-rolled header box. Each color MUST come from `theme()`, and no hex is inlined.

The chat's `StatusBar` MUST also accept an OPTIONAL workspace-path segment. The segment renders as a muted ` | <path>` segment directly after the state segment. It is part of the left-flowing segments, NOT the right-aligned hints region. `app.tsx` MUST pass it only when the terminal width is at or above the breakpoint token (`size.breakpointWide`). The value comes from the `workingDir` of the workspace store, with the home directory contracted to `~`. Below the breakpoint the prop is absent, and the path renders in the sidebar instead (see the sidebar requirement). `StatusBar` stays dumb: it renders the given path string, and it keeps its no-domain-imports rule.

The chat's `StatusBar` MUST also accept an OPTIONAL scope segment, per `report-session-identity`. The segment renders in the accent role, after the identity and subtitle pair and before the middle state region. `app.tsx` MUST pass it only while the open thread loads as a report row. `StatusBar` renders the given string, and its no-domain-imports rule is unchanged.

The status bar MUST NOT render the interrupt hint. That affordance is mode-scoped, and it lives in the input-bar footer beside the mode word (see "Input bar footer shows mode info and mode-scoped hints"). The status bar carries no state-aware turn affordance.

#### Scenario: Shows analysis name and live state

- **WHEN** a chat is open and the assistant streams
- **THEN** the status bar shows the analysis name on the left and `thinking` (in the warn color) in the middle

#### Scenario: Reused by the config screen

- **WHEN** `inflexa config` renders
- **THEN** its header is the shared `StatusBar`, not a separately hand-rolled box

#### Scenario: Optional middle region in config

- **WHEN** `inflexa config` holds unsaved changes
- **THEN** the middle region of the status bar shows the unsaved indicator, and it renders nothing when no unsaved change exists

#### Scenario: Wide terminal shows the workspace path in the header

- **WHEN** the chat renders on a terminal at or above `size.breakpointWide` columns
- **THEN** the status bar shows the home-contracted working directory directly after the state segment, before the right-aligned hints

#### Scenario: Narrow terminal keeps the header path-free

- **WHEN** the chat renders on a terminal below `size.breakpointWide` columns
- **THEN** the status bar shows no path segment (the sidebar carries the path)

#### Scenario: A report session shows the scope segment

- **WHEN** the chat renders while the open thread loads as a report row
- **THEN** the status bar shows the accent `report` segment after the analysis name, before the state segment

#### Scenario: No interrupt hint in the header

- **WHEN** a turn streams in NORMAL mode
- **THEN** the right hints region of the status bar shows no interrupt hint, because the input-bar footer carries it

### Requirement: Input bar footer shows mode info and mode-scoped hints

`ChatBar` MUST compose the shared `TextArea` with `chrome="full"` and the `Type a message…` placeholder (through `GLYPHS.ellipsis`). It MUST render one external footer row below the bordered textarea. The footer row MUST show the mode word on the left: `INSERT` when the textarea holds focus, and `NORMAL` when it is blurred. `NORMAL` renders bold in the accent color, and the row gets a `bgActive` background. Beside the mode word the footer MUST render the session scope word, per `report-session-identity`. The newline chord hint (`ctrl+j newline`) sits on the right.

While a turn is busy, the footer MUST render the mode-scoped interrupt affordance after the mode and scope words. In NORMAL it is the interrupt hint, labeled from the live `app.interrupt` binding. While the window is armed, the hint flips to its "again to interrupt" form, with a distinct armed treatment. The armed treatment MUST stay distinguishable from the accent mode word on the `bgActive` row, on light themes included. In INSERT it is the abort-chord hint, labeled from the live `app.abort` binding — the one chord that interrupts while the user types.

The hint MUST be absent when the turn is idle. It MUST also be absent when a dialog is stacked, and when an approval prompt is docked. These are the honesty gates of the interrupt binding itself. Labels MUST derive from the live bindings (`chordLabel`, never hand-written), and they arrive as data. `ChatBar` keeps its no-domain-imports rule.

GLOBAL keybind hints (command-palette, sidebar-toggle, quit) MUST NOT appear in this footer. They live ONLY in the status bar, thus the header and the footer never show the same keys. The footer carries only the mode word, the session scope word, and what the interrupt keys mean in the current mode.

#### Scenario: ChatBar composes TextArea

- **WHEN** the chat renders the input area
- **THEN** `ChatBar` renders a `TextArea` with `chrome="full"` for the bordered textarea, plus its own external footer row

#### Scenario: The footer carries the scope word

- **WHEN** the chat renders on a report thread
- **THEN** the footer shows the scope word beside the mode word, and the global keys stay in the header

#### Scenario: Busy NORMAL shows the esc hint beside the mode word

- **WHEN** a turn streams and the pane holds focus (NORMAL, unarmed)
- **THEN** the footer shows `NORMAL` followed by the interrupt hint labeled from the live binding, and the newline hint stays on the right

#### Scenario: Arming flips the footer hint

- **WHEN** the user pushes esc one time in NORMAL during a turn
- **THEN** the footer hint flips to its "again to interrupt" form with the distinct armed treatment
- **AND** the hint reverts when the window lapses or the turn ends

#### Scenario: Busy INSERT advertises the abort chord

- **WHEN** a turn streams while the composer holds focus (INSERT)
- **THEN** the footer shows `INSERT` followed by the abort-chord hint (the one-stroke interrupt that works while the user types)

#### Scenario: Idle, dialogs, and asks keep the footer quiet

- **WHEN** no turn is in flight, or a dialog is stacked, or an approval prompt is docked
- **THEN** the footer shows no interrupt affordance — only the mode word, the scope word, and the newline hint

#### Scenario: Global keys live in the header only

- **WHEN** the user looks for the command-palette or sidebar shortcuts
- **THEN** they appear in the status bar, and the input footer does not show them

#### Scenario: NORMAL mode has distinct visual treatment

- **WHEN** the textarea is blurred (NORMAL mode)
- **THEN** the footer row shows `NORMAL` in the bold accent color with the `bgActive` background, which signals that the vim scroll keys are live

### Requirement: Toggleable four-section sidebar

`Sidebar` MUST render four sections in a fixed order: SESSION, ANALYSIS, DATA PROFILE, RUNS. It is a fixed-width, full-height column with a divider against the chat column. The order is the pipeline order: the inputs of the analysis feed the data profile, and the profile feeds the runs. The width MUST come from `size.railWidth` (the design-tokens layer), NOT an inline integer, and the rail is NOT mouse-resizable.

SESSION MUST show the short session id (`S·` + the first 4 hex of the id), the absolute created time of the session (`toLocaleString()`, the durable-record rendering), and the message count from live data. A click on the id chip MUST copy the full id, per `report-session-identity`. A report child MUST carry the context line, per the same capability.

ANALYSIS MUST show the analysis name, the input count, and the project name when one exists. It MUST show the anchor path, with a ✓/⚠ badge from the `markerWritten` of the anchor. DATA PROFILE and RUNS MUST render live ledger data per the `sidebar-live` capability (states, refresh, details views, the active-run progress embed). The sidebar MUST NOT display mock fixtures, and it MUST NOT display values fabricated inline at the render site. The data of the sidebar MUST update when the open analysis or session changes (an in-place `openSession` swap).

The section stack of the rail MUST be vertically scrollable. When the sections outgrow the height of the rail, the rail scrolls, and it does not clip or squeeze a section. (The progress embed of the RUNS section makes the height variable.) The scroll container MUST NOT take focus on mount, because the rail is not a focus target and mouse-wheel scrolling suffices. It MUST introduce no scroll keybinding.

The ANALYSIS anchor-path line MUST render only when the terminal is below the breakpoint (`size.breakpointWide`). At or above it, the path moves to the status bar (see the status bar requirement). The ✓/⚠ badge then MUST join the ANALYSIS meta line (inputs · project). The badge reports anchor-marker health, not the path, and it never moves to the header.

Section headers MUST use vertical space responsively. A section whose value is one short string (the short id of SESSION, the name of ANALYSIS) MUST render `LABEL <flex gap> value` on one row. The condition is that the label, a gap, and the value fit the usable width of the rail. When they do not fit, the section MUST fall back to the stacked layout: the label above a full-width value line. Thus a long analysis name is never truncated, and it never wraps inside a right-hand cell. A section whose first line is a composite (the glyph-bearing `N files · time` line of DATA PROFILE) keeps the stacked layout, and a row-list section (RUNS) does too. The merge models a single plain value, not a styled composite. The fit decision counts cells (one character for each cell) against the rail width minus its padding and border.

#### Scenario: Sidebar renders live sections for an open analysis

- **WHEN** the sidebar renders for an open analysis
- **THEN** SESSION/ANALYSIS show live SQLite-backed data and DATA PROFILE/RUNS show live ledger-backed states per `sidebar-live` — nothing rendered is mock

#### Scenario: Sections render in pipeline order

- **WHEN** the sidebar renders
- **THEN** the sections appear top-to-bottom as SESSION, ANALYSIS, DATA PROFILE, RUNS

#### Scenario: The session time is absolute

- **WHEN** the SESSION section renders for a session with a created time
- **THEN** the line shows the absolute local date-time, not a relative age

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

- **WHEN** the sections (for example RUNS with the active-run progress embed) outgrow the height of the rail
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
