## MODIFIED Requirements

### Requirement: A compaction marks its messages

The harness MUST mark each message of a compaction exchange with the id of the compaction, in the harness `providerOptions` namespace. It MUST mark a compaction marker with these values in the same namespace:

- the kind `summary`
- the id of the compaction
- the trigger, `turn-start` or `mid-turn`
- `tokensBefore`, the input tokens of the last request before the compaction
- the duration of the compaction

A marker carries no figure of the new view, because no request reported one yet. A marker from before this change has no trigger, and it carries an estimate of the new view. The helper MUST still read such a marker, and it MUST ignore that estimate.

The harness writes no drop marker. Harness 0.40.0 and later versions wrote drop markers into stored threads. Thus the helper MUST still read a drop marker with the count of the turns that the view keeps.

A marker and the request of an exchange MUST carry the synthetic marker. Thus no turn-boundary reader reads one of them as a user start. They MUST NOT carry the record marker, because the display shows a marker through its own divider and shows no exchange message.

A mark on an assistant message MUST merge into the harness namespace, and it MUST keep each other namespace. Thus a signed thinking signature in the `anthropic` namespace survives the mark.

A pure helper set MUST make each mark and read it back. A message without the keys MUST read as no marker and as no exchange message. A provider reads only its own namespace, thus the keys ride in the stored row and never reach the wire.

#### Scenario: A marker round-trips

- **GIVEN** a summary marker that the store appended
- **WHEN** the row is read back and the helper reads it
- **THEN** it gives the kind `summary`, the id, the trigger, `tokensBefore`, and the duration

#### Scenario: An older marker reads with no trigger

- **GIVEN** a stored summary marker with no trigger and with an estimate of the new view
- **WHEN** the helper reads the row
- **THEN** it gives a summary marker with no trigger and no estimate of the new view

#### Scenario: A stored drop marker still reads

- **GIVEN** a stored drop marker that keeps 4 turns
- **WHEN** the helper reads the row
- **THEN** it gives the kind `drop` and 4 kept turns

#### Scenario: A marker opens no turn

- **GIVEN** a stored turn that holds an exchange and a marker after its user message
- **WHEN** the view rule or the tail retract looks for a turn boundary
- **THEN** the boundary is the user message, and neither the marker nor the request of the exchange is a boundary

#### Scenario: A mark keeps the signature

- **GIVEN** an assistant message of an exchange with a reasoning part that carries an `anthropic` signature
- **WHEN** the harness marks the message
- **THEN** the marked message carries the exchange mark and the same signature

#### Scenario: A plain message is no marker

- **WHEN** the helpers read a message with no harness keys
- **THEN** they give no marker and no exchange id

#### Scenario: The marks never reach the wire

- **GIVEN** a request whose messages hold a summary marker
- **WHEN** the Anthropic provider renders the request
- **THEN** the body holds the text of the marker, and no key of the harness namespace

## ADDED Requirements

### Requirement: An assistant message carries the input tokens of its request

The harness MUST store the input tokens that the provider reported for a request on the assistant message of its reply. The figure rides in the harness `providerOptions` namespace, under the key `requestInputTokens`.

The mark MUST merge into the harness namespace, and it MUST keep each other namespace. A pure helper MUST make the mark, and a pure helper MUST read it back. The read MUST give no figure for a message that is not an assistant message, and for a value that is not a finite number.

The key rides in the stored row, and it never reaches the wire. Thus the next turn reads the figure back, and no provider sees it.

#### Scenario: The figure round-trips and keeps the signature

- **GIVEN** an assistant message with a reasoning part that carries an `anthropic` signature
- **WHEN** the helper marks the message with 302,000 input tokens, and the helper reads the mark
- **THEN** the read gives 302,000, and the message keeps the same signature

#### Scenario: A message with no figure reads as no figure

- **WHEN** the helper reads an assistant message with no key, or a user message
- **THEN** it gives no figure

#### Scenario: The figure never reaches the wire

- **GIVEN** a request whose messages hold an assistant message with the figure
- **WHEN** the Anthropic arm, the OpenAI-compatible arm, or the OpenAI arm renders the request
- **THEN** the body holds the text of the message, and no key of the harness namespace
