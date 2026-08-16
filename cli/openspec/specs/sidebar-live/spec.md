# sidebar-live Specification

## Purpose
The sidebar's live-data contract: the DATA PROFILE and RUNS sections source the harness ledger through the booted runtime (never mocks), degrade gracefully pre-ready, refresh on lifecycle edges plus a bounded active-work poll, publish the newest active run's step progress for the RUNS section's in-rail progress embed, and open details flows (profile summary dialog — carrying the keybound re-profile action; the searchable runs picker → run-detail dialog) by section click and leader keybindings. Lives in `src/tui/hooks/sidebar_live.ts`, `src/tui/layout/sidebar.tsx`, and `src/tui/components/dialog/run_detail_dialog.tsx`.
## Requirements
### Requirement: The sidebar renders live ledger data with graceful degradation

The sidebar MUST source its DATA PROFILE and RUNS sections from the harness ledger, through the pool of the booted runtime. The sources are the data-profile status row and the newest runs of the analysis, never mock fixtures. Before the runtime is `ready`, the sections MUST render a muted placeholder, and no read runs. An unprofiled analysis renders "not profiled". A read failure renders an unavailable state. None of these states can crash or block the sidebar. Every state distinguishes itself by glyph and tone from the design system.

The RUNS section MUST render **every active run**, not only the newest. An active (non-terminal) run MUST render its own run block directly under its run row: the progress meter, `done/total`, and the bounded step window (the narrow windowed mount, `maxSteps` capped). The block does not show the name or tag heading again, because the run row above is the heading. A terminal run MUST render as a plain one-line row, and the terminal rows stay capped as before. The run id of the row keys the block. Thus the progress of one run under the row of a different run is not representable. The rail scrolls, thus its length tracks live work rather than history.

Live work MUST NOT come from a windowed listing. The runs listing caps at the newest few rows, ordered by start time, and it drops the OLDEST running run first. That run is exactly the long analysis that these surfaces keep visible. Thus the set of active runs MUST come from a separate, uncapped read. The two reads merge, thus a run outside the listing window is still listed and still tracked. The uncapped read is bounded by live concurrency, not by history. Its failure MUST degrade to the view of the listing alone, and it removes no run that the listing sees.

#### Scenario: A long-running run outside the listing window stays observable

- **WHEN** a run is still active but older than the newest N runs the listing returns
- **THEN** it is still listed, still tracked for progress, and still announces when it terminates

#### Scenario: A failed active read never subtracts coverage

- **WHEN** the uncapped active read fails while the listing succeeds
- **THEN** the section renders exactly what the listing alone would have shown

Runs and steps MUST carry a name rather than an opaque id wherever a name exists. A run MUST take the title of its plan, from the persisted plan. The fallback is the workflow name, then the id tail. The stored workflow name is identical on every row, and it identifies nothing. A step MUST take its plan-assigned name, with its step id as the fallback, and it MUST show the agent that owns it.

The rendered state of a step MUST keep the distinctions that the ledger records. A skipped step MUST be distinguishable from one that waits to start. A blocked step MUST surface the recorded reason, and it does not read as an ordinary failure. A retried step MUST show the retry.

The completed-profile line MUST show the absolute completed time (`toLocaleString()`, matching the details dialog), not a relative age. A profile is a durable record, referenced long after it ran. A bare `8h` forces the reader to do date arithmetic that the absolute time answers directly. The RUNS rows keep compact relative ages. An absolute timestamp on every run row would exceed the usable width of the rail, and each row would wrap. The SESSION created time is absolute for the same durable-record reason, per the sidebar requirement of `tui-layout`.

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
- **THEN** the run row shows the plan title, and each step row shows its plan name and owning agent
- **AND** no row falls back to an id tail or a step slug while the name exists

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

### Requirement: The sidebar reports the open session's token usage

The sidebar SHALL render a USAGE section carrying the token figures recorded for the open SESSION — every call stamped with the open thread, INCLUDING the runs that session launched. It SHALL show input and output, and beneath input the cache-write and cache-read quantities as parts of it, per the `usage-figure-rendering` capability. It SHALL NOT render a combined total.

The section SHALL use the LABELLED form. Consumption is what this section is FOR — it is the only rail section whose entire subject is a number, and it is read deliberately rather than scanned — so it can afford the words and gains nothing from terseness. The compact form is reserved for the figures DECORATING the DATA PROFILE and RUNS rows, whose subject is the entity and where a labelled figure would crowd the name it annotates.

Its two arms SHALL share one row at the section's opposite edges, with the cache quantities indented beneath input, per `usage-figure-rendering`. The section SHALL NOT stack the arms: a rail row is the scarcest thing it spends, and the nesting that has to be preserved is the one BETWEEN an arm and its parts, not one between the two arms.

