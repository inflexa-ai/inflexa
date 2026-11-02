## ADDED Requirements

### Requirement: The stored display keeps the pause of the turn

The live display recorder MUST keep each `data-pause` part that the workflow of the turn writes. It MUST fold the part latest-wins by its id. Thus the stored turn holds the pause part of the turn in the position of its first part, with the state of its last part. A reload MUST give the stored pause part field for field.

A stop that aborts the turn leaves its open round unstored, and the turn record shows the interruption. The stored display of an aborted turn MUST still hold the `data-pause` parts of that open round. It MUST hold no other part of that round.

The recorder MUST NOT keep a `data-pause` part of a sub-agent, because the recorder excludes the display parts of a sub-agent.

#### Scenario: A paused and resumed turn keeps its pause part

- **GIVEN** a turn that waits in `paused` with the cause `host`, and the user resumes it
- **WHEN** the turn ends and the transcript is loaded
- **THEN** the assistant message of the turn holds one `data-pause` part with the state `running`, the cause `host`, `pausedAt`, `endedAt`, and `end: "resume"`

#### Scenario: A stopped turn keeps its pause part

- **GIVEN** a turn that waits in `paused`, and the host stops it in the process that runs the turn
- **WHEN** the transcript is loaded
- **THEN** the assistant message of the turn holds one `data-pause` part with `end: "abort"`

#### Scenario: The pause of a sub-agent stays out of the stored display

- **GIVEN** a turn whose planner waits in `paused`, and the user resumes the turn
- **WHEN** the turn ends and the transcript is loaded
- **THEN** no stored part is a `data-pause` part of the planner
