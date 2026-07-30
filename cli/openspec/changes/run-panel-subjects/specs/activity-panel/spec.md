## MODIFIED Requirements

### Requirement: A sticky panel shows the focused run's frontier

The chat shell SHALL carry a activity panel between the message stream and the input,
showing exactly one **subject** at a time at the chat column's width. A subject is either an
analysis run or the analysis's data profile — the two kinds of long-running work a user waits
on — and the panel SHALL render only what is true of the subject it is showing.

For a **run**, the panel's content SHALL be the run's **frontier** — the run's name, its
completion count and elapsed time, and for the step (or steps) currently running: the step's
human name, its owning agent, a live activity label, and how long it has been running.

For a **data profile**, the panel's content SHALL be the name `Data profile`, its elapsed time,
and its live activity label. The name is a constant, not a resolved value: there is one profile
per analysis and it is always the same operation, and it matches the sidebar's `DATA PROFILE`
section label so the two surfaces name the same work identically.

The panel SHALL NOT render a completion count or any step rows for a
profile: a profile is a single agent loop with no step decomposition, so it has no frontier and
no denominator. A fabricated count SHALL NOT be substituted — the panel's numbers are the
ledger's, and an invented denominator is worse than none.

The panel SHALL NOT render the run's full step list. The sidebar RUNS section owns that,
and duplicating it would put the same widget on screen twice. The panel exists to carry
what the sidebar's rail width cannot: at the rail's fixed column budget a step row cannot
hold a name, an agent, and an activity label, so those live here.

The activity label SHALL be derived from the harness's run-event stream for the focused
subject — for a run, the current step-activity the running step reports; for a profile, the
current activity the profile reports — which the harness emits on every tool call the subject's
agent makes and which already reads as a human phrase.
The panel SHALL NOT derive the label from the durability engine's step records. Those
records describe only *completed* steps, so a label taken from them names whatever finished
last rather than what is happening, and during the longest operations in a run it names an
instantaneous internal checkpoint; the engine's own stream-write bookkeeping also lands in
the same records and would be shown verbatim as the run's activity.

The panel SHALL resolve a profile's stream from the workflow id its ledger row records, and
SHALL NOT reconstruct that id by pattern-matching the durability engine's workflow table. A
profile whose row records no id yet SHALL render as a subject with no activity label.

A profile's activity parts carry a constant synthetic run identifier rather than a real one, so
the panel SHALL NOT filter or key a subject's activity by the identifier carried on the part.
The subscription is scoped to one workflow, which is what makes the identifier redundant.

When no activity can be resolved — before the first one arrives, or when the stream is
unavailable — the panel SHALL omit the label and render the rest of the subject rather
than substituting a placeholder.

The panel SHALL be present only while at least one subject is active, and SHALL take no rows
when none is active.

#### Scenario: A running step is named, attributed, and described

- **WHEN** a run has a step executing
- **THEN** the panel shows that step's human name, the agent that owns it, an activity label, and its elapsed time

#### Scenario: The label follows the agent's work

- **GIVEN** the panel is showing a step whose agent is running commands
- **WHEN** that agent begins a different tool call
- **THEN** the panel's activity label changes to describe the new call, without waiting for the step to finish

#### Scenario: A running profile reports what it is doing

- **WHEN** a data profile is running and its agent begins a tool call
- **THEN** the panel shows `Data profile`, its elapsed time, and an activity label describing that call

#### Scenario: A profile carries no count and no step rows

- **WHEN** the panel is showing a data profile
- **THEN** it renders no completion count and no step rows, and shows only the profile's name, elapsed time, and activity

#### Scenario: A profile's wait for its sandbox is reported

- **WHEN** a profile is provisioning its sandbox, before its agent loop has started
- **THEN** the panel shows the activity the profile reported for that phase, rather than showing the profile with no activity

#### Scenario: A profile with no recorded workflow id renders without activity

- **WHEN** a profile is running but its ledger row records no workflow id yet
- **THEN** the panel shows `Data profile` and its elapsed time with no activity line, and no error is surfaced

#### Scenario: Engine internals never reach the label

- **WHEN** the panel resolves its activity label
- **THEN** the value comes from the run-event stream, and no durability-engine step name or bookkeeping identifier is displayed

#### Scenario: An unresolved activity is omitted

- **WHEN** no activity has been reported for the running step
- **THEN** the panel renders the step's name, agent, and elapsed time with no activity line

#### Scenario: The panel is absent when nothing is running

- **WHEN** no run and no profile is active
- **THEN** the panel occupies no rows and the stream and input compose as they do today

#### Scenario: The panel does not repeat the rail's step list

- **WHEN** the panel is showing a run whose steps are listed in the sidebar
- **THEN** the panel shows the frontier only, and the step list appears exactly once on screen

### Requirement: The panel is opaque fixed chrome

The panel SHALL render as a full-width box painted with its own background and SHALL NOT
shrink below its own height. It sits directly beneath the message stream's scroll region, and
a fixed row in that position that paints only its own glyphs lets scrolled content bleed
through the gaps between them.

The panel SHALL be visually distinguishable from the transcript above it. It SHALL paint the
raised surface the application uses for docked chrome — the same surface as the status bar,
the sidebar, the ask prompt, and dialog panels — and SHALL cap itself against the stream with
a single rule along its top edge carrying the region's legend.

