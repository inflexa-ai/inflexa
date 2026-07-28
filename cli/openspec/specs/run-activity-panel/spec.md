# run-activity-panel Specification

## Purpose
TBD - created by archiving change live-run-observability. Update Purpose after archive.
## Requirements
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

The activity label SHALL be derived from the newest durable workflow step recorded for the
run's workflow family, rendered through the same human vocabulary the non-interactive run
command already uses (`model round N`, `tool <name>`, `dispatching sandbox command`,
`sandbox executing`). An unrecognised step name SHALL pass through verbatim rather than
collapse to a generic label, so a newly added step kind surfaces instead of hiding. When no
label can be resolved, the panel SHALL omit it and render the rest of the frontier.

The panel SHALL be present only while at least one run is active, and SHALL take no rows
when no run is active.

#### Scenario: A running step is named, attributed, and described

- **WHEN** a run has a step executing
- **THEN** the panel shows that step's human name, the agent that owns it, an activity label, and its elapsed time

#### Scenario: The panel is absent when nothing is running

- **WHEN** no run is active
- **THEN** the panel occupies no rows and the stream and input compose as they do today

#### Scenario: The panel does not repeat the rail's step list

- **WHEN** the panel is showing a run whose steps are listed in the sidebar
- **THEN** the panel shows the frontier only, and the step list appears exactly once on screen

#### Scenario: An unknown step kind is shown, not hidden

- **WHEN** the run's newest durable step has a name the label vocabulary does not recognise
- **THEN** the panel shows that name verbatim rather than a generic placeholder

### Requirement: The panel degrades rather than disappearing on a failed read

The panel SHALL keep rendering what it knows when the data behind it cannot be read. A step
ledger read that fails SHALL leave the panel showing the run's identity and its last known
frontier in a muted unavailable state, and SHALL NOT remove the panel, blank it, or present
a run as finished. An unresolvable activity label SHALL be omitted rather than substituted.

This mirrors the sidebar's degradation contract: a transient database fault is a normal
condition that self-heals on the next refresh, and a surface that vanishes on a blink is
indistinguishable from a run that ended.

#### Scenario: A read failure does not blank the panel

- **WHEN** the step read for the focused run fails during a refresh
- **THEN** the panel keeps showing the run and its last known frontier in an unavailable state

#### Scenario: A blip does not look like completion

- **WHEN** a read fails and the next refresh succeeds
- **THEN** the panel never showed the run as terminal, never auto-advanced, and resumes normally

#### Scenario: A missing label is omitted, not faked

- **WHEN** the activity label cannot be resolved for a running step
- **THEN** the panel renders the step's name, agent, and elapsed time without an activity label

### Requirement: The panel navigates between concurrent runs

When more than one run is active — including runs of different plans — the panel SHALL
show one of them and SHALL provide navigation to the others by both a keyboard chord and a
mouse click. The panel SHALL indicate its position within the set of active runs, so a
reader can tell that other runs exist and how many.

Navigation SHALL cycle: advancing past the last active run returns to the first.

#### Scenario: Two plans running at once are both reachable

- **WHEN** two runs of different plans are active
- **THEN** the panel shows one of them, indicates that another exists, and reaches it by chord or by click

#### Scenario: Navigation wraps

- **WHEN** the panel is showing the last run in the active set and the user advances
- **THEN** the panel shows the first run in the set

### Requirement: The panel auto-advances off a run that terminates

When the run the panel is showing reaches a terminal status, the panel SHALL move to
another active run rather than continue displaying a finished one. When no active run
remains, the panel SHALL empty itself and take no rows.

A terminated run's outcome is recorded by the settling run card and the completion notice;
the panel is a live surface and holds nothing once the work is over.

#### Scenario: A finished run yields the panel to a live one

- **WHEN** the focused run terminates while another run is still active
- **THEN** the panel advances to the still-active run without user action

#### Scenario: The last run finishing empties the panel

- **WHEN** the focused run terminates and no other run is active
- **THEN** the panel takes no rows, and the run's outcome remains visible through its settled card and its completion notice

### Requirement: The panel is dismissable and restorable

The user SHALL be able to dismiss the panel while runs are still active, and SHALL be able
to restore it. Dismissal SHALL NOT stop, alter, or hide the underlying run — the sidebar
keeps showing it, and completion notices still fire.

The restore affordance SHALL be discoverable both as a keybinding and as a command in the
palette, matching how the sidebar's own toggle is exposed.

#### Scenario: Dismissing hides the panel without touching the run

- **WHEN** the user dismisses the panel during an active run
- **THEN** the panel takes no rows, the run continues, the sidebar still shows its progress, and its completion still announces

#### Scenario: The panel can be brought back

- **WHEN** the user invokes the restore keybinding or its palette command while a run is active
- **THEN** the panel reappears showing an active run

### Requirement: The panel is opaque fixed chrome

The panel SHALL render as a full-width box painted with the panel background and SHALL NOT
shrink below its own height. It sits directly beneath the message stream's scroll region, and
a fixed row in that position that paints only its own glyphs lets scrolled content bleed
through the gaps between them.

Its layout SHALL be verified across a range of terminal heights, because this class of defect
is size-dependent and a single height hides it.

#### Scenario: Stream content does not bleed into the panel

- **WHEN** the stream is scrolled so content sits at the boundary with the panel
- **THEN** the panel's row renders its own background across the full width, with no stream content visible through it

#### Scenario: A short terminal does not collapse the panel

- **WHEN** the terminal is short enough to squeeze the layout
- **THEN** the panel keeps its rows and the scroll region absorbs the reduction

