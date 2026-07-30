## ADDED Requirements

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
