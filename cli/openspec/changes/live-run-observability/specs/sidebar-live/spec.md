## MODIFIED Requirements

### Requirement: The sidebar renders live ledger data with graceful degradation

The sidebar SHALL source its DATA PROFILE and RUNS sections from the harness ledger through the
booted runtime's pool — the data-profile status row and the analysis's newest runs — never from
mock fixtures. Before the runtime is `ready` the sections SHALL render a muted placeholder (no
reads are attempted); an unprofiled analysis renders "not profiled"; a read failure renders an
unavailable state — none of these SHALL crash or block the sidebar. Every state distinguishes
itself by glyph and tone from the design system.

The RUNS section SHALL render **every active run**, not only the newest. An active
(non-terminal) run SHALL render its own run block — the progress meter, `done/total`, and the
bounded step window (the narrow windowed mount, `maxSteps` capped) — directly under its run row,
WITHOUT repeating the run block's name/tag heading, since the run row above is the heading. A
terminal run SHALL render as a plain one-line row, and terminal rows SHALL stay capped as before.
Because a block is keyed by the run id of the row it renders under, one run's progress under
another run's row is not representable. The rail scrolls, so its length tracks live work rather
than history.

Runs and steps SHALL be identified by name rather than by opaque id wherever a name exists. A run
SHALL be labelled by its plan's title, resolved from the persisted plan, falling back to the
workflow name and then the id tail when no title is available — the stored workflow name is
identical on every row and identifies nothing. A step SHALL be labelled by its plan-assigned name,
falling back to its step id, and SHALL show the agent that owns it.

A step's rendered state SHALL preserve distinctions the ledger records rather than collapse them:
a step that was skipped SHALL be distinguishable from one still waiting to start, a blocked step
SHALL surface the recorded reason it was blocked rather than reading as an ordinary failure, and a
step that was retried SHALL show that it was.

The completed-profile line SHALL show the absolute completed time (`toLocaleString()`, matching
the details dialog) rather than a relative age: a profile is a durable record referenced long
after it ran, and a bare `8h` forces the reader to do date arithmetic the absolute time answers
directly. The RUNS rows and the SESSION age keep compact relative ages — an absolute timestamp on
every run row would exceed the rail's usable width and wrap each row.

#### Scenario: Sections degrade before the runtime is ready

- **WHEN** the sidebar renders while the harness runtime is still booting
- **THEN** the DATA PROFILE and RUNS sections show muted placeholders and no ledger query runs

#### Scenario: Profile states render truthfully

- **WHEN** the analysis's ledger row is absent, running, completed, or failed
- **THEN** the DATA PROFILE section shows the matching state (not-profiled / profiling / completed with file count and the absolute completed time / failed with a one-line error)

#### Scenario: Real runs replace the mocks

- **WHEN** the analysis has runs in the ledger
- **THEN** the RUNS section lists the runs with their real status, name, and relative start time — and shows "no runs" when none exist

#### Scenario: Every active run shows its own progress

- **WHEN** two runs are active at once
- **THEN** each renders its own progress meter, `done/total`, and bounded step window under its own run row, with no repeated run name

#### Scenario: A finished run collapses to a row

- **WHEN** an active run reaches a terminal status
- **THEN** its block is replaced by a plain one-line row and the remaining active runs keep their blocks

#### Scenario: Runs and steps are named

- **WHEN** a run's plan carries a title and its steps carry names
- **THEN** the run row shows the plan title and each step row shows its plan name and owning agent, rather than an id tail and a step slug

#### Scenario: Blocked and skipped states stay distinct

- **WHEN** the step ledger holds a blocked step, a skipped step, and a pending step for a rendered run
- **THEN** the blocked step surfaces its recorded reason, and the skipped step is distinguishable from the pending one

### Requirement: Sidebar data refreshes on lifecycle edges and bounded polling

The sidebar's live data SHALL refresh when the runtime reaches `ready`, when the workspace
analysis changes, when a chat turn completes, when the profile parity machinery changes ledger
state outside those edges (a trigger, restart, or clear pokes the store — see `tui-harness-chat`),
and when a run-observation event is received from the harness; while the last snapshot shows
active work (a pending/running profile or a non-terminal run) it SHALL additionally poll on a
bounded interval — and SHALL stop polling once no work is active, so an idle sidebar issues zero
queries.

