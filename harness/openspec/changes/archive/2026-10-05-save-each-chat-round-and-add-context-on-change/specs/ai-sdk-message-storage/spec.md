## ADDED Requirements

### Requirement: A context record carries its kind and its hash

The harness MUST mark a context record (see the chat-turn capability) with two keys in the harness `providerOptions` namespace: the kind of the record, and the SHA-256 hash of its text as lowercase hex. The record MUST also carry the synthetic marker. Thus no turn-boundary reader reads it as a user start.

The record MUST NOT carry the record marker of a host record. The display does not show a context record, and the transcript replay reads only the display projections.

A pure helper pair MUST make a record and read the kind and the hash of a stored message. A message without the two keys MUST read as no record.

A provider reads only its own namespace. Thus the two keys ride in the stored row, and they never reach the wire.

#### Scenario: A record round-trips

- **GIVEN** a working-memory record that the store appended
- **WHEN** the row is read back and the helper reads it
- **THEN** it gives the kind `working-memory` and the hash of the text

#### Scenario: A record opens no turn

- **GIVEN** a stored turn whose user message has two context records after it
- **WHEN** the token window or the tail retraction looks for a turn boundary
- **THEN** the boundary is the user message, and no record is a boundary

#### Scenario: A plain message is no record

- **WHEN** the helper reads a user message with no harness keys
- **THEN** it gives no record

#### Scenario: The keys never reach the wire

- **GIVEN** a request whose messages hold a context record
- **WHEN** the Anthropic provider renders the request
- **THEN** the body holds the text of the record, and no key of the harness namespace
