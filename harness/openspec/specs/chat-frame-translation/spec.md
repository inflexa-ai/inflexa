# chat-frame-translation Specification

## Purpose
Give one translation path for the chat stream in the harness. Thus each consumer applies the same rules, and a live turn and its reload show the same messages.

## Requirements

### Requirement: applyChatFrame applies one frame to the messages of a live turn

The harness MUST export `applyChatFrame(messages, frame, assistantId)`. The function MUST give a new message list and the end signal of the turn. It MUST NOT change the list that it gets. It MUST obey these rules:

- A frame whose `source.callPath` has more than one entry comes from a sub-agent, and it changes nothing. The root agent of a chat turn has the call path `[agent.id]`.
- A `text-delta` adds its text to the last part if that part is text. If the last part is not text, the frame adds a text part.
- A `tool-started` adds a tool-call part with no outcome.
- A `tool-finished` sets the outcome on the tool-call part with the same call id. It also sets the detail and `durationMs` when the frame has them. If no part has that call id, the frame adds a tool-call part with the outcome.
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

### Requirement: The display of a tool call holds its duration

`ToolCallPart` MUST have the optional field `durationMs`. The display recorder MUST record `durationMs` of `tool-finished` on the part of the call. The stored display MUST keep the field, and the replay MUST give it. A call with no measurement MUST have no `durationMs` key.

A stored row that holds no `durationMs` MUST still read. Its tool-call part MUST have no `durationMs` key.

#### Scenario: A reload shows the duration of a call

- **GIVEN** a turn whose `tool-finished` event has `durationMs` 12
- **WHEN** the harness stores the turn and the replay reads it
- **THEN** the tool-call part of the replay holds `durationMs` 12

#### Scenario: An old row reads

- **GIVEN** a stored tool call with no `durationMs`
- **WHEN** the replay reads it
- **THEN** the tool-call part has no `durationMs` key

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

### Requirement: The display recorder uses the translation path

The display recorder MUST build the messages of a round with `toChatFrame` and `applyChatFrame`. It MUST give each frame to one sub-agent activity tracker for the turn, and it MUST apply each part that the tracker gives. It MUST NOT hold its own rules for text, tool calls, sub-agent activity, or reconciling parts. It MUST record only a `data-*` part that the registry marks as a conversation part that is not transient. It MUST validate that part before it records it. The recorder takes the time of receipt from an injected clock, and the default is the wall clock.

When a round closes, the recorder MUST store a call with no outcome as `incomplete`, and a `pending` ask as `aborted`. It MUST store each entry of a `data-subagent-activity` part that has no outcome as `incomplete`, with no `endedAt`.

#### Scenario: A pending ask closes as aborted

- **GIVEN** a round that emits a `data-ask` part with the status `pending`
- **WHEN** the recorder takes the round
- **THEN** the stored ask has the status `aborted`

#### Scenario: A sub-agent call closes as incomplete

- **GIVEN** a round in which a sub-agent starts a tool call and the round closes before its `tool-finished`
- **WHEN** the recorder takes the round
- **THEN** the stored entry of that call has the outcome `incomplete` and no `endedAt`

### Requirement: A part frame is checked where it arrives

The harness MUST export `checkChatPart(frame)`. For a type that the registry knows, it MUST check the frame against the schema of that type. It MUST give the parsed part and keep the source, or give the error. A field that the schema does not know MUST NOT stay in the part. A type that the registry does not know MUST pass unchanged, because a newer emitter can send it. For each type, it MUST refuse a frame whose source is not a valid event source, because `isRootFrame` reads the call path of the source.

A consumer MUST check each live part frame one time, where it arrives. After the check, the consumer MUST read the part through its harness type, and not as `unknown`.

#### Scenario: A known part that its schema rejects

- **GIVEN** a `data-ask` frame with the status `maybe`
- **WHEN** `checkChatPart` checks it
- **THEN** the result is an error

#### Scenario: A part of an unknown type

