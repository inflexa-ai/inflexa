# sidebar-live Specification

## Purpose
The sidebar's live-data contract: the DATA PROFILE and RUNS sections source the harness ledger through the booted runtime (never mocks), degrade gracefully pre-ready, refresh on lifecycle edges plus a bounded active-work poll, publish the newest active run's step progress for the RUNS section's in-rail progress embed, and open details flows (profile summary dialog — carrying the keybound re-profile action; the searchable runs picker → run-detail dialog) by section click and leader keybindings. Lives in `src/tui/hooks/sidebar_live.ts`, `src/tui/layout/sidebar.tsx`, and `src/tui/components/dialog/run_detail_dialog.tsx`.
## Requirements
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

Live work SHALL NOT be sourced from a windowed listing. The runs listing is capped to the newest
few rows ordered by start time, which drops the OLDEST running run first — precisely the long
analysis these surfaces exist to keep visible. The set of active runs SHALL therefore come from a
separate, uncapped read, and the two SHALL be merged so a run that has fallen outside the listing
window is still listed and still tracked. The uncapped read SHALL be bounded by live concurrency
rather than by history, and its failure SHALL degrade to the listing's own view rather than
removing runs the listing can see.

#### Scenario: A long-running run outside the listing window stays observable

- **WHEN** a run is still active but older than the newest N runs the listing returns
- **THEN** it is still listed, still tracked for progress, and still announces when it terminates

#### Scenario: A failed active read never subtracts coverage

- **WHEN** the uncapped active read fails while the listing succeeds
- **THEN** the section renders exactly what the listing alone would have shown

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

### Requirement: Profile and runs details open from the sidebar

The DATA PROFILE and RUNS sections SHALL each open a details flow, both by mouse activation on the
section and by a leader keybinding (documented in which-key). The profile details view SHALL show
the ledger truth: status, timestamps, error when failed, the profile summary, and the per-file
descriptions from the profile result. Because a details view presents a durable, referenced record
(not a live fixed-width readout), its timestamps SHALL render as absolute local date-times
(`toLocaleString()`, the system locale), NOT relative ages: the profile details SHALL show absolute
`started` and `completed` lines plus a `duration` line (completed − started, via the shared
duration formatter) — for failed profiles too (the ledger stamps `completedAt` on failure), and a
still-running profile SHALL show its live elapsed time instead of a duration. The sidebar rail
itself keeps compact relative ages (see the rail requirement) — the absolute/relative split follows
the project's durable-record vs live-readout rule in `CLAUDE.md`.

The profile details view SHALL additionally offer the keybound re-profile action (per
`tui-harness-chat`), discoverable via the dialog's footer hint, active only when a re-profile can
start (runtime ready, inputs present, no profile running).

The RUNS flow SHALL be a picker → detail pair. Activating the RUNS section (click or keybind) SHALL
open a searchable runs picker — a `SelectDialog` over the analysis's runs fetched fresh at open
(newest-first, capped at 100; the cap SHALL be stated visibly when exactly 100 rows return, so
truncation is never silent). Picker rows SHALL show the run's short name, id tail, status, and
absolute started time. Selecting a run SHALL push a run-detail dialog OVER the picker (the picker
stays mounted beneath, so dismissing the detail returns to browsing). The run-detail dialog SHALL
show the run's metadata — status, absolute started/completed times, a duration via the shared
formatter (a still-running run shows elapsed time instead), and the error when failed — plus the
run's full step list (from the step ledger, fetched once at open) through the design system's run
block with no step window, including a failed-step state. Both dialogs SHALL follow the dialog
subsystem's rules (host-owned escape, cancel wiring, inert showcase) and SHALL be gallery-showcased.

#### Scenario: Profile details show the ledger truth

- **WHEN** the user activates the DATA PROFILE section (click or keybind) on a profiled analysis
- **THEN** a dialog shows the profile's status, timestamps, summary, and per-file descriptions

#### Scenario: Profile timestamps are absolute with a duration

- **WHEN** the profile details view opens on a completed (or failed) profile
- **THEN** the `started` and `completed` lines show absolute local date-times and a `duration` line shows completed − started via the shared formatter

#### Scenario: A running profile shows live elapsed time

- **WHEN** the profile details view opens while the profile is still running
- **THEN** the view shows the absolute `started` time and the elapsed time since it, with no `completed`/`duration` lines

#### Scenario: Re-profile fires from the details dialog

- **WHEN** the user presses the re-profile key in the profile details dialog on a completed profile
- **THEN** the re-profile starts and the dialog closes — the notice and the DATA PROFILE section carry the live outcome (the dialog is a point-in-time snapshot and does not track the ledger while open)

#### Scenario: Activating RUNS opens the searchable picker

- **WHEN** the user activates the RUNS section (click or keybind) on an analysis with runs
- **THEN** a `SelectDialog` lists the analysis's runs newest-first (fetched fresh, capped at 100) with short name, id tail, status, and absolute started time, filterable by typing

#### Scenario: Selecting a run opens its detail over the picker

