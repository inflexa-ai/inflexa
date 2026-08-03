## ADDED Requirements

### Requirement: Conversation display is stored as a versioned AI SDK UI envelope

Each persisted conversation turn SHALL carry a display envelope containing `kind: "ai-sdk-ui-messages"`, the supported AI SDK major version, a harness display-schema version, and the complete ordered AI SDK `UIMessage` projection for that turn. The harness SHALL validate the envelope before display use and SHALL reject unsupported kinds or versions.

#### Scenario: A display envelope validates

- **WHEN** a turn contains the supported kind, AI SDK major, display-schema version, and valid AI SDK UI messages
- **THEN** the display reader returns those UI messages in their stored order

#### Scenario: An unsupported display envelope fails closed

- **WHEN** a turn contains an unknown display-envelope kind or unsupported version
- **THEN** the reader rejects it rather than silently coercing or reconstructing it

### Requirement: The stored parts vocabulary mirrors the display representation

The envelope's stored parts SHALL be able to express everything the display representation carries, without loss. AI SDK `UIMessage` supplies the CONTAINER — message identity, role, ordering, metadata, and runtime validation — and text rides as a text part; every other part SHALL ride as a typed custom-data part whose payload is the display part minus its discriminant.

A tool call SHALL therefore be stored as a data part carrying its call id, tool name, one-line detail, and a REQUIRED outcome holding its whole terminal state: `ok`, `error`, `denied`, or `incomplete`. It MUST NOT be stored through a representation that cannot hold all of those: an outcome flattened to a boolean loses the distinction between a failure and a user's denial, and a dropped detail cannot be recovered without re-reading the tool's input schema — which is the tool-name coupling this capability exists to remove. Because storage is lossless in both directions, the read is a discriminant move rather than an interpretation.

The terminal state SHALL be ONE field, never a lifecycle field beside an optional outcome. A record describes a call that is no longer running, so "in flight" is not a state it can be in; a turn cut off mid-call recorded a dispatch and no completion, which is what `incomplete` says. Splitting the fact across two fields admits pairs that mean nothing and leaves every consumer to invent the meaning of the combination — so two hosts reading the same projection could disagree about what a call did, with nothing to catch it. One field makes a consumer's switch exhaustive, and a consumer that forgets a state fails to compile rather than silently reporting a success.

#### Scenario: Every display part round-trips through storage

- **WHEN** a turn's display parts are stored and read back
- **THEN** each part equals what was recorded, field for field, with no field dropped or defaulted

#### Scenario: A denied call is not stored as a failed one

- **WHEN** a turn contains a call the user denied and a call that failed
- **THEN** the stored projection distinguishes them, and so does the read

### Requirement: Model and display histories are separate projections

Conversation turns SHALL persist model and display projections atomically, but the agent-history read SHALL select and return only stored AI SDK `ModelMessage`s. Display envelopes SHALL NOT contribute provider input, history token counts, token-budget eviction, or prompt-cache bytes.

#### Scenario: Display parts do not enter the next model request

- **GIVEN** a stored turn whose display envelope contains a large presentation and file-reference card
- **WHEN** the next agent turn loads recent history
- **THEN** it receives the same model messages and token accounting it would receive if the display envelope were absent

#### Scenario: Atomic append cannot leave one projection behind

- **WHEN** persistence fails while appending a turn's model and display projections
- **THEN** neither projection is committed for that turn

### Requirement: The live display recorder preserves the replayable turn

One conversation display recorder SHALL observe every top-level provider-text, tool-lifecycle, durable conversation-data, and approval event that the live surface observes. It SHALL produce complete UI messages whose parts preserve visible emission order, copy payloads at receipt, exclude sub-agent and transient parts, and fold reconciling parts latest-wins by stable id — a tool call reaching its finished state and an approval reaching its terminal status being the same operation, each replacing in the position it first took.

The recorder SHALL record each call's outcome and detail as the live surface received them, rather than leaving either to be recomputed later. A call SHALL be recorded `incomplete` when it is dispatched and overwritten with its real outcome when it finishes, so the record is honest at every instant and a turn ending mid-call needs no closing pass. Stamping an unfinished call a failure or a success would report something nothing produced.

#### Scenario: Text and cards preserve their relative order

- **WHEN** a turn emits text, then a display card, then more text
- **THEN** the stored UI message contains those three visible parts in the same order

#### Scenario: Concurrent tool emissions preserve observed order