- **GIVEN** a frame of a type that the registry does not know
- **WHEN** `checkChatPart` checks it
- **THEN** the frame passes unchanged

#### Scenario: A part with a malformed source

- **GIVEN** a part frame, of a known or an unknown type, whose source has no call path
- **WHEN** `checkChatPart` checks it
- **THEN** the result is an error

### Requirement: The stored plan card keeps each step field that the card shows

A plan step of a `data-plan` part MUST accept the optional fields `track`, `step_type`, `acceptance_criteria`, `constraints`, `caveats`, and `resources.gpu`. The display recorder MUST keep them, thus a reloaded plan card shows the same steps as the live card.

#### Scenario: A reloaded plan keeps its acceptance criteria

- **GIVEN** a `data-plan` part whose step has acceptance criteria, constraints, caveats, a track, a step type, and a GPU count
- **WHEN** the recorder stores the turn
- **THEN** the stored step holds each of those fields

### Requirement: toChatFrame translates each emitted event

The harness MUST export `toChatFrame(event, fallbackSource)`. The function takes one event of the emit sink: a loop event, a provider event, or a `data-*` part. It MUST give one frame or `null`, as follows:

- A loop `iteration` of a sub-agent gives `{ type: "iteration", source }`, with a copy of the source and no other field. Its call path has more than one entry.
- A loop `iteration` of the root agent and the provider `done` give `null`.
- A `tool-started` gives the call id, the tool name, the detail when there is one, and a copy of the source.
- A `tool-finished` gives the same fields, the outcome, and `durationMs` when the event has one.
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

### Requirement: A tracker gives the sub-agent activity of each root tool call

The harness MUST export `createSubAgentActivityTracker()`. The tracker reads the frames of one turn, of the root agent and of each sub-agent. The caller gives the time of receipt of each frame. The tracker MUST obey these rules:

- A `tool-started` frame of the root agent opens a root tool call. The root agent has the call path `[agent.id]`.
- The tracker identifies a tool call by its call id and by the call path of the loop that made the call.
- A frame of a sub-agent belongs to the call that the `invocationId` of its source names. That call was made by the loop whose call path is the call path of the frame without its last entry.
- If that call is a root tool call, the frame belongs to it. If that call is a sub-agent call that belongs to a root tool call, the frame belongs to the same root tool call.
- A frame of a sub-agent with no `invocationId`, or with an `invocationId` that names no call that the tracker knows, changes nothing.
- A `tool-started` frame of a sub-agent adds one entry to its root tool call. The entry holds the `agentId` and the `callPath` of the source, and the tool name as `tool`. It holds the detail of the frame as `label` when the frame has one, and the receipt time as `startedAt`.
- A `tool-finished` frame of a sub-agent sets the `outcome` of its entry. Its detail replaces the `label` when the frame has one. `endedAt` is `startedAt` plus `durationMs` when the frame has `durationMs`, and the receipt time when it does not.
- A `tool-finished` frame whose entry the tracker did not add changes nothing.
- Each other frame of a sub-agent changes nothing: text, iteration, finish, error, and each `data-*` part.
- One root tool call holds at most 200 entries, the first ones in start order. Each later `tool-started` of a sub-agent of that call adds 1 to `dropped` and adds no entry.
- The tracker still records a dropped call in its call map. Thus each call of a deeper sub-agent below a dropped call also adds 1 to `dropped`.
- `startedAt` and `endedAt` are ISO 8601 strings.

After each frame that changes the activity of a root tool call, the tracker MUST give a `data-subagent-activity` part frame with no source. The part holds `id`, `toolCallId` (the id of the root tool call), `entries`, and `dropped`. The `id` is the same for each part of one root tool call. Each other frame gives `null`.

The registry MUST mark `data-subagent-activity` as a conversation part that is not transient and that reconciles. Thus `applyChatFrame` puts the first part of a root tool call at the end of the message. Each later part replaces it in that position.

