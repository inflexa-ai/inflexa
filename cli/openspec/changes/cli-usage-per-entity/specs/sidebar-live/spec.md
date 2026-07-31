## REMOVED Requirements

### Requirement: The sidebar reports the open analysis's cumulative token usage

**Reason**: Two of its terms are replaced rather than adjusted. Its scope was the whole analysis, which made it the only rail section answering a question other than "what is in front of me"; and its refresh contract ("SHALL NOT introduce a poll", refreshing on "the conversation's message count, which advances when a turn completes") rests on a claim that does not hold — the message count advances when the assistant message is CREATED, so the section renders a figure from before the turn's calls were recorded, and past the store's message cap the push-and-shift leaves the count unchanged and the section stops refreshing entirely.

**Migration**: Replaced by "The sidebar reports the open session's token usage" below, which re-scopes the section to the session, adds the cache breakdown, and moves the refresh onto the bounded poll this capability already arms plus an explicit turn-completion edge. The read-before-boot and degrade-to-unavailable guarantees are carried forward unchanged.

## ADDED Requirements

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

The profile's figures have no other home: its calls carry no thread, so they belong to no session and appear in no session figure. Rendering them on the section that names the profile is what keeps recorded consumption from being invisible in the rail while still counting toward the analysis.

An entity whose calls reported nothing SHALL render a muted absence rather than a zero, and a failed usage read SHALL leave the section's other content intact — a missing figure SHALL never remove the entity it decorates.

#### Scenario: The profile's spend is visible where the profile is named

- **GIVEN** a completed data profile whose calls were recorded
- **WHEN** the sidebar renders
- **THEN** the DATA PROFILE section carries its figures

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
