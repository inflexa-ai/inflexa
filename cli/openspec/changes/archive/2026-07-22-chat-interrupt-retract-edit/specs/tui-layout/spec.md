## MODIFIED Requirements

### Requirement: Persistent status bar

`StatusBar` SHALL render a left region, an OPTIONAL middle region, and a right region. Left = `inflexa` in `theme().accent` plus a screen title or the active analysis name. The middle region is parameterized by the caller: in the chat it SHALL show the live session state (`ready`/`thinking`/`error`), each with a leading glyph (e.g. `● ready`), colored `theme().success`/`theme().warn`/`theme().error` and sourced from the shared chat-status store (see "Chat status lives in a shared reactive store"); in `config` it SHALL show the unsaved-changes indicator in `theme().warn` and SHALL render nothing when there are no unsaved changes. Right = affordance hint labels sourced from the central keymap. `StatusBar` SHALL import only `theme` (no `modules/`/`db/` imports) and SHALL be composed by both `app.tsx` and `app_config.tsx`, replacing their hand-rolled header boxes. All colors SHALL come from `theme()`; no hex is inlined.

The chat's `StatusBar` SHALL additionally accept an OPTIONAL workspace-path segment, rendered as a muted ` | <path>` segment immediately after the state segment — part of the left-flowing segments, NOT the right-aligned hints region. `app.tsx` SHALL pass it only when the terminal width is at or above the design-system breakpoint token (`size.breakpointWide`), sourcing the value from the workspace store's `workingDir` with the home directory contracted to `~`; below the breakpoint the prop is absent and the path renders in the sidebar instead (see the sidebar requirement). `StatusBar` itself stays dumb — it renders whatever path string it is given and keeps its no-domain-imports rule.

The chat's right hints region SHALL be state-aware for the interrupt affordance: while a turn is busy it SHALL include the interrupt hint, and while the interrupt is armed the label SHALL flip to its "again to interrupt" form with a visually distinct (accent) treatment; when idle no interrupt hint renders. The label SHALL derive from the live `app.interrupt` binding (`chordLabel`, never hand-written), and both the label and the armed state SHALL arrive from `app.tsx` as data — `StatusBar` keeps its no-domain-imports rule.

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

#### Scenario: Busy shows the interrupt hint

- **WHEN** a turn is streaming and the interrupt is not armed
- **THEN** the right hints region shows the interrupt hint labeled from the live binding

#### Scenario: Arming flips the hint

- **WHEN** the user presses esc in the chat's NORMAL mode during a turn
- **THEN** the hint flips to its "again to interrupt" form for the armed window, then reverts when the window lapses or the turn ends
