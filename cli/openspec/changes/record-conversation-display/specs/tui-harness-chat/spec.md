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

### Requirement: An incomplete call renders as running

A reloaded tool call whose recorded outcome is `incomplete` SHALL render as running, and MUST NOT be reported as a success or as a failure.

`incomplete` is what the harness observed: a dispatch and no completion, because the turn was cut off mid-call. Reporting `ok` would claim a result the tool never returned; reporting an error would claim a failure it never had. It reads correctly because the message it sits in carries the interruption badge: the marker and the badge together are what say "in flight when the turn was cut off", so a renderer MUST NOT show one without the other.

The mapping from a recorded outcome to a rendered status SHALL be total and exhaustive over the harness's outcome union, with no default arm and no fallback for an unrecognized value. The harness carries a call's whole terminal state in one field precisely so a host need infer nothing; an exhaustive mapping is what converts a state added later into a build failure here rather than a silent mis-render, and it is what keeps two hosts reading the same projection from disagreeing about what a call did.

#### Scenario: An interrupted call renders as running beside the interruption badge

- **GIVEN** a persisted turn interrupted while a tool call was in flight
- **WHEN** the thread is reloaded
- **THEN** the call's recorded outcome is `incomplete`, it renders as running, and its message carries the interruption badge

#### Scenario: A newly added outcome does not compile silently

- **GIVEN** the harness widens its recorded-outcome union
- **WHEN** the host is rebuilt
- **THEN** the status mapping fails to compile until the new state is handled

## MODIFIED Requirements

### Requirement: One generation token orders every write to the message store

Each asynchronous producer that writes the conversation store MUST claim the same monotonic generation token at entry. It MUST check the token again after each `await`, before it writes the message store, the streaming signals, the error banner, or the chat status. These producers are a transcript load (`loadMessages`), a turn (`send`, through its emit adapter and `finishTurn`), and a retract (through its store splice and composer seed). The newest operation that started wins. Each older one MUST drop silently.

A turn thus supersedes a transcript load in flight. The load is a replay of durable state that the turn appends to, and the turn carries the live input of the user. A retract also supersedes a load in flight, because the load would replay the turn that the retract removes. `resetHotState` MUST also claim the token. Thus a load for a session that the user left can never fill the cleared store again. A retract that a session swap supersedes MUST drop its remaining store writes and its composer seed. Its durable removal of the thread turn, committed at the keypress, still completes.

The poll of the open thread (`pollOpenThread`) MUST NOT claim the token at entry. A poll that finds nothing new must not supersede a load. It records the token before its reads. It drops its result when the token moved, or when a send of this client is in flight. It claims a new token only to mount a changed transcript. The check of a send before its turn mounts under the token of that turn.

The replay of the transcript (the harness `storedMessagesToChat`, which the local server runs on the rows of the thread) MUST be synchronous. It resolves no workspace root, builds no card or detail resolver, issues no query, and has no failure mode of its own — so the only failure a load reports is a page read's. The generation check MUST remain immediately before the store write even when no await separates it from the preceding check, because the invariant belongs to the write rather than to any particular await.

A row carrying no stored projection MUST contribute nothing, rather than being reconstructed from the model transcript.

#### Scenario: A load resolving mid-turn does not wipe the turn

- **WHEN** `loadMessages` is awaiting its page read and the user submits a turn, and the page read then resolves
- **THEN** the load drops without a write
- **AND** the user message and the in-flight assistant message stay mounted
- **AND** the next streamed parts append to that assistant message

#### Scenario: A turn submitted the instant boot completes survives

- **WHEN** the runtime reaches `ready`, the transcript load starts, and the user submits a message typed during the boot animation
- **THEN** the turn renders normally, and the transcript load drops

#### Scenario: A load started for a swapped-away session never lands

- **WHEN** `loadMessages` is in flight for session A and `resetHotState` runs for a swap to session B
- **THEN** the session-A load drops without a write

#### Scenario: A load resolving mid-retract does not resurrect the retracted turn

- **WHEN** `loadMessages` is in flight and a retract claims the token, and the page read then resolves
- **THEN** the load drops without a write, and the spliced store stays spliced

#### Scenario: A swap mid-retract drops the UI writes, not the thread removal

- **WHEN** `resetHotState` supersedes a retract after its abort settled
- **THEN** no store write or composer seed lands, and the old thread's orphan turn is still removed

#### Scenario: A poll during a send mounts nothing

- **GIVEN** a send of this client whose turn runs
- **WHEN** the poll reads the open thread and finds a new `updatedAt`
- **THEN** the poll mounts nothing, and the turn keeps its messages

#### Scenario: A superseded load never reaches the store

- **GIVEN** two transcript loads for the same session, the older resolving last
- **WHEN** both complete
- **THEN** the store holds the newer transcript

#### Scenario: A moved workspace does not affect a transcript read

- **GIVEN** a thread whose analysis workspace no longer resolves
- **WHEN** the thread is reloaded
- **THEN** the transcript renders from its stored projections, unaffected
