## ADDED Requirements

### Requirement: Persisted conversation cards preserve emitted card data

Every durable conversation display card emitted during a turn SHALL be stored inside that turn's versioned display envelope, and transcript reload SHALL use the stored payload as the historical fact. Reload MUST NOT rebuild a card from a tool name, a tool input, current database state, or current filesystem state — not as a preference, and not as a fallback: a card is a record of what was shown, and anything recomputed from today's state is a different claim wearing the same shape.

#### Scenario: Tool rename does not change stored display

- **GIVEN** a persisted display envelope containing a card emitted by a tool that is later renamed or removed
- **WHEN** the transcript is reloaded
- **THEN** the card renders from its stored payload without consulting the historical tool name

#### Scenario: Mutable report state does not rewrite history

- **GIVEN** a turn whose stored report-preview card names version 1 and a later version 2 exists
- **WHEN** the earlier turn is reloaded
- **THEN** it continues to show the stored version-1 card rather than resolving to the latest preview

#### Scenario: Failure parts survive reload

- **GIVEN** a turn that emitted a durable report-preview failure part
- **WHEN** the transcript is reloaded
- **THEN** the same stored failure payload is available to the renderer even though it cannot be inferred from the tool call

### Requirement: Persisted cards retain semantic references

Persisting a display card SHALL freeze its emitted descriptor, not the referenced bytes or a host-specific resolved location. Hosts SHALL continue resolving paths and identifiers when the card is opened or rendered and SHALL continue degrading missing references without failing the transcript.

#### Scenario: Stored file card resolves at open time

- **GIVEN** a stored file-reference card carrying an analysis-rooted path
- **WHEN** the user opens it after the referenced file was removed
- **THEN** the host reports the reference as missing without modifying the stored card or failing transcript load
