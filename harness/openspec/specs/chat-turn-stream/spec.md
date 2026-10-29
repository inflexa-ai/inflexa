# chat-turn-stream Specification

## Purpose
The durable stream of a chat turn. The turn writes its frames to the stream of its workflow, and a host reads them, live or again after a lost connection.

## Requirements

### Requirement: A turn writes each frame to its durable stream

A chat turn MUST write each fact that a host shows to the durable stream of its workflow. The reader of the harness MUST give the host frames with the shape of `toChatFrame`. A frame carries the source of its event: the agent, the call path, and the id of the tool call that runs a sub-agent. The turn MUST write its own end, thus the reader gives `finish` or `error`. A host MUST NOT write to the stream of a turn.

#### Scenario: A client gets no tool payload

- **WHEN** a tool call of a turn returns its output
- **THEN** the frames that the reader gives hold the name, the detail, the outcome, and the duration of the call, and not its input or its output

#### Scenario: A host reads the whole turn

- **WHEN** a turn ends with a reply
- **THEN** its stream holds the text of the reply, the start and the end of each tool call, and one `finish` frame at the end

#### Scenario: A failed turn ends with an error frame

- **WHEN** a model call of the turn fails after its retries
- **THEN** the last frame of the stream is `error` with the reason of the failure

### Requirement: The text of a rerun model call shows one time

The text frames of a model call MUST carry the attempt of the call. When a recovery runs a model call again, a read that starts after the recovery MUST show only the text of the last attempt for that message.

#### Scenario: A crash during a reply

- **GIVEN** a model call that streamed half of its text, and then the host stopped
- **WHEN** the turn recovers and the call runs again
- **THEN** a read after the recovery shows the text of the second attempt one time, and not the half text of the first

### Requirement: A reader reads a turn again from its start

A host MUST be able to read the frames of a turn by the turn id, live, until the terminal frame or the end of the workflow. A second read of the same turn MUST give the same frames from the start. The fold of the frames of a second read MUST give the same messages as the fold of a first read.

#### Scenario: A client connects again

- **GIVEN** a client that lost its connection during a turn
- **WHEN** the client reads the turn again by its id
- **THEN** it gets each frame from the start, then the frames that come after, and its fold gives the same messages as a client that never lost its connection

### Requirement: The stream of a turn includes the frames of its sub-agents

A sub-agent of a turn writes to the stream of its own workflow. The stream of the caller MUST name the child workflow when the child starts. The reader of a turn MUST merge the frames of each child that the turn names, and each frame keeps its source.

#### Scenario: The planner streams under the conversation agent

- **WHEN** the conversation agent calls `generate_plan`, and the planner calls tools
- **THEN** the reader of the turn gives the tool frames of the planner, with the call path of the conversation agent and then the planner

### Requirement: The stream of a turn carries the user message

The turn MUST write the `message-start` of the user message before the first frame of the reply. The frame MUST carry the sanitized user text, which is the text that the model gets. The turn stores the user message only with its first round, thus the stream is the only source of it before that round. The fold of the frames MUST give the user message with the id of the stream and its text.

#### Scenario: A client attaches to a turn that paused on its first request

- **GIVEN** a turn whose first model request waits in a pause, and a client that has no message of the turn
- **WHEN** the client reads the turn by its id, and folds the frames with `applyChatFrame`
- **THEN** the fold holds the user message with the id of the stream and the sanitized user text

#### Scenario: A second read gives the same user message

- **GIVEN** a turn that ended with a reply
- **WHEN** a client reads the turn again from its start
- **THEN** the fold holds one user message, with the same id and text as the fold of the first read