- **WHEN** the user selects a run in the picker
- **THEN** a run-detail dialog opens showing status, absolute started/completed times, a duration (or elapsed for a running run), the error when failed, and the full step list with per-step state (done / running / failed / queued)
- **AND** dismissing the detail returns to the still-mounted picker

#### Scenario: The cap is visible, never silent

- **WHEN** the picker's fresh fetch returns exactly 100 runs
- **THEN** the picker states that only the newest 100 are listed

#### Scenario: Details views degrade pre-ready

- **WHEN** a details flow is opened before the runtime is ready
- **THEN** it renders the same muted not-ready state instead of querying

### Requirement: Active-run step views carry the running step's start time

The active-run progress snapshot's per-step views SHALL carry the step's ledger
`started_at` timestamp, sourced from the same step read that supplies the view
state — no additional query. The progress embed derives a compact relative age
from it for running rows at render time, so each poll tick's freshly-minted
snapshot refreshes the age with no timer of its own. A row whose ledger
timestamp is absent carries none and renders as before.

#### Scenario: A running step's age refreshes at poll cadence

- **GIVEN** the newest run is non-terminal and a step row is `running` with a
  `started_at`
- **WHEN** the bounded poll refreshes the snapshot
- **THEN** the step's view carries the start time and the embed's rendered age
  reflects it, updating on each subsequent tick while the step stays running

#### Scenario: A missing start time degrades to today's rendering

- **GIVEN** a `running` step row whose `started_at` is null
- **WHEN** the snapshot is published
- **THEN** the step's view carries no start time and the row renders without an
  age

### Requirement: A refresh that cannot complete SHALL NOT disable future refreshes

The in-flight guard that makes the poll skip a tick while a refresh is running SHALL always be
released, including when that refresh never completes normally. A refresh SHALL therefore be
bounded, and its guard released, whether it succeeds, fails, or exceeds its bound.

This is the failure mode the existing skip rule creates and does not close. The guard is claimed
before the reads and released on their completion, so a read that never settles leaves it claimed
for the lifetime of the process. That does not merely stall one tick: it disables the bounded poll
**and** every event-triggered refresh at once, because both consult the same guard. Every live
surface then freezes at its last value with no error anywhere, which is indistinguishable from a
run that has stopped progressing.

The bound SHALL be comfortably longer than the poll interval — long enough that a merely slow
refresh completes and writes its snapshots, which the existing cadence requirement already
promises, and short enough that a wedged one is released within a small number of ticks. It is
expressed as a multiple of the poll interval rather than an independent constant, so the two
cannot drift apart when either is tuned.

A refresh abandoned at its bound SHALL leave the previous snapshots in place rather than writing a
partial or empty one, and SHALL be reported so the condition is diagnosable rather than silent.

#### Scenario: A refresh that never settles is abandoned and the guard released

- **GIVEN** a refresh whose reads do not settle
- **WHEN** its bound elapses
- **THEN** the refresh is abandoned, the in-flight guard is released, and a subsequent tick or lifecycle edge starts a new refresh

#### Scenario: One stalled refresh does not freeze every surface

- **GIVEN** a refresh has been abandoned at its bound
- **WHEN** the next poll tick fires
- **THEN** it proceeds rather than being skipped, and the sidebar and activity panel resume updating

#### Scenario: An abandoned refresh preserves the last good snapshots

- **WHEN** a refresh is abandoned at its bound
- **THEN** the previously published snapshots remain, and no empty or partial snapshot is written in their place

### Requirement: The store publishes the data profile as live progress

The store SHALL publish a live-progress entry for a **running** data profile, alongside
the per-run entries it already publishes. The entry SHALL carry what a profile has — an
identity, its start time, the workflow id its ledger row records, and whether
the entry is stale — and SHALL NOT carry completion counts or step views, because a profile has
no step decomposition. It SHALL NOT carry a display name: there is one profile per analysis and
it is always the same operation, so the name is a constant belonging to the render rather than a
fact the ledger supplies.

The refresh SHALL remain the single writer. The profile entry SHALL be built inside the same
generation-token guard as the run entries, from the profile row the refresh already reads, so no
second reader and no second staleness rule is introduced.

A `pending` profile SHALL NOT be published. The ledger writes the profile's start time only on
the transitions into `running`, so a pending row carries none — and a pending profile has no
workflow, so it has no stream and nothing reported. Publishing it would yield an entry that is a
name beside two blanks. `pending` means seeded and queued, and this entry describes work in
flight.

This SHALL NOT change the poll's arming condition, which counts a pending profile as active work.
That governs whether to keep looking, not whether there is anything to show.

A profile that reaches a terminal state SHALL have its entry removed on the next refresh.

The entry SHALL NOT replace or alter the per-run entries the RUNS section consumes. The rail's
data is unchanged by this requirement.

#### Scenario: A running profile publishes an entry

- **WHEN** a refresh reads a profile row in the `running` state
- **THEN** a profile progress entry is published carrying its start time and recorded workflow id

#### Scenario: A pending profile publishes no entry

- **WHEN** a refresh reads a profile row in the `pending` state
- **THEN** no profile progress entry is published
- **AND** the poll remains armed, because a pending profile is still active work

