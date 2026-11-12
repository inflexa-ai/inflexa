# chat-turn-stream Specification

## Purpose
The durable stream of a chat turn. The turn writes its frames to the stream of its workflow, and a host reads them, live or again after a lost connection.

## Requirements

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

### Requirement: The model calls of a turn stream their text live

The turn workflow MUST write the text of each model call of its root loop to the durable stream while the call runs. A reader of the turn MUST get the text of a call while the call runs, and not only after it ends. A loop has a live reader of its text when it gives `onText` or a durable text stream. Only such a loop binds its model calls as live.

A live call retries a failed attempt only before its first output part, because a reader saw each part after it. A failure after that part ends the request, and the turn pauses or fails as the work-pause spec says. A loop with no live reader, for example a sub-agent or a sandbox step, keeps the retry of a whole attempt.

#### Scenario: A reader gets the text before the call ends

- **GIVEN** a turn workflow whose model call streams a first text and then waits before the rest of its reply
- **WHEN** a host reads the turn during the wait
- **THEN** the read gives the first text before the model call ends

#### Scenario: A failure after a text pauses the turn

- **GIVEN** a turn workflow whose model call fails with a retryable error after a text
- **WHEN** the turn gets the failure
- **THEN** the turn pauses with the cause `outage`, and the stream of the turn keeps the text

### Requirement: The text of a rerun model call shows one time

The text frames of a model call MUST carry the attempt of the call. When a recovery runs a model call again, a read that starts after the recovery MUST show only the text of the last attempt. This applies to each message.

Each execution of a model step of a turn MUST write a marker to the durable stream before its model request. The marker names the step and the execution. A read MUST NOT give a marker as a frame. A read that gets the marker of a new execution of a step MUST then give a `text-superseded` frame. The frame covers the text that the read gave after the earlier marker of that step. This also applies when the new execution fails before its first output part.

The frame carries the source of the root agent and `length`. The value of `length` is the length of the text that the read gave after the earlier marker, in UTF-16 code units. A read that gave no such text MUST NOT give the frame. The read MUST NOT give more text of an earlier execution whose text it gave before the marker of a new execution. The fold of the frames MUST then hold the text of the last execution one time.

This guarantee has one exception. In a cancel and a resume across two processes at the same time, an earlier execution can write text after the new marker. When the read gave no text of that execution before the marker, it cannot tell that text from the text of the new execution. Thus the read gives each such text until the next marker of that step, and the fold keeps it.

A stream that holds no marker, for example the stream of a turn from before the upgrade, MUST give its text as before.

#### Scenario: A crash during a reply

- **GIVEN** a model call that streamed half of its text, and then the host stopped
- **WHEN** the turn recovers and the call runs again
- **THEN** a read after the recovery shows the text of the second attempt one time, and not the half text of the first

#### Scenario: A read during a recovery drops the half text

- **GIVEN** a model call that streamed half of its text, and then the host of the turn stopped before the call ended
- **AND** a read that gave the half text and the marker of the second execution, before the second execution wrote its text
- **WHEN** the second execution streams its reply
- **THEN** the read gives a `text-superseded` frame whose `length` is the length of the half text, and then the text of the second execution
- **AND** the fold of the read with `applyChatFrame` holds the text of the second execution one time, and not the half text

#### Scenario: A rerun that fails before its output drops the half text

- **GIVEN** a model call that streamed half of its text, and then the host of the turn stopped before the call ended
- **AND** the call runs again on recovery and fails before its first output part
- **WHEN** a host reads the turn
- **THEN** the read gives the half text, and then a `text-superseded` frame whose `length` is the length of the half text
- **AND** the fold of the read with `applyChatFrame` holds no half text

#### Scenario: A late write of an earlier execution does not show

- **GIVEN** a read that gave text of an earlier execution of a model step
- **AND** the earlier execution writes more text after the marker of a new execution of that step
- **WHEN** a host reads the turn
- **THEN** the read does not give that text

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

### Requirement: The stream of a turn carries each retry of a model request

The turn MUST write each `data-model-retry` part of a model request to the durable stream of the workflow that runs the request. Each reader of the turn MUST get each retry part that the stream holds. A reader that opens during the retries of a request MUST get the earlier parts in order, and then each later part. The fold of the frames of a reader thus shows the newest retry of the request. The stored transcript of the turn MUST NOT hold a `data-model-retry` part.

#### Scenario: A reader that opens before the retries

- **GIVEN** a turn whose model request fails with `503` two times, and then gives a reply
- **WHEN** a client reads the turn by its id before the first retry
- **THEN** the client gets two `data-model-retry` parts with the same request id and the retries 1 and 2
- **AND** the client gets each part when the turn writes it

#### Scenario: A reader that opens during the retries

- **GIVEN** a turn whose model request waits for its second retry
- **WHEN** a client reads the turn by its id
- **THEN** the client gets the `data-model-retry` part of the first retry from the start of the stream
- **AND** the client gets the part of the second retry when the turn writes it

#### Scenario: The transcript holds no retry

- **GIVEN** a turn whose model request needed a retry, and then gave a reply
- **WHEN** the turn ends
- **THEN** the stored messages of the turn hold no `data-model-retry` part
