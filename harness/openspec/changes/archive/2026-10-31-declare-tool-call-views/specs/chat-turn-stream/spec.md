## MODIFIED Requirements

### Requirement: A turn writes each frame to its durable stream

A chat turn MUST write each fact that a host shows to the durable stream of its workflow. The reader of the harness MUST give the host frames with the shape of `toChatFrame`. A frame carries the source of its event: the agent, the call path, and the id of the tool call that runs a sub-agent. The turn MUST write its own end, thus the reader gives `finish` or `error`. A host MUST NOT write to the stream of a turn.

#### Scenario: A client gets no tool payload

- **WHEN** a tool call of a turn returns its output
- **THEN** the frames that the reader gives hold the name, the detail, the outcome, and the duration of the call
- **AND** they hold no raw input and no raw output of the call
- **AND** they hold a shown value of the call only when the view of the tool declares it

#### Scenario: A host reads the whole turn

- **WHEN** a turn ends with a reply
- **THEN** its stream holds the text of the reply, the start and the end of each tool call, and one `finish` frame at the end

#### Scenario: A failed turn ends with an error frame

- **WHEN** a model call of the turn fails after its retries
- **THEN** the last frame of the stream is `error` with the reason of the failure
