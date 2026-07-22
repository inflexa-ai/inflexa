## MODIFIED Requirements

### Requirement: Stored AI SDK messages convert to CortexMessage

A converter SHALL map stored AI SDK model-message envelopes to `CortexMessage` parts for the wire. Text content SHALL become text parts and tool calls SHALL become tool-call parts. Provider metadata or reasoning blocks the UI does not render SHALL be omitted from the display value without mutating the stored row. Consecutive same-role rows SHALL be coalesced into one message ONLY when that role is `assistant` (restoring the one-bubble-per-turn shape over the loop's per-step rows); adjacent `user` rows SHALL remain separate messages — they arise only from turns that persisted no reply, and merging them would fabricate a message the user never sent. A row carrying the interruption marker SHALL surface as `interrupted: true` on the `CortexMessage` it lands in (including when that row is coalesced into an assistant run); the field is optional and absent means not interrupted.

#### Scenario: A tool-using turn converts to CortexMessage

- **GIVEN** a stored assistant AI SDK message containing text and a tool call
- **WHEN** the converter runs
- **THEN** it yields a `CortexMessage` with a text part and a tool-call part

#### Scenario: Provider metadata is dropped from display without mutating storage

- **GIVEN** a stored message containing provider metadata not rendered by the UI
- **WHEN** the converter runs
- **THEN** the metadata is omitted from the `CortexMessage` and the stored row is unchanged

#### Scenario: Adjacent user rows stay separate bubbles

- **GIVEN** a thread holding two consecutive `user` rows (an aborted turn's lone user message followed by the next turn's user message)
- **WHEN** the converter runs
- **THEN** it yields two `user` messages, never one merged message

#### Scenario: An interrupted turn carries its flag through conversion

- **GIVEN** a persisted turn whose final assistant row carries the interruption marker
- **WHEN** the converter runs
- **THEN** the resulting assistant `CortexMessage` has `interrupted: true`, and every unmarked message omits the field
