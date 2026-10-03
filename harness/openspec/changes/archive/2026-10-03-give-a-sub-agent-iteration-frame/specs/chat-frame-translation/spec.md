## REMOVED Requirements

### Requirement: toChatFrame gives the frame of one emitted event

**Reason**: A loop `iteration` of a sub-agent now gives a frame, thus the rule that each `iteration` gives `null` is false.
**Migration**: The requirement "toChatFrame translates each emitted event" gives the rules, with the `iteration` frame of a sub-agent.

## ADDED Requirements

### Requirement: toChatFrame translates each emitted event

The harness MUST export `toChatFrame(event, fallbackSource)`. The function takes one event of the emit sink: a loop event, a provider event, or a `data-*` part. It MUST give one frame or `null`, as follows:

- A loop `iteration` of a sub-agent gives `{ type: "iteration", source }`, with a copy of the source and no other field. Its call path has more than one entry.
- A loop `iteration` of the root agent and the provider `done` give `null`.
- A `tool-started` gives the call id, the tool name, the detail when there is one, and a copy of the source.
- A `tool-finished` gives the same fields, the outcome, and `durationMs` when the event has one.
- A `text-delta` gives the text and `fallbackSource`, because a provider event has no source.
- A `data-*` part gives a flat frame, `{ type, ...data }`, and a copy of the source when the emitter gave one.

The function MUST keep each event and each part of a sub-agent, with its source. Thus each consumer can filter them. The root agent gives no `iteration` frame, thus a consumer of the root frames never reads the start of a model request as output.

`IterationEvent` MUST be a member of the `ChatEvent` union, and `IterationEventSchema` MUST be a member of `ChatEventSchema`. The package MUST export the two. A host reads the frame as "the sub-agent thinks".

The module of the function MUST import only types from outside `src/contracts/`. Thus a browser can load it.

#### Scenario: An event of a sub-agent keeps its source

- **GIVEN** a `tool-started` event with the call path `["conversation-agent", "literature-reviewer"]`
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame holds the event and that call path

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
