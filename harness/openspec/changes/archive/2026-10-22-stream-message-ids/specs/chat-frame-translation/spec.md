## MODIFIED Requirements

### Requirement: applyChatFrame applies one frame to the messages of a live turn

The harness MUST export `applyChatFrame(messages, frame, assistantId)`. The function MUST give a new message list and the end signal of the turn. It MUST NOT change the list that it gets. It MUST obey these rules:

- A frame whose `source.callPath` has more than one entry comes from a sub-agent, and it changes nothing. The root agent of a chat turn has the call path `[agent.id]`.
- A `text-delta` adds its text to the last part if that part is text. If the last part is not text, the frame adds a text part.
- A `tool-started` adds a tool-call part with no outcome.
- A `tool-finished` sets the outcome on the tool-call part with the same call id. It also sets the detail and `durationMs` when the frame has them. If no part has that call id, the frame adds a tool-call part with the outcome.
- A `data-*` part goes at the end. A part of a type that the registry marks `reconciling` replaces the part with the same type and id, in the position of that part.
- The source of a `data-*` frame MUST NOT go into the part.
- An `iteration` changes nothing, and it does not end the turn.
- A `message-start` changes nothing, and it does not end the turn. It does not make a part.
- A `finish` ends the turn. It puts `turnUsage` on the assistant message when the frame has one.
- An `error` ends the turn with the error.

#### Scenario: A frame of a sub-agent changes nothing

- **GIVEN** the frames of a sub-agent: an iteration, a tool call, a `data-presentation` part, and a `finish`
- **WHEN** `applyChatFrame` applies them
- **THEN** the messages do not change, and the turn does not end

#### Scenario: A finished call shows its duration

- **GIVEN** a `tool-started` frame and a `tool-finished` frame with `durationMs` 420 for the same call
- **WHEN** `applyChatFrame` applies them
- **THEN** the message holds one tool-call part with the outcome and `durationMs` 420

#### Scenario: A finished call with no start stays

- **GIVEN** a `tool-finished` frame with the outcome `error`, and no `tool-started` frame for that call
- **WHEN** `applyChatFrame` applies it
- **THEN** the message holds a tool-call part with the outcome `error`

#### Scenario: An iteration frame makes no part

- **WHEN** `applyChatFrame` applies an `iteration` frame with the source of the root agent
- **THEN** the messages do not change, and the turn does not end

#### Scenario: A message-start frame makes no part

- **WHEN** `applyChatFrame` applies a `message-start` frame with the source of the root agent
- **THEN** the messages do not change, and the turn does not end

### Requirement: The live path and the reload path give the same messages

A test MUST give one sequence of loop events to one display recorder. The reload path is the display recorder, the stored shape, and the replay. The live path reads the events that the same recorder forwards: `toChatFrame`, then the sub-agent activity tracker, and then `applyChatFrame` for the frame and for each part that the tracker gives. A `message-start` gives the live path the id of the next message. The two paths MUST get the same clock. The two message lists MUST be equal, and the ids of the messages MUST be equal.

Each known difference MUST have its own test. The tests MUST NOT hide a difference. These are the known differences:

- A call that did not finish: the replay gives `incomplete`, and the live message gives no outcome.
- A call of a sub-agent that did not finish: the replay gives `incomplete` on its entry, and the live entry gives no outcome.
- An ask with the status `pending` at the end of the turn: the replay gives `aborted`, and the live message keeps `pending`.
- A compaction: the replay gives a divider message between two assistant messages. The live path gives the same two assistant messages, and the first live message holds the compaction part.
- A turn that forwards no event: the live user message keeps the id that the client gave it.
- A round with no streamed text: the replay takes the text of the model reply, and the live path shows no text.
- The text of two rounds with no part between them: the replay keeps two text parts, and the live message joins them.
- The facts of the stored rows: the replay adds the turn duration, the interruption, the author, and the creation time.

#### Scenario: One turn gives the same messages on the two paths

- **GIVEN** a turn with text, tool calls, a sub-agent with tool calls, a plan card, an ask, and a run card
- **WHEN** the test gives its events to the two paths
- **THEN** the two message lists are equal, and each list holds the `data-subagent-activity` part of the root call of the sub-agent

#### Scenario: A known difference stays visible

- **GIVEN** a turn that ends with an ask in the status `pending`
- **WHEN** the test gives its events to the two paths
- **THEN** the test shows `aborted` in the replay and `pending` in the live message

#### Scenario: An unfinished sub-agent call stays visible

- **GIVEN** a turn that ends while a call of a sub-agent has no `tool-finished`
- **WHEN** the test gives its events to the two paths
- **THEN** the test shows the entry `incomplete` in the replay and with no outcome in the live message

### Requirement: toChatFrame translates each emitted event

The harness MUST export `toChatFrame(event, fallbackSource)`. The function takes one event of the emit sink: a loop event, a provider event, or a `data-*` part. It MUST give one frame or `null`, as follows:

- A loop `iteration` of a sub-agent gives `{ type: "iteration", source }`, with a copy of the source and no other field. Its call path has more than one entry.
- A loop `iteration` of the root agent and the provider `done` give `null`.
- A `tool-started` gives the call id, the tool name, the detail when there is one, and a copy of the source.
- A `tool-finished` gives the same fields, the outcome, and `durationMs` when the event has one.
- A `text-delta` gives the text and `fallbackSource`, because a provider event has no source.
- A `message-start` gives the message id, the role, and a copy of the source.
- A `data-*` part gives a flat frame, `{ type, ...data }`, and a copy of the source when the emitter gave one.

A copy of a source MUST hold the `agentId`, the `callPath`, and the `invocationId` when the source has one. A source with no `invocationId` MUST give a copy with no `invocationId` key.

The function MUST keep each event and each part of a sub-agent, with its source. Thus each consumer can filter them. The root agent gives no `iteration` frame, thus a consumer of the root frames never reads the start of a model request as output.

`IterationEvent` MUST be a member of the `ChatEvent` union, and `IterationEventSchema` MUST be a member of `ChatEventSchema`. The package MUST export the two. A host reads the frame as "the sub-agent thinks".

`MessageStartEvent` MUST be a member of the `ChatEvent` union, and `MessageStartEventSchema` MUST be a member of `ChatEventSchema`. The package MUST export the two. The frame has the fields `messageId`, `role`, and `source`, and each field is necessary. The schema MUST accept only a UUID as `messageId`, and only `user` or `assistant` as `role`.

The module of the function MUST import only types from outside `src/contracts/`. Thus a browser can load it.

#### Scenario: An event of a sub-agent keeps its source

- **GIVEN** a `tool-started` event with the call path `["conversation-agent", "literature-reviewer"]`
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame holds the event and that call path

#### Scenario: The source of a frame keeps its invocation id

- **GIVEN** a `tool-started` event whose source has the `invocationId` `t1`
- **WHEN** `toChatFrame` translates the event
- **THEN** the source of the frame has the `invocationId` `t1`

#### Scenario: The frame of a finished call holds its duration

- **GIVEN** a `tool-finished` event with `durationMs` 420
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame holds `durationMs` 420

#### Scenario: An iteration of a sub-agent gives a frame

- **GIVEN** an `iteration` event with the call path `["conversation-agent", "literature-reviewer"]`, the index 2, and `final: false`
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame is `{ type: "iteration", source }`, with that source and no index

#### Scenario: A root iteration gives no frame

- **WHEN** `toChatFrame` translates an `iteration` of the root agent, or the provider `done`
- **THEN** it gives `null`

#### Scenario: The schema accepts the iteration frame

- **WHEN** `ChatEventSchema` parses `{ type: "iteration", source }` with a valid source of a sub-agent
- **THEN** the parse gives the same frame

#### Scenario: The schema refuses a message-start with no UUID

- **WHEN** `ChatEventSchema` parses a `message-start` frame whose `messageId` is not a UUID, or a frame with no `role`
- **THEN** the parse fails

## ADDED Requirements

### Requirement: The display recorder makes the id of each message

The display recorder MUST make the id of the user message and the id of each assistant message of the turn. A caller cannot give an id. The stream MUST be the only source of the ids that a live surface shows. Each user id and each assistant id of the stored display MUST be an id that the stream announced. An assistant id can have no stored message when its rounds kept no part.

#### Scenario: A turn announces the ids that it stores

- **GIVEN** a turn with text and a tool call in two rounds
- **WHEN** the recorder forwards its events and takes its rounds
- **THEN** the sink gets the `message-start` of the user id and of the assistant id before the first event
- **AND** the stored user message and the stored assistant message carry those two ids

#### Scenario: A turn-start compaction announces an id that it does not store

- **GIVEN** a turn that starts with a turn-start compaction
- **WHEN** the turn stores its rows
- **THEN** the stored user message and the stored assistant message carry announced ids
- **AND** the assistant id that the stream announced before the compaction has no stored message

### Requirement: The display recorder announces an id immediately before an event

The recorder MUST give its sink a `message-start` event for each id, with the source of the root agent. Immediately before the first event that it forwards, it forwards the `message-start` of the user id, and then of the current assistant id. After a marker round gives a new assistant id, it forwards the `message-start` of that id immediately before the next event that it forwards. It forwards one `message-start` for each id, and no more.

#### Scenario: A compaction announces the second assistant id

- **GIVEN** a turn that compacts between two rounds
- **WHEN** the marker round gives a new assistant id
- **THEN** the sink gets the `message-start` of the new id immediately before the next event
- **AND** the stored assistant messages carry the two announced ids

### Requirement: The display recorder announces nothing before the first event

The recorder MUST forward no `message-start` before the first event. A host reads the first call of its sink as the start of the turn. Thus a turn that ends before any event can still get a refusal with no stream.

#### Scenario: A turn with no event announces nothing

- **GIVEN** a turn that ends before its first event
- **WHEN** the recorder takes its opening and its rounds
- **THEN** the sink gets no call

### Requirement: The display recorder forwards each event with no change

The recorder MUST forward each event that it gets, of the root agent and of a sub-agent, with no change. A `message-start` that it adds MUST NOT replace an event.

#### Scenario: An event of a sub-agent passes unchanged

- **GIVEN** a turn whose first event is a tool call of a sub-agent
- **WHEN** the recorder forwards it
- **THEN** the sink gets the two `message-start` events with the source of the root agent, and then the same event