- **WHEN** concurrently executing tools emit display parts in an order different from tool-call declaration order
- **THEN** the stored UI message preserves the order observed by the shared recorder

#### Scenario: Approval reaches a terminal stored state

- **WHEN** `data-ask` is emitted pending and later re-emitted resolved or rejected under the same id
- **THEN** the stored UI message contains one approval part in the terminal state

#### Scenario: Sub-agent display is excluded

- **WHEN** a nested agent emits a display part that the top-level conversation surface filters
- **THEN** that part is absent from the stored top-level UI message

#### Scenario: Calls finishing out of order keep their observed positions

- **WHEN** two concurrent calls start in one order and finish in the other
- **THEN** each stored part stays in the position its call first took

#### Scenario: An interrupted call is stored as incomplete, not as failed or succeeded

- **WHEN** a turn is interrupted while a call is in flight
- **THEN** the stored part reports the call `incomplete`, in the one field that carries its terminal state

### Requirement: Startup backfills legacy turns before runtime reads

Harness startup SHALL run an idempotent, bounded backfill for turns lacking a display envelope before serving conversation reads, so the runtime read path never meets a row without a projection. The backfill SHALL use the migration renderer to persist display envelopes, recovering each legacy call's outcome from its paired tool-result block and its detail from the persisted input. Recovering the detail requires the assembled conversation roster — embedder-contributed tools included — so the backfill SHALL run after runtime assembly and before any traffic, assembly itself starting none. Missing mutable resources SHALL produce a valid cardless display projection and mark the turn migrated; database faults or invalid stored envelopes SHALL fail startup with the turn identity.

#### Scenario: A reconstructable legacy card is frozen

- **WHEN** startup encounters a legacy tool-calling turn whose current resolver can reconstruct a card
- **THEN** it persists that card inside a version-1 UI display envelope before runtime starts

#### Scenario: A missing historical resource does not retry forever

- **WHEN** a legacy turn references a plan, run, preview, or workspace resource that no longer resolves
- **THEN** startup persists the remaining model-derived UI projection without that card and treats the turn as migrated

#### Scenario: Backfill database failure blocks startup

- **WHEN** the backfill cannot read or persist a turn because of a database fault
- **THEN** startup fails with the thread and turn identity and retries on the next launch

#### Scenario: Re-running startup is idempotent

- **GIVEN** some or all legacy turns already carry valid display envelopes
- **WHEN** startup runs the backfill again
- **THEN** it leaves those envelopes unchanged and processes only unmigrated turns

### Requirement: Reconstruction has no runtime caller

Display reconstruction — the card resolver, the outcome recovery from paired tool-result blocks, and the call-detail resolver — SHALL be reachable only from the startup migration. It SHALL NOT be offered as a runtime fallback for a turn whose display envelope is absent, and SHALL NOT be re-exported as part of the embedder-facing surface, so no host can wire it back into a transcript read.

A fallback is what makes reconstruction permanent. With one in place, a row that fails to migrate reads as though it had migrated, the divergence between what was shown and what is replayed becomes invisible, and every future change to a tool or a card silently rewrites history. Skipping an unmigrated row instead makes the gap observable and keeps the runtime read total in what it consults: the stored projection, and nothing else.

#### Scenario: A stored projection is read without any resolver

- **GIVEN** a turn whose stored projection holds a card emitted by a tool that has since been renamed
- **WHEN** the transcript is loaded
- **THEN** the stored parts are returned and no resolver is constructed or invoked

#### Scenario: An unmigrated row is skipped rather than reconstructed

- **GIVEN** a row that reaches a transcript read with no display projection
- **WHEN** the transcript is loaded
- **THEN** the row contributes no message and no reconstruction is attempted

#### Scenario: The reconstruction surface is not embedder-facing

- **WHEN** an embedder resolves the package's public surface
- **THEN** the card resolver and the call-detail resolver are absent from it

### Requirement: Conversation display migration does not alter DBOS streams

The display envelope and its backfill SHALL apply only to conversation turns in the `messages` table. Workflow/run lifecycle and step parts SHALL remain persisted and replayed exclusively through their DBOS streams, and the migration SHALL neither copy nor mutate those stream events.

#### Scenario: Run history remains in DBOS

- **GIVEN** a conversation containing a persisted `data-run-card` and a run with DBOS lifecycle events
- **WHEN** display backfill and transcript reload complete
- **THEN** the card reloads from conversation display storage while run progress and results continue to replay from the unchanged DBOS stream
