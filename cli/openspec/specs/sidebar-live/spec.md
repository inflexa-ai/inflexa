# sidebar-live Specification

## Purpose
The sidebar's live-data contract: the DATA PROFILE and RUNS sections source the harness ledger through the booted runtime (never mocks), degrade gracefully pre-ready, refresh on lifecycle edges plus a bounded active-work poll, and open details views (profile summary dialog — carrying the keybound re-profile action; runs-with-steps dialog) by section click and leader keybindings. Lives in `src/tui/hooks/sidebar_live.ts`, `src/tui/layout/sidebar.tsx`, and `src/tui/components/dialog/runs_dialog.tsx`.

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
analysis changes, when a chat turn completes, and when the profile parity machinery changes ledger
state outside those edges (a trigger, restart, or clear pokes the store — see `tui-harness-chat`);
while the last snapshot shows active work (a pending/running profile or a non-terminal run) it
SHALL additionally poll on a bounded interval — and SHALL stop polling once no work is active, so
an idle sidebar issues zero queries.

A refresh SHALL claim a monotonic generation token at entry and re-check it after each read, so the
newest refresh started is the only one that writes. Because that token makes a newer refresh *cancel* an
older one, the **poll** SHALL additionally skip its tick whenever a refresh is already in flight. Without
that skip, reads slower than the interval would leave every tick superseded by the next and the store
would never receive a write at all — and since an `unavailable` snapshot is itself an arming condition,
a degraded database would be re-queried on every tick behind a permanently frozen section.

Lifecycle-edge refreshes SHALL NOT skip: they carry new information and are required to supersede.

#### Scenario: A run launched from chat appears without user action

- **WHEN** the agent launches a run during a turn
- **THEN** the RUNS section shows the new run after the turn completes, and its status keeps updating while the run is active

#### Scenario: An input edit's consequences appear without user action

- **WHEN** an input mutation causes the parity machinery to re-trigger or clear the profile
- **THEN** the DATA PROFILE section reflects the new ledger state (running, or not profiled) without the user touching the sidebar

#### Scenario: Idle costs nothing

- **WHEN** no profile is running and every run is terminal
- **THEN** no polling interval is active

#### Scenario: A slow read degrades cadence, not liveness

- **WHEN** a refresh's ledger reads take longer than the poll interval
- **THEN** the intervening ticks SHALL be skipped rather than superseding the in-flight refresh
- **AND** that refresh SHALL complete and write its snapshots

#### Scenario: A recovering database self-heals

- **WHEN** the ledger reads fail (arming the poll via `unavailable`) and then begin succeeding, while each read is slower than the interval
- **THEN** a refresh SHALL complete and the sections SHALL leave the `unavailable` state

### Requirement: Profile and runs details open from the sidebar

The DATA PROFILE and RUNS sections SHALL each open a details view, both by mouse activation on the
section and by a leader keybinding (documented in which-key). The profile details view SHALL show
the ledger truth: status, timestamps, error when failed, the profile summary, and the per-file
descriptions from the profile result. It SHALL additionally offer the keybound re-profile action
(per `tui-harness-chat`), discoverable via the dialog's footer hint, active only when a re-profile
can start (runtime ready, inputs present, no profile running). The runs details view SHALL list
recent runs and render a run's steps (from the step ledger) through the design system's run block,
including a failed-step state. Both views SHALL follow the dialog subsystem's rules (host-owned
escape, cancel wiring, inert showcase) and SHALL be gallery-showcased. Steps are fetched when the
view opens, not by the sidebar's refresh loop.

#### Scenario: Profile details show the ledger truth

- **WHEN** the user activates the DATA PROFILE section (click or keybind) on a profiled analysis
- **THEN** a dialog shows the profile's status, timestamps, summary, and per-file descriptions

#### Scenario: Re-profile fires from the details dialog

- **WHEN** the user presses the re-profile key in the profile details dialog on a completed profile
- **THEN** the re-profile starts and the dialog closes — the notice and the DATA PROFILE section carry the live outcome (the dialog is a point-in-time snapshot and does not track the ledger while open)

#### Scenario: Run steps render in the details view

- **WHEN** the user opens the runs details view for an analysis with a run
- **THEN** the run's steps render with per-step state (done / running / failed / queued) from the step ledger

#### Scenario: Details views degrade pre-ready

- **WHEN** a details view is opened before the runtime is ready
- **THEN** it renders the same muted not-ready state instead of querying
