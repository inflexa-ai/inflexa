## MODIFIED Requirements

### Requirement: The store publishes the data profile as live progress

The store MUST publish a live-progress entry for a **running** data profile, beside the entries of each run that it already publishes. The entry MUST carry what a profile has: an identity, its start time, the workflow id that its ledger row records, and if the entry is stale. It MUST NOT carry completion counts or step views, because a profile has no steps. It MUST NOT carry a display name. One profile exists for each analysis, and it is always the same operation, thus the name is a constant of the render.

The refresh MUST stay the single writer. The profile entry MUST come from the profile row that the refresh already reads, inside the same generation-token guard as the run entries. Thus no second reader and no second staleness rule exist.

A `pending` profile MUST NOT be published. The ledger writes the start time of the profile only on the move into `running`, thus a pending row carries none. A pending profile has no workflow, thus it has no stream and nothing to report. `pending` means seeded and queued, and this entry describes work in flight.

This MUST NOT change the cadence of the poll, which counts a pending profile as active work. The cadence decides how often to look, not if there is something to show. A profile that reaches a terminal state MUST lose its entry at the next refresh.

The entry MUST NOT replace or change the entries of the runs that the RUNS section reads. The data of the rail does not change with this requirement.

#### Scenario: A running profile publishes an entry

- **WHEN** a refresh reads a profile row in the `running` state
- **THEN** a profile progress entry is published carrying its start time and recorded workflow id

#### Scenario: A pending profile publishes no entry

- **WHEN** a refresh reads a profile row in the `pending` state
- **THEN** no profile progress entry is published
- **AND** the poll stays at its fast cadence, because a pending profile is still active work

#### Scenario: A terminal profile's entry clears

- **WHEN** a profile reaches `completed` or `failed`
- **THEN** the next refresh removes its progress entry

#### Scenario: A profile with no recorded workflow id still publishes

- **WHEN** a refresh reads a running profile row whose workflow id is not yet recorded
- **THEN** an entry is published with no workflow id, rather than being withheld

#### Scenario: The rail's run data is unaffected

- **WHEN** a profile entry is published
- **THEN** the per-run progress entries the RUNS section reads are unchanged

## REMOVED Requirements

### Requirement: The usage figure refreshes on turn completion and on the bounded poll

**Reason**: The poll no longer stops when no work is active, thus an idle rail reads the usage at each idle tick. The section reads the count of the poll ticks, not the snapshots of the ledger.
**Migration**: The requirement "The usage figure refreshes on turn completion and at each poll tick" gives the refresh edges of the section.

### Requirement: Sidebar data refreshes on lifecycle edges and a bounded poll of the local server

**Reason**: The poll runs while an analysis is open, at 15 s when idle, thus an idle sidebar is no longer free of requests. The tick also reads the shared state that shows the work of a different client.
**Migration**: The requirement "Sidebar data refreshes on lifecycle edges and one poll of the local server" gives the edges and the cadence.

## ADDED Requirements

### Requirement: The usage figure refreshes on turn completion and at each poll tick

The USAGE section MUST read the usage again when the chat status leaves its busy state, at the completion of a turn. It MUST also read the usage one time at each tick of the poll that finds the server. It MUST NOT depend on the message count of the conversation.

The message count is not a signal of turn completion. The assistant message goes into the store when the turn STARTS, thus a read at that edge comes before the turn records its calls. The count also stops at the message cap of the store, and a memo on it then never fires again. The move of the chat status out of busy states the completion directly.

No second timer MUST exist. The section reads the count of the poll ticks, not the snapshots of the ledger. A tick writes the snapshots two times, and a tick whose ledger read a newer refresh superseded writes them zero times. The poll runs at its idle cadence when no work is active. Thus a turn of a different client shows at the next tick, at most 15 s later.

#### Scenario: A completed turn advances the figure

- **WHEN** a turn completes and its calls are recorded
- **THEN** the section's figures reflect them without any timer elapsing

#### Scenario: A long-running turn advances the figure before it ends

- **GIVEN** a turn that has been running long enough for the poll to tick
- **WHEN** the poll fires
- **THEN** the section reflects the calls recorded so far

#### Scenario: The figure keeps refreshing past the message cap

- **GIVEN** a conversation whose stored message count has reached its cap and stopped changing
- **WHEN** a further turn completes
- **THEN** the section's figures still advance

#### Scenario: An idle rail reads the usage once for each tick

- **GIVEN** no active run, no pending profile, and no turn in flight
- **WHEN** the idle poll ticks
- **THEN** the section reads the usage one time for that tick

#### Scenario: The turn of a different client shows in the figure

- **GIVEN** a different client that completes a turn on the open session
- **WHEN** the next tick of the poll finds the server
- **THEN** the section shows the calls of that turn

