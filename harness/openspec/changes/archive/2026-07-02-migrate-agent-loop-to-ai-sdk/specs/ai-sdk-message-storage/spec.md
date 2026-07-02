## ADDED Requirements

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
