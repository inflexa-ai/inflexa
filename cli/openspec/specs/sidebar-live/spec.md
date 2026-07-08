# sidebar-live Specification

## Purpose
The sidebar's live-data contract: the DATA PROFILE and RUNS sections source the harness ledger through the booted runtime (never mocks), degrade gracefully pre-ready, refresh on lifecycle edges plus a bounded active-work poll, and open details views (profile summary dialog; runs-with-steps dialog) by section click and leader keybindings. Lives in `src/tui/hooks/sidebar_live.ts`, `src/tui/layout/sidebar.tsx`, and `src/tui/components/dialog/runs_dialog.tsx`.

## Requirements

### Requirement: The sidebar renders live ledger data with graceful degradation

The sidebar SHALL source its DATA PROFILE and RUNS sections from the harness ledger through the
booted runtime's pool — the data-profile status row and the analysis's newest runs — never from
mock fixtures. Before the runtime is `ready` the sections SHALL render a muted placeholder (no
reads are attempted); an unprofiled analysis renders "not profiled"; a read failure renders an
unavailable state — none of these SHALL crash or block the sidebar. Every state distinguishes
itself by glyph and tone from the design system.

#### Scenario: Sections degrade before the runtime is ready

- **WHEN** the sidebar renders while the harness runtime is still booting
- **THEN** the DATA PROFILE and RUNS sections show muted placeholders and no ledger query runs

#### Scenario: Profile states render truthfully

- **WHEN** the analysis's ledger row is absent, running, completed, or failed
- **THEN** the DATA PROFILE section shows the matching state (not-profiled / profiling / completed with file count and relative time / failed with a one-line error)

#### Scenario: Real runs replace the mocks

- **WHEN** the analysis has runs in the ledger
- **THEN** the RUNS section lists the newest runs with their real status, name, and relative start time — and shows "no runs" when none exist

### Requirement: Sidebar data refreshes on lifecycle edges and bounded polling

The sidebar's live data SHALL refresh when the runtime reaches `ready`, when the workspace
analysis changes, and when a chat turn completes; while the last snapshot shows active work (a
pending/running profile or a non-terminal run) it SHALL additionally poll on a bounded interval —
and SHALL stop polling once no work is active, so an idle sidebar issues zero queries.

#### Scenario: A run launched from chat appears without user action

- **WHEN** the agent launches a run during a turn
- **THEN** the RUNS section shows the new run after the turn completes, and its status keeps updating while the run is active

#### Scenario: Idle costs nothing

- **WHEN** no profile is running and every run is terminal
- **THEN** no polling interval is active

### Requirement: Profile and runs details open from the sidebar

The DATA PROFILE and RUNS sections SHALL each open a details view, both by mouse activation on the
section and by a leader keybinding (documented in which-key). The profile details view SHALL show
the ledger truth: status, timestamps, error when failed, the profile summary, and the per-file
descriptions from the profile result. The runs details view SHALL list recent runs and render a
run's steps (from the step ledger) through the design system's run block, including a failed-step
state. Both views SHALL follow the dialog subsystem's rules (host-owned escape, cancel wiring,
inert showcase) and SHALL be gallery-showcased. Steps are fetched when the view opens, not by the
sidebar's refresh loop.

#### Scenario: Profile details show the ledger truth

- **WHEN** the user activates the DATA PROFILE section (click or keybind) on a profiled analysis
- **THEN** a dialog shows the profile's status, timestamps, summary, and per-file descriptions

#### Scenario: Run steps render in the details view

- **WHEN** the user opens the runs details view for an analysis with a run
- **THEN** the run's steps render with per-step state (done / running / failed / queued) from the step ledger

#### Scenario: Details views degrade pre-ready

- **WHEN** a details view is opened before the runtime is ready
- **THEN** it renders the same muted not-ready state instead of querying