#### Scenario: A terminal profile's entry clears

- **WHEN** a profile reaches `completed` or `failed`
- **THEN** the next refresh removes its progress entry

#### Scenario: A profile with no recorded workflow id still publishes

- **WHEN** a refresh reads a running profile row whose workflow id is not yet recorded
- **THEN** an entry is published with no workflow id, rather than being withheld

#### Scenario: The rail's run data is unaffected

- **WHEN** a profile entry is published
- **THEN** the per-run progress entries the RUNS section reads are unchanged

### Requirement: A failed profile read carries the profile entry forward

When the read behind the profile entry fails, the refresh SHALL carry the previous entry forward
and mark it stale rather than dropping it — the same treatment a run whose step read blipped
already receives.

Without this, a transient database error would remove the profile entry entirely, because the
profile snapshot collapses to a single unavailable state on any read failure. A consumer would
then see the profile disappear and return, which is indistinguishable from the profile having
finished and a new one having started.

A carried-forward entry SHALL be marked stale so a consumer can render it as last-known rather
than current. The staleness SHALL be re-stamped on the transition into stale, so an entry that
read cleanly on the previous refresh stops advertising itself as fresh.

#### Scenario: A blip does not remove the profile entry

- **GIVEN** a profile entry was published on the previous refresh
- **WHEN** the profile read fails on the next refresh
- **THEN** the previous entry is carried forward and marked stale

#### Scenario: A recovered read clears staleness

- **GIVEN** a profile entry is carried forward and marked stale
- **WHEN** a later refresh reads the profile successfully
- **THEN** the entry is republished from the fresh read and is no longer marked stale

### Requirement: Live subjects are published in an order that never displaces a run

The store SHALL expose the active runs and the active profile as one ordered set of subjects, with
every run ahead of the profile. Run order within the set SHALL remain the existing newest-first
order.

Ordering by kind is a deliberate departure from the recency ordering used everywhere else in this
module, and the reason is provenance rather than recency: a profile is auto-triggered when a chat
opens on drifted inputs, so it can enter the set without the user having asked for anything. A
recency-ordered set would routinely place such a profile first and displace a run the user launched
deliberately on whichever surface reads the set's head as its default focus.

The ordered set SHALL be derived from the published entries rather than written independently, so
it introduces no additional writer and no additional staleness rule.

#### Scenario: A profile sorts behind a run

- **GIVEN** one run and one profile are active
- **WHEN** the subject set is read
- **THEN** the run precedes the profile

#### Scenario: A profile triggered after a run does not take the head

- **GIVEN** a run is active
- **WHEN** a profile is triggered afterwards and becomes active
- **THEN** the run remains at the head of the subject set

#### Scenario: A profile alone is the only subject

- **GIVEN** no run is active and a profile is running
- **WHEN** the subject set is read
- **THEN** it contains the profile as its only entry

#### Scenario: Runs keep their newest-first order

- **GIVEN** two runs are active
- **WHEN** the subject set is read
- **THEN** they appear in the same newest-first order the run entries are published in, ahead of any profile

### Requirement: The sidebar reports the open analysis's cumulative token usage

The sidebar SHALL render a USAGE section carrying the cumulative input and output token figures
recorded for the open analysis — two figures, never one summed number, since the ledger's remaining
quantities are breakdowns of those two rather than amounts alongside them. Where the rail's width
does not admit both, the section SHALL drop a figure rather than combine them.

Unlike the DATA PROFILE and RUNS sections, this section's source is the CLI's own local
ledger, not the harness ledger behind the booted runtime: the figure it reports is durable locally
and is therefore readable before the runtime is `ready` and while it is stopped. The section SHALL
NOT gate itself on boot state, and SHALL NOT introduce a poll.

The section SHALL refresh on the two edges the sidebar already observes — the conversation's message
count, which advances when a turn completes, and the run-observation bus event, which arrives as a
run progresses — rather than on a timer. An analysis with no recorded usage SHALL render a muted
absence, distinguished by tone from a zero.

A read failure SHALL render an unavailable state and SHALL NOT crash the sidebar or suppress the
sections around it, matching how every other section degrades.

#### Scenario: The figures are readable before the runtime boots

- **GIVEN** an analysis with recorded usage and a runtime that has not reached `ready`
- **WHEN** the sidebar renders
- **THEN** the USAGE section shows the analysis's cumulative figures rather than a pre-ready placeholder

#### Scenario: A completed turn advances the figures

- **WHEN** a turn completes and its calls are recorded
- **THEN** the section's figures reflect them without any timer elapsing

#### Scenario: A background run advances the figures

- **WHEN** a run launched outside the chat progresses and emits a run observation
- **THEN** the section's figures reflect the run's recorded calls

#### Scenario: An analysis with no recorded usage is not shown as zero

- **WHEN** the open analysis has no ledger rows
- **THEN** the section renders a muted absence rather than a zero figure

#### Scenario: A failed read degrades to unavailable

- **GIVEN** a ledger read that fails
- **WHEN** the sidebar renders
- **THEN** the USAGE section shows an unavailable state and every other section renders normally

