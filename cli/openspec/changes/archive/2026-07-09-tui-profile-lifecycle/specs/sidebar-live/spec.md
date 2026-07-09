# sidebar-live Delta

## MODIFIED Requirements

### Requirement: Sidebar data refreshes on lifecycle edges and bounded polling

The sidebar's live data SHALL refresh when the runtime reaches `ready`, when the workspace
analysis changes, when a chat turn completes, and when the profile parity machinery changes ledger
state outside those edges (a trigger, restart, or clear pokes the store — see `tui-harness-chat`);
while the last snapshot shows active work (a pending/running profile or a non-terminal run) it
SHALL additionally poll on a bounded interval — and SHALL stop polling once no work is active, so
an idle sidebar issues zero queries.

#### Scenario: A run launched from chat appears without user action

- **WHEN** the agent launches a run during a turn
- **THEN** the RUNS section shows the new run after the turn completes, and its status keeps updating while the run is active

#### Scenario: An input edit's consequences appear without user action

- **WHEN** an input mutation causes the parity machinery to re-trigger or clear the profile
- **THEN** the DATA PROFILE section reflects the new ledger state (running, or not profiled) without the user touching the sidebar

#### Scenario: Idle costs nothing

- **WHEN** no profile is running and every run is terminal
- **THEN** no polling interval is active

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
