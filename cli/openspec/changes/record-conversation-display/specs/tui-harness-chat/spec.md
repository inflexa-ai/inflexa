## ADDED Requirements

### Requirement: A turn records what it displayed and persists it with the turn

The turn engine SHALL wrap its event sink in the harness display recorder and persist the recorded projection in the same append as the turn's model messages and its usage rollup.

Every producer of a displayed event SHALL emit through that recorded sink. The streaming provider wrapper and the approval binding SHALL therefore be constructed over the sink the engine supplies, not over one captured beforehand: both reach the live surface correctly either way, and a turn whose text deltas or approval parts bypassed the recorder replays missing most of what the user saw.

The projection SHALL be taken on every phase that reaches the append — completed, aborted, and failed — for the same reason the rollup is. An aborted turn displayed real work, and its projection is what the retract window renders.

#### Scenario: A completed turn stores its projection

- **GIVEN** a turn that streamed text and emitted a card
- **WHEN** it completes
- **THEN** the append carries a display projection holding both, in the order they were shown

#### Scenario: An aborted turn stores what it displayed

- **GIVEN** a turn interrupted after emitting part of its reply
- **WHEN** the engine persists the partial turn
- **THEN** the append carries the projection of what was shown, marked interrupted

#### Scenario: Provider text reaches the recorder

- **GIVEN** a turn whose reply arrives as provider text deltas
- **WHEN** the turn is reloaded
- **THEN** the reply is present, having been recorded rather than reconstructed

#### Scenario: An approval part reaches the recorder

- **GIVEN** a turn in which a tool requested approval and the user answered
- **WHEN** the turn is reloaded
- **THEN** the approval card is present in its terminal state

### Requirement: A run-outcome record carries its own projection

A record of out-of-band work appended to a thread SHALL be appended through the harness's record constructor, so it carries both its model message and its display projection.

A record appended without one is stored and read by the model but never displayed — a durable write that succeeds and then is invisible, with nothing to indicate why.

#### Scenario: An appended run outcome is visible in the transcript

- **GIVEN** a completed run whose outcome is recorded to the thread
- **WHEN** the thread is reloaded
- **THEN** the record renders as an event message

### Requirement: A call with no recorded outcome renders as running

A reloaded tool call that carries no outcome SHALL render as running, and MUST NOT be reported as a success or as a failure.

It has no outcome because the harness observed a dispatch and no completion — the turn was cut off mid-call — and deliberately records that rather than inventing one. Reporting `ok` would claim a result the tool never returned; reporting an error would claim a failure it never had. It reads correctly because the message it sits in carries the interruption badge: the marker and the badge together are what say "in flight when the turn was cut off", so a renderer MUST NOT show one without the other.

#### Scenario: An interrupted call renders as running beside the interruption badge

- **GIVEN** a persisted turn interrupted while a tool call was in flight
- **WHEN** the thread is reloaded
- **THEN** the call renders as running and its message carries the interruption badge

## MODIFIED Requirements

### Requirement: One generation token orders every write to the message store

One generation token SHALL order every asynchronous write to the message store, so the newest operation STARTED wins regardless of which finishes first. A superseded transcript load MUST NOT reach the store.

The transcript read itself SHALL be a synchronous replay of stored projections. It resolves no workspace root, builds no card or detail resolver, issues no query, and has no failure mode of its own — so the only failure a load reports is a page read's. The generation check SHALL remain immediately before the store write even when no await separates it from the preceding check, because the invariant belongs to the write rather than to any particular await.

A row carrying no stored projection SHALL contribute nothing, rather than being reconstructed from the model transcript.

#### Scenario: A superseded load never reaches the store

- **GIVEN** two transcript loads for the same session, the older resolving last
- **WHEN** both complete
- **THEN** the store holds the newer transcript

#### Scenario: A moved workspace does not affect a transcript read

- **GIVEN** a thread whose analysis workspace no longer resolves
- **WHEN** the thread is reloaded
- **THEN** the transcript renders from its stored projections, unaffected
