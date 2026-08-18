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

### Requirement: A retired part key does not fail the read that meets it

A stored part whose key the current vocabulary no longer carries SHALL be dropped from the message it appears in, and the surrounding envelope SHALL be returned. The same SHALL apply to a part whose payload no longer satisfies the schema still standing behind its key. Each drop SHALL be reported through the logging seam with the row identity and the part key, so a deploy that retires a key is observable rather than silent.

A part key SHALL be retained in the vocabulary for as long as rows written under it must still render. The drop is a failsafe for the deploy that forgets, not a licence to retire a key that live rows depend on.

The reader SHALL NOT extend the same tolerance to a value it cannot identify as a part at all — a non-array message list, a part with no type, an unsupported envelope kind or version. Those are corruption or a format this version does not implement, not vocabulary drift, and there is no partial recovery available for a shape that cannot be walked.

Failing the whole read is the wrong response to a key one deploy older than the reader. It denies a user every message in the thread over one card, and when the read runs at startup it denies every user every thread. The blast radius must match the defect: one part.

#### Scenario: A retired key costs its own part and nothing else

- **GIVEN** a stored turn holding one part whose key the current vocabulary has retired, beside parts it still carries
- **WHEN** the transcript is loaded
- **THEN** the retired part is absent, every other part of the turn is returned, and the read succeeds

#### Scenario: A payload that no longer satisfies its schema is dropped, not raised

- **GIVEN** a stored part whose key still exists but whose payload predates a field the schema now requires
- **WHEN** the transcript is loaded
- **THEN** that part is dropped and the rest of the turn is returned

#### Scenario: A stale field does not fail a part

- **GIVEN** a stored payload carrying a field the schema has since dropped
- **WHEN** the transcript is loaded
- **THEN** the part is returned, the stale field having been ignored rather than rejected

#### Scenario: Every drop is reported

- **WHEN** the reader drops a part
- **THEN** it emits a warning naming the row identity, the part key, and whether the key or the payload was the cause

#### Scenario: Corruption still fails

- **WHEN** a stored envelope carries an unsupported kind or version, or a value that is not a UI message
- **THEN** the read rejects it rather than returning a partial projection

### Requirement: A transcript read reconstructs nothing

The transcript read SHALL consult only stored display projections. It SHALL NOT rebuild a display from the model transcript — not for a row whose projection is absent, and not for one whose projection it could not fully render. A row with no projection SHALL contribute no message. No card resolver or call-detail reconstruction SHALL be reachable from a read path or exposed on the embedder-facing surface.

Rebuilding a display from a transcript that never carried one infers what a user saw from what the model did. With that path available, a row reads as though it had always had a projection, the divergence between what was shown and what is replayed becomes invisible, and every later change to a tool or a card silently rewrites history. Skipping the row keeps the gap observable and the read total in what it consults.

#### Scenario: A stored projection is read without any resolver

- **GIVEN** a turn whose stored projection holds a card emitted by a tool that has since been renamed
- **WHEN** the transcript is loaded
- **THEN** the stored parts are returned and no resolver is constructed or invoked

#### Scenario: A row with no projection is skipped rather than reconstructed

- **GIVEN** a row that reaches a transcript read with no display projection
- **WHEN** the transcript is loaded
- **THEN** the row contributes no message and no reconstruction is attempted

#### Scenario: The reconstruction surface does not exist

- **WHEN** an embedder resolves the package's public surface
- **THEN** no card resolver and no transcript-to-display renderer is reachable from it

### Requirement: Boot does not read stored conversation display

The boot sequence SHALL NOT validate, rewrite, or otherwise traverse stored display envelopes. Tolerating an envelope this version cannot fully render is the reader's responsibility, discharged per row at the read that meets it.

A boot-time sweep couples every stored row to process startup: one row the current vocabulary cannot parse takes down the process for every tenant, and the failure arrives at the moment least able to absorb it, with no request to fail and no user to inform.

#### Scenario: A row the vocabulary cannot fully render does not affect startup

- **GIVEN** stored rows holding parts whose keys the current vocabulary has retired
- **WHEN** the harness boots
- **THEN** boot completes, and each affected part is dropped later, by the read that reaches its row

### Requirement: Conversation display migration does not alter DBOS streams

The display envelope and its backfill SHALL apply only to conversation turns in the `messages` table. Workflow/run lifecycle and step parts SHALL remain persisted and replayed exclusively through their DBOS streams, and the migration SHALL neither copy nor mutate those stream events.

#### Scenario: Run history remains in DBOS

- **GIVEN** a conversation containing a persisted `data-run-card` and a run with DBOS lifecycle events
- **WHEN** display backfill and transcript reload complete
- **THEN** the card reloads from conversation display storage while run progress and results continue to replay from the unchanged DBOS stream
