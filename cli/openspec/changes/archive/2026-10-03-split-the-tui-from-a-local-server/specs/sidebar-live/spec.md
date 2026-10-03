# sidebar-live Delta

## MODIFIED Requirements

### Requirement: The sidebar renders live ledger data with graceful degradation

The sidebar MUST source its DATA PROFILE and RUNS sections from the harness ledger, through the data-profile and run routes of the local server. The sources are the data-profile status row and the newest runs of the analysis, never mock fixtures. Before the runtime of the server is `ready`, the sections MUST render a muted placeholder, and no request goes out. An unprofiled analysis renders "not profiled". A read failure renders an unavailable state. None of these states can crash or block the sidebar. Every state distinguishes itself by glyph and tone from the design system.

The RUNS section MUST render **every active run**, not only the newest. An active (non-terminal) run MUST render its own run block directly under its run row: the progress meter, `done/total`, and the bounded step window (the narrow windowed mount, `maxSteps` capped). The block does not show the name or tag heading again, because the run row above is the heading. A terminal run MUST render as a plain one-line row, and the terminal rows stay capped as before. The run id of the row keys the block. Thus the progress of one run under the row of a different run is not representable. The rail scrolls, thus its length tracks live work rather than history.

Live work MUST NOT come from a windowed listing. The runs listing caps at the newest few rows, ordered by start time, and it drops the OLDEST running run first. That run is exactly the long analysis that these surfaces keep visible. Thus the set of active runs MUST come from a separate, uncapped read. The two reads merge, thus a run outside the listing window is still listed and still tracked. The uncapped read is bounded by live concurrency, not by history. Its failure MUST degrade to the view of the listing alone, and it removes no run that the listing sees.

Runs and steps MUST carry a name rather than an opaque id wherever a name exists. A run MUST take the title of its plan, from the persisted plan. The fallback is the workflow name, then the id tail. The stored workflow name is identical on every row, and it identifies nothing. A step MUST take its plan-assigned name, with its step id as the fallback, and it MUST show the agent that owns it.

The rendered state of a step MUST keep the distinctions that the ledger records. A skipped step MUST be distinguishable from one that waits to start. A blocked step MUST surface the recorded reason, and it does not read as an ordinary failure. A retried step MUST show the retry.

The completed-profile line MUST show the absolute completed time (`toLocaleString()`, matching the details dialog), not a relative age. A profile is a durable record, referenced long after it ran. A bare `8h` forces the reader to do date arithmetic that the absolute time answers directly. The RUNS rows keep compact relative ages. An absolute timestamp on every run row would exceed the usable width of the rail, and each row would wrap. The SESSION created time is absolute for the same durable-record reason, per the sidebar requirement of `tui-layout`.

#### Scenario: A long-running run outside the listing window stays observable

- **WHEN** a run is still active but older than the newest N runs the listing returns
- **THEN** it is still listed, still tracked for progress, and still announces when it terminates

#### Scenario: A failed active read never subtracts coverage

- **WHEN** the uncapped active read fails while the listing succeeds
- **THEN** the section renders exactly what the listing alone would have shown

#### Scenario: Sections degrade before the runtime is ready

- **WHEN** the sidebar renders while the runtime of the local server is still booting
- **THEN** the DATA PROFILE and RUNS sections show muted placeholders and no request for them goes out

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

### Requirement: A refresh that cannot complete SHALL NOT disable future refreshes

The in-flight guard that makes the poll skip a tick while a refresh is running SHALL always be
released, including when that refresh never completes normally. A refresh SHALL therefore be
bounded, and its guard released, whether it succeeds, fails, or exceeds its bound.

This is the failure mode the existing skip rule creates and does not close. The guard is claimed
before the reads and released on their completion, so a read that never settles leaves it claimed
for the lifetime of the process. That does not merely stall one tick: it disables the bounded poll
for good, and every live surface then freezes at its last value with no error anywhere, which is
indistinguishable from a run that has stopped progressing.

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

### Requirement: The sidebar reports the open session's token usage

The sidebar SHALL render a USAGE section carrying the token figures recorded for the open SESSION — every call stamped with the open thread, INCLUDING the runs that session launched. It SHALL show input and output, and beneath input the cache-write and cache-read quantities as parts of it, per the `usage-figure-rendering` capability. It SHALL NOT render a combined total.

The section SHALL use the LABELLED form. Consumption is what this section is FOR — it is the only rail section whose entire subject is a number, and it is read deliberately rather than scanned — so it can afford the words and gains nothing from terseness. The compact form is reserved for the figures DECORATING the DATA PROFILE and RUNS rows, whose subject is the entity and where a labelled figure would crowd the name it annotates.

Its two arms SHALL share one row at the section's opposite edges, with the cache quantities indented beneath input, per `usage-figure-rendering`. The section SHALL NOT stack the arms: a rail row is the scarcest thing it spends, and the nesting that has to be preserved is the one BETWEEN an arm and its parts, not one between the two arms.

Runs are included deliberately. A conversation's own calls can be a small fraction of what it caused — a chat turn that launches a run may itself spend a few thousand tokens while the run spends hundreds of thousands — and a headline reporting only the former immediately after the user launched the latter understates by orders of magnitude. The rail shows the run's own figure directly above, so the containment is visible rather than concealed. This is a different reading from the session GRAIN reported by `usage-breakdown`, which excludes runs so the grains partition the analysis total; each surface SHALL make clear which reading it shows.