A run-observation event SHALL act as a refresh **trigger**, not as a data source: the refresh
remains the single writer of the store, so ordering, plan resolution, and staleness handling have
one implementation. Polling SHALL be retained as the backstop for state the observation channel
cannot carry — a run started by another process, or an event missed while the runtime was still
booting.

A refresh SHALL claim a monotonic generation token at entry and re-check it after each read, so the
newest refresh started is the only one that writes. Because that token makes a newer refresh *cancel* an
older one, the **poll** SHALL additionally skip its tick whenever a refresh is already in flight. Without
that skip, reads slower than the interval would leave every tick superseded by the next and the store
would never receive a write at all — and since an `unavailable` snapshot is itself an arming condition,
a degraded database would be re-queried on every tick behind a permanently frozen section.

Lifecycle-edge refreshes SHALL NOT skip: they carry new information and are required to supersede.
An observation-triggered refresh SHALL follow the poll's skip rule, not the lifecycle rule — events
can arrive faster than reads complete, and a burst must not starve the store of writes.

For **every** non-terminal run in the freshly-read snapshot, the refresh SHALL additionally fetch
that run's steps from the step ledger (inside the same generation-token guard) and publish an
active-run progress entry — run label, done/total counts, and per-step view states carrying each
step's name, owning agent, and recorded blocked reason and attempt count where present. The
published progress SHALL be keyed by run id. A run that reaches a terminal status SHALL have its
entry removed. When no run is active, no entry SHALL be published and no step query SHALL run,
preserving the idle-costs-nothing property. Plan resolution SHALL be performed at most once per
distinct plan within a refresh, so several runs of one plan cost one plan read.

The step-status → view-state mapping SHALL be defined once in the sidebar-live module and shared
with the run-detail dialog and the run-activity panel, so no surface invents its own reading of a
ledger status.

#### Scenario: A run launched from chat appears without user action

- **WHEN** the agent launches a run during a turn
- **THEN** the RUNS section shows the new run after the turn completes, and its status keeps updating while the run is active

#### Scenario: An observation event refreshes without waiting for the poll

- **WHEN** a run-observation event arrives between poll ticks
- **THEN** a refresh runs and the sections reflect the new state without waiting for the interval

#### Scenario: An input edit's consequences appear without user action

- **WHEN** an input mutation causes the parity machinery to re-trigger or clear the profile
- **THEN** the DATA PROFILE section reflects the new ledger state (running, or not profiled) without the user touching the sidebar

#### Scenario: Idle costs nothing

- **WHEN** no profile is running and every run is terminal
- **THEN** no polling interval is active, and no step query runs

#### Scenario: A slow read degrades cadence, not liveness

- **WHEN** a refresh's ledger reads take longer than the poll interval
- **THEN** the intervening ticks SHALL be skipped rather than superseding the in-flight refresh
- **AND** that refresh SHALL complete and write its snapshots

#### Scenario: An event burst does not starve the store

- **WHEN** run-observation events arrive faster than a refresh completes
- **THEN** the events that arrive during an in-flight refresh are skipped rather than superseding it, and a refresh completes and writes

#### Scenario: A recovering database self-heals

- **WHEN** the ledger reads fail (arming the poll via `unavailable`) and then begin succeeding, while each read is slower than the interval
- **THEN** a refresh SHALL complete and the sections SHALL leave the `unavailable` state

#### Scenario: Every active run publishes live progress

- **WHEN** two runs are non-terminal during a refresh
- **THEN** a progress entry is published for each, keyed by its run id, carrying its label, done/total, and per-step states

#### Scenario: Progress entry clears on completion

- **WHEN** an active run reaches a terminal status
- **THEN** the next refresh removes that run's progress entry, leaves other active runs' entries intact, and stops fetching that run's steps

#### Scenario: Several runs of one plan read the plan once

- **WHEN** two active runs share a plan
- **THEN** the refresh resolves that plan's title once and labels both runs from it

#### Scenario: Seeded pending steps render as queued

- **WHEN** the step ledger returns `pending` (or `skipped`) rows for an active run
- **THEN** the progress entry shows them in the step window with the queued (hollow) view state and counts them in the `done/total` denominator
