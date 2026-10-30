## MODIFIED Requirements

### Requirement: applyChatFrame applies one frame to the messages of a live turn

The harness MUST export `applyChatFrame(messages, frame, assistantId)`. The function MUST give a new message list and the end signal of the turn. It MUST NOT change the list that it gets. It MUST obey these rules:

- A frame whose `source.callPath` has more than one entry comes from a sub-agent, and it changes nothing. The root agent of a chat turn has the call path `[agent.id]`.
- A `text-delta` adds its text to the last part if that part is text. If the last part is not text, the frame adds a text part.
- A `tool-started` adds a tool-call part with no outcome. The part holds the `input` when the frame has one.
- A `tool-finished` sets the outcome on the tool-call part with the same call id. It also sets the detail, `durationMs`, `input`, `result`, and `error` when the frame has them. If no part has that call id, the frame adds a tool-call part with the outcome and these fields.
- A `data-*` part goes at the end. A part of a type that the registry marks `reconciling` replaces the part with the same type and id, in the position of that part.
- The source of a `data-*` frame MUST NOT go into the part.
- An `iteration` changes nothing, and it does not end the turn.
- A `message-start` of the assistant changes nothing, and it does not end the turn. It does not make a part.
- A `message-start` of the user adds the user message `{ id: messageId, role: "user", parts: [{ type: "text", text }] }` at the end, when no message has that id. When a message has that id, the frame changes nothing. The frame does not end the turn.
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

#### Scenario: A finished call shows its input and its result

- **GIVEN** a `tool-started` frame with an `input`, and a `tool-finished` frame with the same `input` and a `result` for the same call
- **WHEN** `applyChatFrame` applies them
- **THEN** the message holds one tool-call part with the outcome, the `input`, and the `result`

#### Scenario: A finished call with no start stays

- **GIVEN** a `tool-finished` frame with the outcome `error`, and no `tool-started` frame for that call
- **WHEN** `applyChatFrame` applies it
- **THEN** the message holds a tool-call part with the outcome `error`

#### Scenario: An iteration frame makes no part

- **WHEN** `applyChatFrame` applies an `iteration` frame with the source of the root agent
- **THEN** the messages do not change, and the turn does not end

#### Scenario: A message-start frame makes no part

- **WHEN** `applyChatFrame` applies a `message-start` frame of the assistant with the source of the root agent
- **THEN** the messages do not change, and the turn does not end

#### Scenario: A user message-start frame adds the user message

- **GIVEN** an empty message list
- **WHEN** `applyChatFrame` applies a `message-start` frame of the user with the text `Compare the groups.`, and then a `text-delta` of the reply
- **THEN** the first message is the user message with the id of the frame and one text part `Compare the groups.`
- **AND** the reply comes after it, and the turn does not end

#### Scenario: A user message-start frame keeps a message with the same id

- **GIVEN** a message list that holds a user message with the id of the frame
- **WHEN** `applyChatFrame` applies the `message-start` frame of the user
- **THEN** the messages do not change

### Requirement: toChatFrame translates each emitted event

The harness MUST export `toChatFrame(event, fallbackSource)`. The function takes one event of the emit sink: a loop event, a provider event, or a `data-*` part. It MUST give one frame or `null`, as follows:

- A loop `iteration` of a sub-agent gives `{ type: "iteration", source }`, with a copy of the source and no other field. Its call path has more than one entry.
- A loop `iteration` of the root agent and the provider `done` give `null`.
- A `tool-started` gives the call id, the tool name, the detail and the `input` when the event has them, and a copy of the source.
- A `tool-finished` gives the same fields, the outcome, and `durationMs`, `result`, and `error` when the event has them.
- A `text-delta` gives the text and `fallbackSource`, because a provider event has no source.
- A `message-start` gives the message id, the role, the text of a user message, and a copy of the source.
- A `data-*` part gives a flat frame, `{ type, ...data }`, and a copy of the source when the emitter gave one.

A copy of a source MUST hold the `agentId`, the `callPath`, and the `invocationId` when the source has one. A source with no `invocationId` MUST give a copy with no `invocationId` key.

The function MUST keep each event and each part of a sub-agent, with its source. Thus each consumer can filter them. The root agent gives no `iteration` frame, thus a consumer of the root frames never reads the start of a model request as output.

`IterationEvent` MUST be a member of the `ChatEvent` union, and `IterationEventSchema` MUST be a member of `ChatEventSchema`. The package MUST export the two. A host reads the frame as "the sub-agent thinks".

`MessageStartEvent` MUST be a member of the `ChatEvent` union, and `MessageStartEventSchema` MUST be a member of `ChatEventSchema`. The package MUST export the two. `MessageStartEvent` is a union by `role`. Each variant has the fields `messageId`, `role`, and `source`. The `user` variant also has `text`, and the `assistant` variant has no text. Each field is necessary. The schema MUST accept only a UUID as `messageId`, and only `user` or `assistant` as `role`. The schema MUST refuse a `user` frame with no `text`.

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

#### Scenario: The frame of a finished call holds its values

- **GIVEN** a `tool-finished` event with an `input` and an `error`
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame holds the same `input` and `error`, and no `result`

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

#### Scenario: A user message-start keeps its text

- **GIVEN** a `message-start` event of the user with the text `Compare the groups.`
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame holds the message id, the role `user`, the text, and the source
- **AND** `ChatEventSchema` parses the frame to the same value

#### Scenario: The schema refuses a message-start with no UUID

- **WHEN** `ChatEventSchema` parses a `message-start` frame whose `messageId` is not a UUID, or a frame with no `role`
- **THEN** the parse fails

#### Scenario: The schema refuses a user message-start with no text

- **WHEN** `ChatEventSchema` parses a `message-start` frame of the user with no `text`
- **THEN** the parse fails