Runs are included deliberately. A conversation's own calls can be a small fraction of what it caused — a chat turn that launches a run may itself spend a few thousand tokens while the run spends hundreds of thousands — and a headline reporting only the former immediately after the user launched the latter understates by orders of magnitude. The rail shows the run's own figure directly above, so the containment is visible rather than concealed. This is a different reading from the session GRAIN reported by `usage-breakdown`, which excludes runs so the grains partition the analysis total; each surface SHALL make clear which reading it shows.

The section's source is the CLI's own local ledger, not the harness ledger behind the booted runtime, so its figure is readable before the runtime is `ready` and while it is stopped. The section SHALL NOT gate itself on boot state.

An analysis with no open session, and a session with no recorded usage, SHALL each render a muted absence distinguished by tone from a zero. A read failure SHALL render an unavailable state and SHALL NOT crash the sidebar or suppress the sections around it, matching how every other section degrades.

#### Scenario: The two arms share a row

- **WHEN** the USAGE section renders a figure carrying cache quantities
- **THEN** input and output sit on one row at the section's two edges, with the cache quantities indented on the rows beneath

#### Scenario: The session figure includes the run it launched

- **GIVEN** a conversation whose own calls reported far less than the run it launched
- **WHEN** the USAGE section renders
- **THEN** it reports both together, not the conversation's calls alone

#### Scenario: Background work outside every session is excluded

- **GIVEN** an analysis whose data profile ran with no thread stamped on its calls
- **WHEN** the USAGE section renders
- **THEN** the profile's figures are absent from it, and the DATA PROFILE section carries them instead

#### Scenario: The figures are readable before the runtime boots

- **GIVEN** a session with recorded usage and a runtime that has not reached `ready`
- **WHEN** the sidebar renders
- **THEN** the USAGE section shows the session's figures rather than a pre-ready placeholder

#### Scenario: A session with no recorded usage is not shown as zero

- **WHEN** the open session has no ledger rows
- **THEN** the section renders a muted absence rather than a zero figure

#### Scenario: A failed read degrades to unavailable

- **GIVEN** a ledger read that fails
- **WHEN** the sidebar renders
- **THEN** the USAGE section shows an unavailable state and every other section renders normally

### Requirement: The usage figure refreshes on turn completion and on the bounded poll

The USAGE section SHALL refresh when the chat status transitions out of its busy state — the turn actually completing — and on the bounded poll this capability already arms while work is active, and on the run-observation event it already observes. It SHALL NOT depend on the conversation's message count.

The message count is not a turn-completion signal: the assistant message is pushed when the turn STARTS, so the section's last read of a turn happens before any of that turn's calls have been recorded. It also stops changing once the store reaches its message cap, at which point a memo depending on it never fires again. The chat status transition is the completion event stated directly rather than inferred.

No second timer SHALL be introduced. The poll that refreshes the rail's other live data is already armed only while work is active and disarmed when it is not, and a second interval would be a second thing to keep armed and disarmed in step with the first.

While no work is active the poll is disarmed by design, so the section's currency between turns rests on the completion edge — which is exact, since a turn's calls are recorded inside the loop before it finishes.

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

#### Scenario: An idle rail issues no usage queries

- **GIVEN** no active run, no pending profile, and no turn in flight
- **WHEN** time passes
- **THEN** no usage read is issued

### Requirement: The data profile and each run report their own token usage

The DATA PROFILE section SHALL carry the data profile's own recorded figures, and each run row in the RUNS section SHALL carry that run's. Each SHALL use the COMPACT form: the figure decorates a row whose subject is the entity, so it must annotate without competing with the name it sits under.

The figure SHALL join the facts its row already carries, separated in the same vocabulary — never on a line of its own. It had one, justified by a measurement that appending ~13 cells soft-wraps a rail row; the row wraps regardless, because a plan title is a sentence and already spans two or three rail rows, so the separate line was adding a further one rather than preventing a wrap. Inline, a run's spend reads beside its age, which is where a reader looks for it.

The profile's figures have no other home: its calls carry no thread, so they belong to no session and appear in no session figure. Rendering them on the section that names the profile is what keeps recorded consumption from being invisible in the rail while still counting toward the analysis.

An entity whose calls reported nothing SHALL render a muted absence rather than a zero, and a failed usage read SHALL leave the section's other content intact — a missing figure SHALL never remove the entity it decorates.

#### Scenario: The profile's spend is visible where the profile is named

- **GIVEN** a completed data profile whose calls were recorded
- **WHEN** the sidebar renders
- **THEN** the DATA PROFILE section carries its figures

#### Scenario: A run's spend reads beside its age

- **WHEN** a run row renders with recorded figures
- **THEN** the figure sits on that row after the run's age, separated in the row's own vocabulary, not on a line beneath it

#### Scenario: A run row carries its own figures