### Requirement: Sidebar data refreshes on lifecycle edges and one poll of the local server

The live data of the sidebar MUST refresh at these edges:

- the runtime of the local server reaches `ready`
- the workspace analysis changes
- a chat turn completes
- a profile drive that this client asked for changes the ledger state outside these edges (a trigger, a restart, or a clear pokes the store, see `tui-harness-chat`)
- an input change of this client, because the server starts the re-profile after it

The sidebar MUST also keep one poll interval while an analysis is open. The interval MUST be 5 s while the last snapshot shows active work, or while a turn of a different client runs on the open thread. Otherwise it MUST be 15 s. Active work is a pending or running profile, profile work that the server holds (`workPending`), or a non-terminal run. The interval MUST arm again only when the analysis or the cadence changes.

The local server sends no event when a run or a profile changes. The idle poll is the bound on how late the sidebar shows a run or a profile that a different client started. The same bound holds for a re-profile that the server starts after an input change. Each tick also reads the shared state of `local-server`, "Polls take the place of the bus".

A refresh MUST claim a monotonic generation token at entry and check it again after each read. Thus only the newest refresh writes. That token makes a newer refresh *cancel* an older one, thus the **poll** MUST skip its tick while a refresh is in flight. Without that skip, reads slower than the interval leave each tick superseded by the next, and the store never gets a write. An `unavailable` snapshot also keeps the fast cadence, thus a degraded server would get a read at each tick behind a frozen section.

A refresh at a lifecycle edge MUST NOT skip: it carries new information, and it must supersede.

For **each** non-terminal run in the new snapshot, the refresh MUST also read the detail of that run from the run route of the local server. That read runs inside the same generation-token guard. The detail gives the steps, the plan name of each step, and the usage of each step. The refresh MUST publish an active-run progress entry, keyed by the run id. The entry carries the run label, the done/total counts, and the view state of each step. Each step view carries its name, its agent, and the recorded blocked reason and attempt count.

A run that reaches a terminal status MUST lose its entry. When no run is active, no entry MUST be published, and no run detail MUST be read. A runs page MUST resolve each distinct plan at most one time.

The map from a step status to a view state MUST be defined one time in the sidebar-live module. The run-detail dialog and the run-activity panel MUST share it, thus no surface makes its own reading of a ledger status.

#### Scenario: A run launched from chat appears without user action

- **WHEN** the agent launches a run during a turn
- **THEN** the RUNS section shows the new run after the turn completes, and its status keeps updating while the run is active

#### Scenario: A run of a different client shows at the next tick

- **GIVEN** an idle sidebar
- **WHEN** a different client of the same server starts a run on the open analysis
- **THEN** the RUNS section shows the run at the next tick of the poll, at most 15 s later

#### Scenario: A profile drive's consequences appear without user action

- **WHEN** the parity drive of a chat open, or a deliberate re-profile, triggers or clears the profile
- **THEN** the DATA PROFILE section reflects the new ledger state (running, or not profiled) without the user touching the sidebar

#### Scenario: An input change keeps the poll fast until the drive shows

- **WHEN** this client adds an input, and the server holds the re-profile behind its debounce
- **THEN** the sidebar reads the profile at once, `workPending` keeps the 5 s cadence, and the section shows the drive when the row records it

#### Scenario: Idle costs one slow tick

- **WHEN** no profile is running and every run is terminal
- **THEN** the poll ticks each 15 s, and no run detail is read

#### Scenario: A slow read degrades cadence, not liveness

- **WHEN** a refresh's reads take longer than the poll interval
- **THEN** the ticks between them are skipped, and they do not supersede the refresh in flight
- **AND** that refresh completes and writes its snapshots

#### Scenario: A recovering server self-heals

- **WHEN** the reads fail (an `unavailable` snapshot keeps the fast cadence) and then begin to succeed, while each read is slower than the interval
- **THEN** a refresh completes, and the sections leave the `unavailable` state

#### Scenario: Every active run publishes live progress

- **WHEN** two runs are non-terminal during a refresh
- **THEN** a progress entry is published for each, keyed by its run id, carrying its label, done/total, and per-step states

#### Scenario: Progress entry clears on completion

- **WHEN** an active run reaches a terminal status
- **THEN** the next refresh removes that run's progress entry, leaves other active runs' entries intact, and stops reading that run's detail

#### Scenario: Several runs of one plan on one page read the plan once

- **WHEN** two runs on one runs page share a plan
- **THEN** the local server resolves that plan's title once for the page and labels both runs from it

#### Scenario: Seeded pending steps render as queued

- **WHEN** the run detail returns `pending` (or `skipped`) steps for an active run
- **THEN** the progress entry shows them in the step window with the queued (hollow) view state and counts them in the `done/total` denominator
