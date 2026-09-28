## MODIFIED Requirements

### Requirement: applyChatFrame applies one frame to the messages of a live turn

The harness MUST export `applyChatFrame(messages, frame, assistantId)`. The function MUST give a new message list and the end signal of the turn. It MUST NOT change the list that it gets. It MUST obey these rules:

- A frame whose `source.callPath` has more than one entry comes from a sub-agent, and it changes nothing. The root agent of a chat turn has the call path `[agent.id]`.
- A `text-delta` adds its text to the last part if that part is text. If the last part is not text, the frame adds a text part.
- A `tool-started` adds a tool-call part with no outcome.
- A `tool-finished` sets the outcome on the tool-call part with the same call id. It also sets the detail and `durationMs` when the frame has them. If no part has that call id, the frame adds a tool-call part with the outcome.
- A `data-*` part goes at the end. A part of a type that the registry marks `reconciling` replaces the part with the same type and id, in the position of that part.
- The source of a `data-*` frame MUST NOT go into the part.
- A `finish` ends the turn. It puts `turnUsage` on the assistant message when the frame has one.
- An `error` ends the turn with the error.

#### Scenario: A frame of a sub-agent changes nothing

- **GIVEN** the frames of a sub-agent: a tool call, a `data-presentation` part, and a `finish`
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

## ADDED Requirements

### Requirement: The display recorder uses the translation path

The display recorder MUST build the messages of a round with `toChatFrame` and `applyChatFrame`. It MUST NOT hold its own rules for text, tool calls, or reconciling parts. It MUST record only a `data-*` part that the registry marks as a conversation part that is not transient. It MUST validate that part before it records it.

When a round closes, the recorder MUST store a call with no outcome as `incomplete`, and a `pending` ask as `aborted`.

#### Scenario: A pending ask closes as aborted

- **GIVEN** a round that emits a `data-ask` part with the status `pending`
- **WHEN** the recorder takes the round
- **THEN** the stored ask has the status `aborted`