The tracker MUST NOT read a tool input, a tool output, or a text of a sub-agent. The `label` is the one-line detail that the loop normalized, redacted, and capped.

The module of the tracker MUST import only types from outside `src/contracts/`. Thus a browser can load it.

#### Scenario: A planner call shows its tool calls

- **GIVEN** a root `tool-started` with the call id `t1`, and a sub-agent source `{ agentId: "planner", callPath: ["conversation-agent", "planner"], invocationId: "t1" }`
- **WHEN** the tracker reads a `tool-started` and a `tool-finished` of the sub-agent for the call `s1`, and `applyChatFrame` applies each part that it gives
- **THEN** the message holds one `data-subagent-activity` part with `toolCallId` `t1`, one entry for `s1` with its outcome, and `dropped` 0

#### Scenario: A nested sub-agent belongs to the root tool call

- **GIVEN** a sub-agent of the root call `t1` that starts the call `s1`, and a deeper sub-agent whose source has the `invocationId` `s1`
- **WHEN** the deeper sub-agent starts a tool call
- **THEN** the tracker adds the entry to the part of `t1`

#### Scenario: Concurrent root calls keep separate lists

- **GIVEN** two root calls `t1` and `t2` that are open at the same time, each with its own sub-agent
- **WHEN** the two sub-agents start tool calls in an interleaved order
- **THEN** each part holds only the calls of the sub-agent of its own root call

#### Scenario: A frame with no invocation id changes nothing

- **GIVEN** a frame of a sub-agent whose source has no `invocationId`, for example a frame of the compaction exchange
- **WHEN** the tracker reads it
- **THEN** the tracker gives `null`, and no part holds an entry for it

#### Scenario: The cap counts the calls that it drops

- **GIVEN** a sub-agent of one root call that starts 201 tool calls
- **WHEN** the tracker reads them
- **THEN** the part holds the first 200 entries, and `dropped` is 1

#### Scenario: A deeper call below a dropped call is counted

- **GIVEN** a root call whose part holds 200 entries, and a dropped sub-agent call `s201` that runs a deeper sub-agent
- **WHEN** the deeper sub-agent starts a tool call
- **THEN** the part holds the same 200 entries, and `dropped` grows by 1

#### Scenario: The end time uses the measured duration

- **GIVEN** a sub-agent `tool-started` received at `2026-10-12T10:00:00.000Z`, and its `tool-finished` with `durationMs` 800 received later
- **WHEN** the tracker reads the two frames
- **THEN** the entry has `endedAt` `2026-10-12T10:00:00.800Z`

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

The recorder MUST give its sink a `message-start` event for each id, with the source of the root agent. Immediately before the first event that it forwards, it forwards the `message-start` of the user id, and then of the current assistant id. The `message-start` of the user id MUST carry the user text of the recorder. After a marker round gives a new assistant id, it forwards the `message-start` of that id immediately before the next event that it forwards. It forwards one `message-start` for each id, and no more.

#### Scenario: A compaction announces the second assistant id

- **GIVEN** a turn that compacts between two rounds
- **WHEN** the marker round gives a new assistant id
- **THEN** the sink gets the `message-start` of the new id immediately before the next event
- **AND** the stored assistant messages carry the two announced ids

#### Scenario: The user message-start carries the user text

- **GIVEN** a recorder with the user text `question`
- **WHEN** the recorder forwards its first event
- **THEN** the `message-start` of the user id holds the text `question`

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

### Requirement: The display of a round comes from the stream of its turn

The display recorder of a turn workflow MUST build the display projection of a round from the frames of that round in the stream of the turn. A step that a recovery replays emits no event, but its frames from the first attempt are in the stream. Thus the stored display of a replayed round MUST be the same as the display of a round with no crash.

#### Scenario: A replayed tool call keeps its card

- **GIVEN** a round whose `show_plan` call completed, and then the host stopped before the round write
- **WHEN** the turn recovers and stores the round
- **THEN** the stored display of the round holds the plan card and the tool part of the call, one time each