The section's source is the local usage ledger, read through the usage route of the local server, not the harness ledger behind the booted runtime. That route needs no harness runtime, so the figure is readable before the runtime is `ready` and after a failed boot. The section SHALL NOT gate itself on boot state.

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

- **GIVEN** a session with recorded usage and a runtime of the local server that has not reached `ready`
- **WHEN** the sidebar renders
- **THEN** the USAGE section shows the session's figures rather than a pre-ready placeholder

#### Scenario: A session with no recorded usage is not shown as zero

- **WHEN** the open session has no ledger rows
- **THEN** the section renders a muted absence rather than a zero figure

#### Scenario: A failed read degrades to unavailable

- **GIVEN** a usage read that fails
- **WHEN** the sidebar renders
- **THEN** the USAGE section shows an unavailable state and every other section renders normally

### Requirement: The usage figure refreshes on turn completion and on the bounded poll

The USAGE section SHALL refresh when the chat status transitions out of its busy state — the turn actually completing — and on each refresh of the rail's live data, which includes the bounded poll this capability already arms while work is active. It SHALL NOT depend on the conversation's message count.

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

## REMOVED Requirements

### Requirement: Sidebar data refreshes on lifecycle edges and bounded polling

**Reason**: The TUI holds no bus subscription. The local server sends no run-observation event, thus no refresh comes from an event, and a run of a different client shows at the next edge of this client.
**Migration**: The requirement "Sidebar data refreshes on lifecycle edges and a bounded poll of the local server" gives the refresh edges.

## ADDED Requirements

### Requirement: Sidebar data refreshes on lifecycle edges and a bounded poll of the local server

The sidebar's live data SHALL refresh when the runtime of the local server reaches `ready`, when the
workspace analysis changes, when a chat turn completes, and when a profile drive that this client asked
for changes ledger state outside those edges (a trigger, restart, or clear pokes the store — see
`tui-harness-chat`); while the last snapshot shows active work (a pending/running profile or a
non-terminal run) it SHALL additionally poll on a bounded interval — and SHALL stop polling once no work
is active, so an idle sidebar issues zero requests.

The local server sends no event when a run or a profile changes. Thus a run that a different client or
a chat turn of a different client starts, and a re-profile that the server starts after an input
change, SHALL become visible at the next of these edges, not at once.

A refresh SHALL claim a monotonic generation token at entry and re-check it after each read, so the
newest refresh started is the only one that writes. Because that token makes a newer refresh *cancel* an
older one, the **poll** SHALL additionally skip its tick whenever a refresh is already in flight. Without
that skip, reads slower than the interval would leave every tick superseded by the next and the store
would never receive a write at all — and since an `unavailable` snapshot is itself an arming condition,
a degraded server would be re-queried on every tick behind a permanently frozen section.

Lifecycle-edge refreshes SHALL NOT skip: they carry new information and are required to supersede.

For **every** non-terminal run in the freshly-read snapshot, the refresh SHALL additionally read that
run's detail from the run route of the local server (inside the same generation-token guard): its
steps, the plan name of each step, and the usage of each step. It SHALL publish an active-run progress
entry — run label, done/total counts, and per-step view states carrying each step's name, owning agent,
and recorded blocked reason and attempt count where present. The published progress SHALL be keyed by
run id. A run that reaches a terminal status SHALL have its entry removed. When no run is active, no
entry SHALL be published and no run detail SHALL be read, preserving the idle-costs-nothing property.
A runs page SHALL resolve each distinct plan at most once, so several runs of one plan on one page cost
one plan read.

The step-status → view-state mapping SHALL be defined once in the sidebar-live module and shared
with the run-detail dialog and the run-activity panel, so no surface invents its own reading of a
ledger status.

#### Scenario: A run launched from chat appears without user action

- **WHEN** the agent launches a run during a turn
- **THEN** the RUNS section shows the new run after the turn completes, and its status keeps updating while the run is active

#### Scenario: A run of a different client shows at the next edge

- **GIVEN** an idle sidebar, with no poll armed
- **WHEN** a different client of the same server starts a run on the open analysis
- **THEN** the RUNS section shows the run at the next refresh edge of this client, for example the completion of its next turn

#### Scenario: A profile drive's consequences appear without user action

- **WHEN** the parity drive of a chat open, or a deliberate re-profile, triggers or clears the profile
- **THEN** the DATA PROFILE section reflects the new ledger state (running, or not profiled) without the user touching the sidebar

#### Scenario: Idle costs nothing

- **WHEN** no profile is running and every run is terminal
- **THEN** no polling interval is active, and no run detail is read

#### Scenario: A slow read degrades cadence, not liveness

- **WHEN** a refresh's reads take longer than the poll interval
- **THEN** the intervening ticks SHALL be skipped rather than superseding the in-flight refresh
- **AND** that refresh SHALL complete and write its snapshots

#### Scenario: A recovering server self-heals

- **WHEN** the reads fail (arming the poll via `unavailable`) and then begin succeeding, while each read is slower than the interval
- **THEN** a refresh SHALL complete and the sections SHALL leave the `unavailable` state

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
