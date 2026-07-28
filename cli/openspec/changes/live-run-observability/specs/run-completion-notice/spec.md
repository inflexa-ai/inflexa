## ADDED Requirements

### Requirement: A run reaching a terminal status announces itself

When a run reaches a terminal status, the TUI SHALL raise a transient notice stating the
run, its outcome, and how long it took — and, for a non-success outcome, what went wrong.

Terminal transitions SHALL be announced for every terminal status the ledger can hold, not
only success: a failed, partial, or cancelled run is at least as important to notice as a
completed one, and rendering a non-success outcome in the same tone as a success would be
worse than silence.

An announcement SHALL NOT require the user to be looking at any particular surface. In
particular, it SHALL NOT depend on the sidebar being visible or the run-activity panel
being undismissed.

#### Scenario: A completed run announces

- **WHEN** a run reaches a completed status
- **THEN** a notice names the run, states that it completed, and gives its duration

#### Scenario: A failed run announces its reason

- **WHEN** a run reaches a failed status
- **THEN** the notice is presented in the error tone and carries the failure reason

#### Scenario: Announcement is surface-independent

- **WHEN** a run terminates while the sidebar is hidden and the panel is dismissed
- **THEN** the notice still fires

### Requirement: Concurrent completions are queued, never overwritten

The transient-notice channel SHALL queue notices rather than replace a showing one, so two
runs terminating within the display window both reach the user. A replace-on-arrival
channel would silently drop a completion, which is the defect this capability exists to fix.

The queue SHALL be first-in-first-out and SHALL NOT drop pending notices. Concurrency here
is bounded by how many runs an analysis can have in flight, which is small, so a completion
notice has no realistic path to a backlog worth discarding — and every notice also has a
durable record, so the transient channel does not need a loss policy.

#### Scenario: Two runs finishing together both announce

- **WHEN** two runs terminate within the notice display window
- **THEN** both notices are shown in turn, and neither is discarded

#### Scenario: Notices show in the order the runs finished

- **WHEN** several runs terminate in quick succession
- **THEN** their notices are shown in completion order, and none is skipped

### Requirement: A run's outcome is recorded durably in the conversation thread

Alongside the transient notice, the terminal transition SHALL append a durable record of
the outcome to the analysis's conversation thread, at the point in time the run actually
finished.

The record SHALL be appended as a synthetic message — one that carries no turn boundary —
so it neither splits a turn for display paging or the token window, nor gives a tail
retraction a mid-turn cut point. It SHALL be authored through the harness's synthetic-message
constructor rather than by hand-assembling its marker.

Because the record lives in the thread the next turn's context is assembled from, the
conversation agent SHALL be able to answer whether a run finished without invoking a tool.
Appending the record SHALL NOT itself start a turn or cause the agent to respond.

#### Scenario: The outcome survives a reload

- **WHEN** a run completes and the user later reopens the analysis
- **THEN** the transcript still carries the run's outcome record at its chronological position

#### Scenario: The record does not split a turn

- **WHEN** a run's outcome is appended between two exchanges
- **THEN** turn grouping, the token window, and tail retraction all behave as though the record were part of the preceding turn

#### Scenario: The agent can answer without a tool call

- **WHEN** a run completes and the user then asks whether it is done
- **THEN** the run's outcome is present in the context assembled for that turn

#### Scenario: Appending does not provoke a reply

- **WHEN** a run completes while the conversation is idle
- **THEN** the record is appended and no assistant turn begins

### Requirement: Thread writes are serialized, and a racing user message queues

Durable writes to one analysis thread SHALL be serialized: the run-outcome append and a
chat turn's own append SHALL NOT interleave. The conversation store assumes a single writer
per thread — turn ordering is the host's responsibility — and a notice appended into the
middle of an unwinding turn would splice a message between that turn's rows.

A user message submitted while a run-outcome append is in progress SHALL be **queued and
then processed**, never dropped and never rejected. The composer SHALL accept the input and
the turn SHALL begin once the append completes, so the wait is invisible beyond a brief
delay before the assistant starts.

This serialization is distinct from, and SHALL NOT be implemented with, the generation token
that orders the conversation store's writes. That token exists to make the newest UI
operation win and silently drop older ones; a user's message and a run's outcome are both
durable and neither may be discarded in favour of the other.

Conversely, a run terminating while a chat turn is already in flight SHALL defer its append
until the turn's own append has completed. A completion notice is not time-critical, and the
transient toast still fires immediately, so deferring the durable record costs the user
nothing.

#### Scenario: A message sent at the moment a run lands is not lost

- **WHEN** the user submits a message while the run-outcome append is in flight
- **THEN** the message is accepted, queued, and its turn begins once the append completes

#### Scenario: A run landing mid-turn does not splice the turn

- **WHEN** a run terminates while a chat turn is streaming
- **THEN** the outcome append waits until the turn's append has completed, and the turn's rows stay contiguous

#### Scenario: The toast does not wait on the thread

- **WHEN** a run terminates while a chat turn is in flight
- **THEN** the completion notice is shown immediately, even though its durable record is deferred

#### Scenario: Neither writer is discarded

- **WHEN** a user message and a run outcome contend for the same thread
- **THEN** both are written, in the order they were admitted, and neither is dropped

### Requirement: Durable reactions are keyed against repeated delivery

Every durable or user-visible reaction SHALL be keyed by the run id together with its
terminal status — the notice and the thread record alike. The run-observation channel
re-delivers a run's state after a durable-runtime recovery, so a terminal transition can be
observed more than once; the keying is what stops a re-delivery producing a duplicate notice
or a duplicate record.

Purely presentational state SHALL NOT need this keying: rendering from the newest observed
state is idempotent by construction.

#### Scenario: A recovered run announces once

- **WHEN** the durable runtime recovers and re-delivers a run's terminal state
- **THEN** no second notice is raised and no second thread record is appended

#### Scenario: Distinct runs are not conflated

- **WHEN** two different runs reach terminal statuses
- **THEN** each produces its own notice and its own record

### Requirement: The announcement path degrades rather than blocking

A failure to append the durable record SHALL NOT suppress the transient notice, and a
failure in either SHALL NOT affect the run, the sidebar, or the conversation. Announcement
is an observation channel; a fault in it SHALL surface as a notice and be survivable.

#### Scenario: A failed append still announces

- **WHEN** the thread append fails for a completed run
- **THEN** the completion notice is still shown and the failure to record it is surfaced

#### Scenario: Announcement faults do not disturb the chat

- **WHEN** the announcement path errors
- **THEN** the conversation remains usable and no turn is failed or interrupted