- **GIVEN** an analysis with two runs of differing consumption
- **WHEN** the RUNS section renders
- **THEN** each row carries its own run's figures

#### Scenario: A failed usage read leaves the entity rendered

- **GIVEN** a usage read that fails for a run
- **WHEN** the RUNS section renders
- **THEN** the run row still renders with its status and progress, without its figure

### Requirement: The profile and run detail dialogs report usage as a property, and the run's steps report their own

The data-profile details view and the run-detail dialog SHALL each carry the entity's recorded figures as one more property line, in the same `label value` vocabulary as the timings above it and in the LABELLED form — a full-width panel being read deliberately, unlike the rail's decorations. The run-detail dialog SHALL additionally carry the run's call count beside its figures, which is the only thing distinguishing a run whose provider reported nothing from a run that made no calls at all.

Each STEP listed in the run-detail dialog SHALL carry that step's own recorded figures, in the COMPACT form, matching what the rail's live run block shows while the run is in flight — a finished run reviewed here must read the same as it did while it was running, or the reader learns two layouts for one thing.

A step's figure SHALL join that row's other facts in the one separated sequence the row already reads in — the owning agent, the elapsed age, the retry count — on EVERY mount, and SHALL NOT be flushed to the row's trailing edge or given a line of its own.

Not flushed, because flushing aligns a comparable column only while the row's left side is stable, and it is not: a running step gains an age, a retried one a count, an expanded one its agent. The gap then breathes as the run progresses and the figure reads as detached from the step it belongs to — worst while the run is being watched live. Comparing steps against each other belongs to the surfaces built for it; this row reports ONE step's facts.

No line of its own either, and no narrow-rail exception. That exception existed, justified by a measurement that a trailing figure soft-wraps the rail's row — a measurement taken against short identifier-shaped labels. Real plan step labels are sentences, so the row wraps whether or not it carries a figure, and the separate line was not preventing a wrap: it was adding a third line to a row already taking two.

#### Scenario: A step's figure stays with the step's other facts

- **GIVEN** two steps whose labels differ in length, each carrying a figure
- **WHEN** the step list renders
- **THEN** each figure follows its own step's facts rather than aligning to a shared trailing column

#### Scenario: A wrapping label costs the same rows with a figure as without

- **GIVEN** a step whose label is long enough to wrap the rail's width
- **WHEN** it renders with a figure and without one
- **THEN** it occupies the same number of rows in both cases

The step figures SHALL be read once for the OPENED run rather than batched across every row the picker drew: a picker lists many runs and the reader opens one, so batching would query every listed run's steps to serve the one that gets picked. The read SHALL be handed to the dialog as data, keeping it pure and drivable offline by the design gallery.

A step the ledger has nothing for SHALL carry no figure — never a zeroed one — and SHALL still render its row. A failed usage read SHALL leave the dialog fully rendered without figures; a missing decoration SHALL never remove the record it decorates.

The steps' figures SHALL NOT be presented as summing to the run's own figure. A run spends tokens outside any step (planning, synthesis dispatch), so the step rows are a partial view of the run's total by construction.

#### Scenario: The profile's spend reads as one of its properties

- **WHEN** the data-profile details view opens on a profile whose calls were recorded
- **THEN** it carries a `usage` line in the labelled form, among the status and timing lines

#### Scenario: A run's steps each report their own spend

- **GIVEN** an opened run whose steps have recorded calls
- **WHEN** the run-detail dialog renders its step list
- **THEN** each step carries its own compact figure, beneath its own row

#### Scenario: A step the ledger has nothing for keeps its row

- **GIVEN** a run one of whose steps made no calls, and another whose calls reported no quantity
- **WHEN** the step list renders
- **THEN** both steps render without a figure, and neither shows a zero

### Requirement: Active-run step views carry each step's recorded usage

The active-run progress the store publishes SHALL carry, per step, that step's recorded figures, fetched inside the same generation-token guard as the step read it accompanies and keyed by the same run id.

The figure SHALL be threaded onto the published step view rather than looked up by the renderer, so the run block stays a pure renderer of what it is handed and remains drivable offline by the design gallery and by tests. A step whose calls reported nothing SHALL carry no figure rather than a zeroed one.

When no run is active, no step usage read SHALL run, preserving the idle-costs-nothing property this capability already holds for the step read itself.

#### Scenario: A running step shows what it has spent so far

- **GIVEN** a non-terminal run whose first step has recorded calls
- **WHEN** the progress entry is published
- **THEN** that step's view carries its figures

#### Scenario: Steps of other runs do not appear

- **GIVEN** two active runs with recorded step usage
- **WHEN** each run's progress is published
- **THEN** each step view carries only its own run's figures

#### Scenario: An idle rail issues no step usage read

- **GIVEN** no active run
- **WHEN** a refresh runs
- **THEN** no step usage query is issued
