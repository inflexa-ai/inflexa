# Spec Delta

## MODIFIED Requirements

### Requirement: Each activity emission carries its time and keeps its history

A workflow that reports the activity of a step SHALL set `at` on each `data-step-activity` part. The sandbox step and the data profile are such workflows. `at` is an ISO 8601 string from the checkpointed clock of the workflow. Thus a replay of the workflow gives the same value.

After each `data-step-activity` part, the workflow SHALL write one `data-activity-entry` part. The entry holds `id`, `runId`, `stepId`, `phase`, `activity`, and `at`, with the same values as the activity part. The entry `id` is the step part id of the kind `activity-entry`, then the sequence number of the emission in the workflow body. Thus each entry of a stream has its own id, and a replay gives the same id.

The registry SHALL mark `data-activity-entry` as a workflow part for the sidebar that is not transient and that does not reconcile. Thus the fold delivers each entry, in write order.

The two writes of one emission SHALL fail independently. A failed write SHALL be logged and SHALL NOT fail the workflow. The sequence number SHALL advance for each emission, also when a write fails.

The entries reach the handler in write order among themselves. A live reader that holds a reconciling part for a window can deliver an entry before the activity part of the same emission. A consumer SHALL read the held activity part as the current value, not as a line after the entries.

`at` is optional in the part contract, because a stream that an older harness wrote holds activity parts with no time.

The synthesis SHALL report its progress the same way. It SHALL set `at` on each `data-synthesis-progress` part, and after each such part it SHALL write one `data-activity-entry` part with the step id `synthesis`, the `SynthesisPhase` of the report as `phase`, and the same `activity` and `at`. Thus the `phase` of an entry is a `StepPhase` or a `SynthesisPhase`.

The synthesis runs in the body of the run workflow (`synthesizeFindings` in `harness/src/workflows/execute-analysis.ts`). Each read and each write of a file or a row is a step. Each model call and each tool call of the synthesizer loop is a step too. The progress writes are operations of the body. Thus the `at` of the synthesis comes from the checkpointed clock of the run workflow, and a replay of the body writes no entry again.

#### Scenario: A late subscriber gets each synthesis line with its time

- **GIVEN** a run whose synthesis reported some progress lines
- **WHEN** a caller subscribes after those lines and the history replays
- **THEN** the handler receives one `data-activity-entry` with the step id `synthesis` for each line, in write order, each with its `at`
- **AND** the handler receives the current `data-synthesis-progress`, with its `at`

#### Scenario: A late subscriber gets each activity line with its time

- **GIVEN** a step that reported some activity lines
- **WHEN** a caller subscribes after those lines and the history replays
- **THEN** the handler receives one `data-activity-entry` for each line, in write order, each with its `at`
- **AND** the handler receives the current `data-step-activity`, with its `at`

#### Scenario: A replay gives the same entries

- **GIVEN** a step workflow that wrote activity entries before a restart
- **WHEN** the workflow recovers and runs its body again
- **THEN** the stream holds each entry one time, with the same id and the same `at`

#### Scenario: A replay of the synthesis writes no entry again

- **GIVEN** a run workflow whose synthesis wrote progress entries before a restart
- **WHEN** the workflow recovers and runs its body again
- **THEN** the stream holds each synthesis entry one time, with the same id and the same `at`

#### Scenario: A failed entry write does not fail the step

- **WHEN** the write of a `data-activity-entry` part rejects
- **THEN** the failure is logged, the step continues, and the next entry gets the next sequence number
