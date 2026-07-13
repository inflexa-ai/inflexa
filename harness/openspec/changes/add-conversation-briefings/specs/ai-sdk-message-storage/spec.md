# ai-sdk-message-storage Specification (delta)

## MODIFIED Requirements

### Requirement: Thread messages are stored as AI SDK model-message envelopes

Conversation thread history SHALL store each durable model message as a harness envelope. The envelope `kind` SHALL be a closed union: `"ai-sdk-model-message"` (a conversation-turn message: the AI SDK major version used to write it plus the inner AI SDK `ModelMessage`) or `"briefing"` (a standing briefing; see the briefing-envelope requirement). The harness SHALL validate the envelope before use and SHALL reject unsupported `kind` or AI SDK major versions.

#### Scenario: A stored envelope validates

- **WHEN** a row contains `kind: "ai-sdk-model-message"`, a supported `aiSdkMajor`, and a valid AI SDK `ModelMessage`
- **THEN** the thread-history reader returns the inner message for loop assembly

#### Scenario: A stored briefing envelope validates

- **WHEN** a row contains `kind: "briefing"` with a valid briefing envelope body
- **THEN** the thread-history reader returns its inner message for loop assembly, marked as a briefing

#### Scenario: An unsupported envelope fails closed

- **WHEN** a row contains an unknown `kind` or unsupported `aiSdkMajor`
- **THEN** the thread-history reader rejects the row instead of silently coercing it

## ADDED Requirements

### Requirement: Briefing envelopes carry briefing identity and the message verbatim

A briefing envelope SHALL carry `kind: "briefing"`, the briefing definition `name`, the rendered `caption`, the AI SDK major version, and the wrapped `user` `ModelMessage` exactly as injected. The stored message is the source of truth for what the model saw: changes to a briefing definition's template SHALL NOT require migrating or rewriting existing rows.

#### Scenario: A briefing envelope round-trips verbatim

- **GIVEN** a standing briefing injected and persisted
- **WHEN** the thread is read back
- **THEN** the envelope returns the same `name`, `caption`, and byte-identical message content

#### Scenario: A template change leaves stored briefings untouched

- **GIVEN** threads persisted with an older briefing template
- **WHEN** the briefing definition's template changes and the harness restarts
- **THEN** no backfill runs and existing rows are returned unchanged
