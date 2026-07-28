## ADDED Requirements

### Requirement: Synthetic messages are a public, host-authorable primitive

The harness SHALL expose the synthetic-message primitives — the constructor that produces a
marked message and the predicate that recognises one — as part of its public surface, and
the contract SHALL admit an **embedder** as an author, not only the agent loop. A host
appending a record of out-of-band work (an analysis run's outcome) into a conversation
thread needs a message the model will read but that is not user input, which is exactly what
the marker already denotes.

The marker itself SHALL remain harness-owned: a host SHALL author such a message only
through the exported constructor and SHALL NOT hand-assemble the `providerOptions` marker,
so the constant that the turn-boundary predicates are built from cannot fork.

No new conversation-store method SHALL be added for this. The existing thread-history
constructor and its turn-append operation are already public and already sufficient; the
store's deliberately narrow surface is unchanged.

#### Scenario: A host appends a synthetic message

- **WHEN** an embedder appends a message built with the exported synthetic-message constructor to a thread
- **THEN** the message is stored, is visible to a later thread read, and is included in the context assembled for the next turn

#### Scenario: The marker is not hand-assembled

- **WHEN** an embedder needs a synthetic message
- **THEN** it obtains one from the exported constructor, and the marker key and namespace are never restated at the call site

### Requirement: A host-authored synthetic message opens no turn

A synthetic message authored by a host SHALL be subject to exactly the same turn-boundary
exclusions as one synthesized by the loop. It SHALL NOT be read as the start of a
conversation turn by any reader: not the turn grouping used for display paging, not the
token-window snapping, and not the tail-retraction cut point. The existing TypeScript
predicate and its SQL twin SHALL remain the single definition of that exclusion and SHALL
NOT be duplicated or relaxed.

Because such a message opens no turn, it belongs to the turn that precedes it, and a
tail-retraction that removes that turn SHALL remove the synthetic message with it. This is
the accepted consequence of the exclusion, not a defect: the alternative — letting the
message open a turn — would split one turn in two for the token window and hand retraction
a mid-turn cut point, which is the failure the marker exists to prevent.

#### Scenario: A host-appended notice does not split a turn

- **GIVEN** a completed exchange of one user message and one assistant reply
- **WHEN** a host appends a synthetic message after it
- **THEN** the thread still reads as one turn for display paging and for the token window

#### Scenario: Retracting the enclosing turn removes the notice with it

- **GIVEN** a turn followed by a host-appended synthetic message and no later user message
- **WHEN** the last turn is retracted
- **THEN** the turn and the synthetic message are both removed, and the thread returns to the state it held before that turn

#### Scenario: A later turn insulates the notice from retraction

- **GIVEN** a host-appended synthetic message followed by a genuine user message and its reply
- **WHEN** the last turn is retracted
- **THEN** only that later turn is removed and the synthetic message remains