**The legend carries region state and region actions; the content rows carry the subject.** The
panel's position within the active set, and the chords that act on the panel itself, are facts
about the *view* rather than about the subject — so they belong to the frame, and the content rows
SHALL carry only what is true of the subject (its name, counts where it has them, elapsed time,
frontier where it has one, activity). The panel SHALL NOT spend a content row on chord hints, and
SHALL NOT place its position indicator on a row otherwise describing the subject.

The legend's region name SHALL be derived from the focused subject's kind, so the frame states
which kind of work is on screen. The name SHALL degrade by the same ladder as the rest of the
legend: because a border title is dropped silently rather than truncated when it does not fit,
each region name's fitting width SHALL be measured rather than inferred from another's.

The rule is required, not decorative: the raised surface separates from the stream background
by as little as 1.06:1 on the lightest built-in theme, which is a tint rather than an edge, so
the surface alone cannot carry the distinction. The panel SHALL NOT draw a rule along its
bottom edge, because the input's own top border already supplies that edge one row below and a
second rule would place two parallel hairlines around an empty row.

The panel's frame colour SHALL NOT vary with subject state. The input's border colour is its
focus and mode signal, and a state-coloured frame directly above it would read as a second
focus ring; subject state belongs to the panel's marker glyph and its words.

A subject's marker SHALL match the marker the sidebar uses for that same work, so one piece of
work is recognisable as itself across both surfaces — which matters most where a run and a
profile sit in one navigable set.

Its layout SHALL be verified across a range of terminal heights, because this class of defect
is size-dependent and a single height hides it.

#### Scenario: Stream content does not bleed into the panel

- **WHEN** the stream is scrolled so content sits at the boundary with the panel
- **THEN** the panel's rows, including its rule, render their own background across the full width, with no stream content visible through them

#### Scenario: A short terminal does not collapse the panel

- **WHEN** the terminal is short enough to squeeze the layout
- **THEN** the panel keeps its rows and the scroll region absorbs the reduction

#### Scenario: The panel reads as chrome, not as a message

- **WHEN** the panel renders beneath a transcript in any built-in theme
- **THEN** it is painted on the docked-chrome surface and capped by a labelled rule, so it is distinguishable from the blocks above it

#### Scenario: Region state and actions ride the legend

- **WHEN** several subjects are active and the panel is showing one of them
- **THEN** the legend names the region, states which subject of how many is shown, and names the chords that advance and dismiss the panel
- **AND** no content row carries the position indicator, and no row is spent on chord hints

#### Scenario: The legend names the focused subject's kind

- **WHEN** the panel is showing a data profile
- **THEN** the legend's region name identifies it as the profile region, not as the run region

#### Scenario: The legend degrades rather than vanishing when the panel is narrow

- **GIVEN** a legend too long to fit the panel's width
- **WHEN** the panel renders
- **THEN** it drops the least essential part of the legend and still renders the region's name, rather than rendering an unlabelled rule

#### Scenario: Each region name has its own measured fitting width

- **GIVEN** two region names of different lengths
- **WHEN** the panel narrows past the point where the longer name's full legend fits
- **THEN** that region degrades at its own measured boundary and still renders its region name

#### Scenario: Only one rule meets the input

- **WHEN** the panel renders directly above the input
- **THEN** exactly one horizontal rule separates them — the input's own top border

#### Scenario: The frame does not signal state

- **WHEN** the focused subject changes state, including becoming degraded
- **THEN** the panel's frame colour is unchanged and the state is conveyed by its marker and text

#### Scenario: A profile's marker matches the rail's

- **WHEN** a running profile is shown in the panel and in the sidebar at the same time
- **THEN** both use the same marker glyph and colour role for it

## ADDED Requirements

### Requirement: Every panel behaviour applies to every subject kind

The panel's navigation, auto-advance, dismissal, and degradation behaviours SHALL apply
uniformly to every subject kind. None of them SHALL be run-specific.

This is stated explicitly rather than left to be inferred from each requirement's wording,
because each was written when a run was the only subject and a reader cannot otherwise tell
whether "run" in those requirements is the general case or the only case. It is the general case.

Concretely: navigation SHALL cycle through runs and the profile alike, wrapping past the last
back to the first; a subject that reaches a terminal state SHALL yield the panel to another
active subject, and the panel SHALL empty itself when none remains; dismissal SHALL hide the
panel regardless of which kind is focused and SHALL NOT stop, alter, or hide the underlying
work; and a failed read behind any subject SHALL leave that subject showing its last known
state in a muted unavailable form rather than removing it, blanking it, or presenting it as
finished.

#### Scenario: Navigation reaches a profile running beside a run

- **GIVEN** one run and one data profile are both active
- **WHEN** the user advances the panel
- **THEN** the panel moves between the run and the profile, and the legend's position indicator reflects a set of two

#### Scenario: A finished profile yields the panel to a live run

- **GIVEN** the panel is showing a profile while a run is also active
- **WHEN** the profile reaches a terminal state
- **THEN** the panel shows the run, without user action

#### Scenario: A profile finishing alone empties the panel

- **GIVEN** the panel is showing a profile and no run is active
- **WHEN** the profile reaches a terminal state
- **THEN** the panel takes no rows

#### Scenario: A failed profile read degrades rather than removing the subject

- **GIVEN** the panel is showing a profile
- **WHEN** the ledger read behind it fails on a refresh
- **THEN** the panel keeps showing that profile's last known state, muted and marked unavailable
- **AND** the subject is not removed and is not presented as finished

#### Scenario: Dismissing a profile does not touch the profile

- **WHEN** the user dismisses the panel while a profile is focused
- **THEN** the panel hides, the profile keeps running, and the sidebar continues to show it
