## ADDED Requirements

### Requirement: A compaction marks its messages

The harness MUST mark each message of a compaction exchange with the id of the compaction, in the harness `providerOptions` namespace. It MUST mark a compaction marker with these values in the same namespace:

- the kind, `summary` or `drop`
- the id of the compaction
- the estimate of the view before the compaction, and the estimate of the new view
- the duration of the compaction
- for a drop marker, the count of the turns that the view keeps

A marker and the request of an exchange MUST carry the synthetic marker. Thus no turn-boundary reader reads one of them as a user start. They MUST NOT carry the record marker, because the display shows a marker through its own divider and shows no exchange message.

A mark on an assistant message MUST merge into the harness namespace, and it MUST keep each other namespace. Thus a signed thinking signature in the `anthropic` namespace survives the mark.

A pure helper set MUST make each mark and read it back. A message without the keys MUST read as no marker and as no exchange message. A provider reads only its own namespace, thus the keys ride in the stored row and never reach the wire.

#### Scenario: A marker round-trips

- **GIVEN** a summary marker that the store appended
- **WHEN** the row is read back and the helper reads it
- **THEN** it gives the kind `summary`, the id, the two estimates, and the duration

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
