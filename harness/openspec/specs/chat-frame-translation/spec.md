# chat-frame-translation Specification

## Purpose
Give one translation path for the chat stream in the harness. Thus each consumer applies the same rules, and a live turn and its reload show the same messages.

## Requirements

### Requirement: toChatFrame gives the frame of one emitted event

The harness MUST export `toChatFrame(event, fallbackSource)`. The function takes one event of the emit sink: a loop event, a provider event, or a `data-*` part. It MUST give one frame or `null`, as follows:

- A loop `iteration` and the provider `done` give `null`.
- A `tool-started` gives the call id, the tool name, the detail when there is one, and a copy of the source.
- A `tool-finished` gives the same fields, the outcome, and `durationMs` when the event has one.
- A `text-delta` gives the text and `fallbackSource`, because a provider event has no source.
- A `data-*` part gives a flat frame, `{ type, ...data }`, and a copy of the source when the emitter gave one.

The function MUST keep each event and each part of a sub-agent, with its source. Thus each consumer can filter them.

The module of the function MUST import only types from outside `src/contracts/`. Thus a browser can load it.

#### Scenario: An event of a sub-agent keeps its source

- **GIVEN** a `tool-started` event with the call path `["conversation-agent", "literature-reviewer"]`
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame holds the event and that call path

#### Scenario: The frame of a finished call holds its duration

- **GIVEN** a `tool-finished` event with `durationMs` 420
- **WHEN** `toChatFrame` translates the event
- **THEN** the frame holds `durationMs` 420

#### Scenario: An iteration gives no frame

- **WHEN** `toChatFrame` translates a loop `iteration` or the provider `done`
- **THEN** it gives `null`

### Requirement: applyChatFrame applies one frame to the messages of a live turn

The harness MUST export `applyChatFrame(messages, frame, assistantId)`. The function MUST give a new message list and the end signal of the turn. It MUST NOT change the list that it gets. It MUST obey these rules:

- A frame whose `source.callPath` has more than one entry comes from a sub-agent, and it changes nothing. The root agent of a chat turn has the call path `[agent.id]`.
- A `text-delta` adds its text to the last part if that part is text. If the last part is not text, the frame adds a text part.
- A `tool-started` adds a tool-call part with no outcome.
- A `tool-finished` sets the outcome on the tool-call part with the same call id. It also sets the detail and `durationMs` when the frame has them.
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

A test MUST give one sequence of loop events to the live path and to the reload path. The live path is `toChatFrame` and then `applyChatFrame`. The reload path is the display recorder, the stored shape, and the replay. The two message lists MUST be equal.

Each known difference MUST have its own test. The tests MUST NOT hide a difference. These are the known differences:

- A call that did not finish: the replay gives `incomplete`, and the live message gives no outcome.
- An ask with the status `pending` at the end of the turn: the replay gives `aborted`, and the live message keeps `pending`.
- A compaction: the replay gives a divider message between two assistant messages, and the live message holds the compaction part.
- A round with no streamed text: the replay takes the text of the model reply, and the live path shows no text.
- The text of two rounds with no part between them: the replay keeps two text parts, and the live message joins them.
- The facts of the stored rows: the replay adds the turn duration, the interruption, the author, and the creation time.

#### Scenario: One turn gives the same messages on the two paths

- **GIVEN** a turn with text, tool calls, a sub-agent, a plan card, an ask, and a run card
- **WHEN** the test gives its events to the two paths
- **THEN** the two message lists are equal

#### Scenario: A known difference stays visible

- **GIVEN** a turn that ends with an ask in the status `pending`
- **WHEN** the test gives its events to the two paths
- **THEN** the test shows `aborted` in the replay and `pending` in the live message
