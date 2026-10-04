# run-completion-notice Specification

## Purpose
How the TUI tells the user that a run reached a terminal status. Each terminal transition raises a transient notice with the run, the outcome, and the duration, and a later notice never replaces an earlier one. The notice does not depend on a visible surface, and a failed read of the runs never breaks the chat.

## Requirements

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

A completion notice SHALL NOT be destroyed by a later notice arriving: two runs terminating
within one display window SHALL both reach the user. Replace-on-arrival delivery would
silently drop a completion, which is the defect this capability exists to fix.

Queueing SHALL be a per-notice choice rather than the channel's only discipline, and the
completion notice SHALL select it. The same channel carries SOLICITED feedback — a copy
confirmation, a theme change, a command error — which answers a keystroke the user just made.
For those the newest is the one that matters, and queueing them would play two identical
toasts for two presses of the same key, making the second press look like it did something
different. The two kinds want opposite delivery, so the caller states which it is.

The queue SHALL be first-in-first-out and SHALL NOT drop pending notices on arrival. A
solicited notice MAY take the display slot from a showing notice, but SHALL NOT discard what
is queued behind it. Concurrency here is bounded by how many runs an analysis can have in
flight, which is small, so a completion notice has no realistic path to a backlog worth
discarding — and every notice also has a durable record, so the transient channel does not
need a loss policy.

#### Scenario: Two runs finishing together both announce

- **WHEN** two runs terminate within the notice display window
- **THEN** both notices are shown in turn, and neither is discarded

#### Scenario: Notices show in the order the runs finished

- **WHEN** several runs terminate in quick succession
- **THEN** their notices are shown in completion order, and none is skipped

#### Scenario: Repeated solicited feedback replaces rather than queues

- **WHEN** the user triggers the same solicited notice twice in quick succession
- **THEN** the second replaces the first, rather than playing two identical toasts in turn

#### Scenario: Solicited feedback does not discard queued completions

- **WHEN** a solicited notice is raised while completion notices are still queued
- **THEN** it is shown immediately, and the queued completions are delivered after it

### Requirement: A completion notice is keyed against repeated observation

Every user-visible reaction SHALL be keyed by the run id together with its terminal status. The TUI
detects a terminal transition from the runs snapshot that its sidebar reads from the local server,
and the server sends no event when a run ends. A durable-runtime recovery can move a run's row
through its terminal state again, and a later read observes it again, so a terminal transition can
be observed more than once; the keying is what stops a second observation producing a duplicate
notice.

A run SHALL be announced only when this client observed it non-terminal and then terminal. Thus the
first read after the TUI opens an analysis announces no run that had already finished, and a run that
starts and ends between two reads of this client is not announced. The snapshot covers each run of
the open analysis, whichever client or process started it. A run of a different analysis SHALL NOT
be announced while the user is away from it; when the user switches back, the next read announces
it.

Purely presentational state SHALL NOT need this keying: rendering from the newest observed state is
idempotent by construction.

#### Scenario: A recovered run announces once

- **WHEN** the durable runtime recovers and a later read observes a run's terminal state again
- **THEN** no second notice is raised

#### Scenario: Distinct runs are not conflated

- **WHEN** two different runs reach terminal statuses
- **THEN** each produces its own notice

#### Scenario: History is not news

- **WHEN** the TUI opens an analysis whose runs had already finished
- **THEN** no notice is raised for those runs

#### Scenario: A run that a different client started announces

- **WHEN** a run that a different client started reaches a terminal status, and this TUI observed it running
- **THEN** this TUI raises the notice of that run

### Requirement: A failed read of the runs degrades the announcement, never the chat

A failed read of the runs SHALL NOT raise a notice, and a failure in the announcement path SHALL NOT
affect the run, the sidebar, or the conversation. Announcement is an observation channel: the next
successful read announces each transition that it observes, and a fault in the channel is
survivable.

#### Scenario: A failed read raises no false notice

- **WHEN** a read of the runs fails while a run is active
- **THEN** no notice is raised, and the next successful read announces the run if it then reads terminal

#### Scenario: Announcement faults do not disturb the chat

- **WHEN** the announcement path errors
- **THEN** the conversation remains usable and no turn is failed or interrupted
