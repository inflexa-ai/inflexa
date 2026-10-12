## MODIFIED Requirements

### Requirement: The data-profile workflow emits its activity to a durable event stream

The data-profile workflow body SHALL write typed run-event parts to its own durable
`"events"` stream, so a consumer can observe what a live profile is doing. The body
SHALL NOT discard its agent loop's event sink.

The body SHALL emit `data-step-activity` parts carrying its synthetic frame
(`runId` `"data-profile"`, `stepId` `"profile"`) and a stable reconciling id, so
that a subscriber attaching part-way through a profile folds to the profile's
current activity rather than replaying every superseded intermediate.

Each `data-step-activity` part SHALL carry `at`, the time of the emission from the
checkpointed clock of the workflow. After each `data-step-activity` part, the body
SHALL write one `data-activity-entry` part with the same phase, activity, and time
(see the run-event-stream capability). The entries do not reconcile. Thus a
subscriber that attaches part-way through a profile gets each earlier activity
line with its time, beside the current activity.

A stream write that fails SHALL be swallowed and logged, never propagated. A
dropped observation frame is cosmetic and MUST NOT fail the profile — the same
stance the sandbox-step producer takes. The activity write and the entry write of
one emission SHALL fail independently.

Every emission SHALL be awaited in body order. `DBOS.writeStream` allocates a
function id, so a fire-and-forget write would race the next operation for the
counter and desynchronise the recorded sequence on replay. The clock read of an
emission SHALL also be awaited in body order, for the same reason.

#### Scenario: A tool call the profiler makes becomes an activity part

- **WHEN** the profiler agent starts a tool call during a profile
- **THEN** the body emits a `data-step-activity` part whose `phase` is `executing`
  and whose `activity` is the human phrase derived from that tool's name and input
  (e.g. `Running script profile.py` for an `execute_command` invoking a script)
- **AND** the body then emits a `data-activity-entry` part with the same `phase`,
  `activity`, and `at`

#### Scenario: A subscriber attaching mid-profile sees current activity, not history

- **WHEN** a consumer subscribes to a profile's stream after several tool calls have
  already been reported
- **THEN** the reconciling fold collapses those reports latest-wins onto the single
  activity id
- **AND** the consumer's first delivery describes what the profile is doing now

#### Scenario: A subscriber attaching mid-profile also gets the earlier lines

- **WHEN** a consumer subscribes to a profile's stream after some tool calls were
  reported
- **THEN** the consumer receives one `data-activity-entry` for each earlier report,
  in write order, each with its time

#### Scenario: A failed stream write does not fail the profile

- **WHEN** a `DBOS.writeStream` call rejects during a profile
- **THEN** the failure is logged and the profile continues to completion unaffected
