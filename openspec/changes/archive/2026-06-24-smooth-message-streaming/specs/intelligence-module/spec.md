## ADDED Requirements

### Requirement: Assistant part is broadcast before streaming

The chat engine SHALL emit a `part.updated` bus event for the empty assistant part immediately after creating the assistant turn and **before** the streaming loop begins — symmetric with the existing user-part broadcast. This places the streaming part into the conversation store so the view can bind the accumulating `streamText` to a rendered part and show tokens incrementally as they arrive, rather than only after the turn completes. The final `part.updated` emitted after streaming (carrying the full text) SHALL remain unchanged.

#### Scenario: Empty assistant part is broadcast up front

- **WHEN** the engine creates the assistant message and its empty part
- **THEN** it emits `message.created` for the assistant message **and** a `part.updated` for the empty assistant part before reading the first stream delta

#### Scenario: Live tokens render during the turn

- **WHEN** `part.delta` events arrive after the assistant part has been broadcast
- **THEN** the view renders the accumulating text in the streaming message block while the turn is still in progress

#### Scenario: Final text still persisted and broadcast

- **WHEN** the stream completes (or is aborted)
- **THEN** the engine persists the accumulated text and emits the final `part.updated` followed by `session.status` idle, exactly as before
