# ai-sdk-message-storage Specification

## Purpose

Define how conversation thread history stores durable model messages as versioned AI SDK model-message envelopes, and how startup backfills legacy Anthropic-shaped rows into that envelope so runtime request paths read exactly one format. Covers envelope validation, the idempotent startup backfill (including tool-traffic conversion and preservation of signed provider metadata), and the removal plan for legacy Anthropic message columns.
## Requirements
### Requirement: Thread messages are stored as AI SDK model-message envelopes

Conversation thread history SHALL store each durable model message as a harness envelope containing `kind: "ai-sdk-model-message"`, the AI SDK major version used to write it, and the inner AI SDK `ModelMessage`. The harness SHALL validate the envelope before use and SHALL reject unsupported `kind` or AI SDK major versions.

#### Scenario: A stored envelope validates

- **WHEN** a row contains `kind: "ai-sdk-model-message"`, a supported `aiSdkMajor`, and a valid AI SDK `ModelMessage`
- **THEN** the thread-history reader returns the inner message for loop assembly

#### Scenario: An unsupported envelope fails closed

- **WHEN** a row contains an unknown `kind` or unsupported `aiSdkMajor`
- **THEN** the thread-history reader rejects the row instead of silently coercing it

### Requirement: Startup backfills legacy Anthropic rows before runtime reads history

Harness startup SHALL run an idempotent backfill that converts legacy Anthropic-shaped message rows into AI SDK model-message envelopes before the runtime serves thread history. Old-format conversion SHALL exist only in the startup migration module and its tests. Runtime request paths SHALL read only the AI SDK envelope after startup backfill completes.

#### Scenario: Legacy rows are migrated at startup

- **WHEN** startup finds a legacy row without an AI SDK envelope
- **THEN** it converts the row into an AI SDK model-message envelope and persists it before serving requests

#### Scenario: Runtime has no old-format fallback

- **WHEN** startup completes successfully
- **THEN** `appendTurn`, `loadRecent`, `loadPage`, and display conversion read the AI SDK envelope path only

#### Scenario: Backfill failure blocks startup

- **WHEN** a legacy row cannot be converted into an AI SDK model-message envelope
- **THEN** startup fails with the row identity and does not serve runtime traffic

### Requirement: Startup backfill documents old-column removal

The startup backfill implementation SHALL include a code comment stating that legacy Anthropic message columns should be removed after the migration window. Old columns MAY remain temporarily for inspection or rollback, but runtime code SHALL NOT depend on them after backfill.

#### Scenario: Backfill code carries removal note

- **WHEN** the startup backfill code is reviewed
- **THEN** it contains a comment identifying the legacy Anthropic message columns as temporary and removable after the migration window

### Requirement: Legacy Anthropic tool traffic converts to AI SDK tool messages

The backfill SHALL preserve tool-call continuations by converting assistant `tool_use` blocks into AI SDK tool-call parts and corresponding legacy user `tool_result` blocks into AI SDK tool-result messages. It SHALL preserve the original tool-call ids, tool names, inputs, result payloads, and error markers where representable.

#### Scenario: Tool-use and tool-result pair survives backfill

- **WHEN** a legacy turn contains an assistant `tool_use` followed by a user `tool_result`
- **THEN** the migrated AI SDK messages preserve the tool-call id and provide a valid tool result for the same id

### Requirement: Provider-specific signed metadata is preserved where AI SDK supports it

The backfill and runtime message writer SHALL preserve provider-specific signed reasoning/cache metadata, including Anthropic signed thinking/cache metadata, in AI SDK provider metadata fields where supported. If a provider feature cannot be represented by AI SDK, the migration SHALL fail rather than silently dropping data required for valid continuation.

#### Scenario: Anthropic signed thinking metadata survives migration

- **WHEN** a legacy message contains signed Anthropic thinking metadata that AI SDK can represent
- **THEN** the migrated envelope stores that metadata in the AI SDK message/provider metadata

#### Scenario: Required signed metadata cannot be represented

- **WHEN** a legacy message contains required signed provider metadata that cannot be represented
- **THEN** startup backfill fails the row instead of writing a lossy envelope

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

