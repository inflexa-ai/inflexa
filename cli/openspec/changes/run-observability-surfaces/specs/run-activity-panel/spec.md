## MODIFIED Requirements

### Requirement: A sticky panel shows the focused run's frontier

The chat shell SHALL carry a run-activity panel between the message stream and the input,
showing exactly one run at a time at the chat column's width. Its content SHALL be the
run's **frontier** — the run's name, its completion count and elapsed time, and for the
step (or steps) currently running: the step's human name, its owning agent, a live activity
label, and how long it has been running.

The panel SHALL NOT render the run's full step list. The sidebar RUNS section owns that,
and duplicating it would put the same widget on screen twice. The panel exists to carry
what the sidebar's rail width cannot: at the rail's fixed column budget a step row cannot
hold a name, an agent, and an activity label, so those live here.

The activity label SHALL be derived from the harness's run-event stream for the focused
run — specifically the current step-activity the running step reports, which the harness
emits on every tool call the step's agent makes and which already reads as a human phrase.
The panel SHALL NOT derive the label from the durability engine's step records. Those
records describe only *completed* steps, so a label taken from them names whatever finished
last rather than what is happening, and during the longest operations in a run it names an
instantaneous internal checkpoint; the engine's own stream-write bookkeeping also lands in
the same records and would be shown verbatim as the run's activity.

When no activity can be resolved — before the first one arrives, or when the stream is
unavailable — the panel SHALL omit the label and render the rest of the frontier rather
than substituting a placeholder.

The panel SHALL be present only while at least one run is active, and SHALL take no rows
when no run is active.

#### Scenario: A running step is named, attributed, and described

- **WHEN** a run has a step executing
- **THEN** the panel shows that step's human name, the agent that owns it, an activity label, and its elapsed time

#### Scenario: The label follows the agent's work

- **GIVEN** the panel is showing a step whose agent is running commands
- **WHEN** that agent begins a different tool call
- **THEN** the panel's activity label changes to describe the new call, without waiting for the step to finish

#### Scenario: Engine internals never reach the label

- **WHEN** the panel resolves its activity label
- **THEN** the value comes from the run-event stream, and no durability-engine step name or bookkeeping identifier is displayed

#### Scenario: An unresolved activity is omitted

- **WHEN** no activity has been reported for the running step
- **THEN** the panel renders the step's name, agent, and elapsed time with no activity line

#### Scenario: The panel is absent when nothing is running

- **WHEN** no run is active
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
a single rule along its top edge carrying a short label naming the region.

The rule is required, not decorative: the raised surface separates from the stream background
by as little as 1.06:1 on the lightest built-in theme, which is a tint rather than an edge, so
the surface alone cannot carry the distinction. The panel SHALL NOT draw a rule along its
bottom edge, because the input's own top border already supplies that edge one row below and a
second rule would place two parallel hairlines around an empty row.

The panel's frame colour SHALL NOT vary with run state. The input's border colour is its
focus and mode signal, and a state-coloured frame directly above it would read as a second
focus ring; run state belongs to the panel's marker glyph and its words.

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

#### Scenario: Only one rule meets the input

- **WHEN** the panel renders directly above the input
- **THEN** exactly one horizontal rule separates them — the input's own top border

#### Scenario: The frame does not signal state

- **WHEN** the focused run changes state, including becoming degraded
- **THEN** the panel's frame colour is unchanged and the state is conveyed by its marker and text

## ADDED Requirements

### Requirement: Elapsed readouts advance on their own clock

The panel's elapsed and relative-age readouts SHALL be driven by a periodic clock, independent
of when its run data is refreshed.

Computing them only as a side effect of a data refresh couples a clock to a feed: if the feed
stalls, the readouts freeze at their last value and the panel reads as a run that has stopped
progressing rather than as a view that has stopped updating. Those two states call for opposite
responses from the reader, so they must not look identical.

#### Scenario: Elapsed advances between data refreshes

- **WHEN** a run is active and no new run data has arrived
- **THEN** the panel's elapsed readout continues to advance

#### Scenario: A stalled feed is legible as a stalled feed

- **WHEN** the run data feed stops updating while a run is still active
- **THEN** elapsed keeps advancing, so the reader can distinguish a stalled view from a stalled run
