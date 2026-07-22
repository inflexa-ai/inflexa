## ADDED Requirements

### Requirement: An interruption marker survives the storage round trip

The harness SHALL mark a message whose production was cut off by a client abort via a dedicated key in the harness `providerOptions` namespace — the same channel as the synthetic-message marker, and for the same reason: it is the only field of an AI SDK `ModelMessage` that travels from the loop, through `appendTurn`, into a stored row and back without a schema change. The marker SHALL ride the **assistant** message (never a `user` or `tool` row), so no turn-boundary reader (`isGenuineUserStart`, the tail-retract predicate, window snapping) observes it. A pure helper pair SHALL mark and read it; readers of stored rows SHALL treat an absent key as not interrupted.

#### Scenario: A marked assistant message round-trips

- **GIVEN** an assistant message stamped with the interruption marker and persisted via `appendTurn`
- **WHEN** the row is read back and the marker helper is applied
- **THEN** it reports interrupted, and an unmarked sibling row reports not interrupted

#### Scenario: The marker never affects turn boundaries

- **GIVEN** a persisted turn whose last assistant message carries the interruption marker
- **WHEN** the tail turn is retracted or the token window is snapped
- **THEN** boundary detection behaves exactly as for an unmarked turn — the marker rides a non-boundary role by construction
