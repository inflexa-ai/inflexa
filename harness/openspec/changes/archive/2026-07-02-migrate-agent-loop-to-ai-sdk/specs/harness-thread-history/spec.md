## MODIFIED Requirements

### Requirement: A turn is appended atomically with monotonic sequence

`appendTurn(threadId, messages)` SHALL write all messages of a turn in one transaction, assigning each a `seq` that is monotonically increasing per thread. Each row SHALL store its model content as an AI SDK model-message envelope and a `tokens` count computed at write time.

#### Scenario: A turn round-trips

- **GIVEN** a turn of AI SDK model messages appended to a thread
- **WHEN** the thread is read back
- **THEN** the messages return oldest-first with strictly increasing `seq`

#### Scenario: Provider metadata survives persistence

- **GIVEN** a message containing provider metadata required for continuation is appended
- **WHEN** it is read back
- **THEN** the provider metadata is byte-identical where AI SDK represents it

### Requirement: Thread history is conversation-scoped

The `messages` table and `ThreadHistory` SHALL serve conversation threads only. Workflow and sandbox agent loops SHALL NOT write to it; their message durability is the DBOS step cache and is not migrated by the AI SDK thread-history backfill.

#### Scenario: The interface offers no generic message insert

- **GIVEN** the `ThreadHistory` interface
- **WHEN** a caller inspects it
- **THEN** it exposes only conversation-turn operations (`appendTurn`, `loadRecent`), not a generic row insert

### Requirement: A paginated message read backs the messages endpoint

`ThreadHistory` SHALL provide a thread-scoped, paginated read (`loadPage(threadId, page, perPage)`) of the `messages` table for serving the thread messages endpoint, returning a page of AI SDK model-message envelopes (oldest-first) together with `total`, `page`, `perPage`, and `hasMore`. Pagination SHALL be by whole turns, so a multi-row turn always reloads intact. This read SHALL be distinct from `loadRecent`, which windows by token budget for the LLM.

#### Scenario: A page of messages is returned with totals

- **GIVEN** a thread with more messages than one page holds
- **WHEN** the paginated read is called with a page and perPage
- **THEN** it returns that page oldest-first plus `total` and `hasMore`

#### Scenario: The display read is not token-windowed

- **GIVEN** a thread whose total tokens exceed the loop budget
- **WHEN** the paginated read is called
- **THEN** it returns messages by page boundaries, not by token budget, and evicts nothing

## REMOVED Requirements

### Requirement: loadRecent returns a valid Anthropic message sequence

**Reason**: The loop transcript is no longer Anthropic-shaped.

**Migration**: `loadRecent` returns a valid AI SDK model-message sequence, preserving whole turns and tool-call/tool-result continuity.

### Requirement: Stored content blocks convert to CortexMessage

**Reason**: Stored rows no longer contain Anthropic `ContentBlockParam[]`.

**Migration**: Convert stored AI SDK model-message envelopes to `CortexMessage` display parts without mutating storage.

## ADDED Requirements

### Requirement: loadRecent returns a valid AI SDK model-message sequence

The window returned by `loadRecent` SHALL always begin on a genuine user-input turn and SHALL never split an AI SDK tool-call/tool-result continuation. The turn is the atomic unit; a turn is never half-loaded. If the most recent complete turn alone exceeds the budget, it SHALL be returned in full.

#### Scenario: The window is snapped past an orphan tool result

- **GIVEN** a token cut that would start the window on a tool-result continuation
- **WHEN** `loadRecent` snaps the boundary
- **THEN** the returned window starts on a genuine user-input turn and contains no orphan tool result

#### Scenario: An oversized turn is returned whole

- **GIVEN** a single turn whose tokens exceed the entire budget
- **WHEN** `loadRecent` is called
- **THEN** that turn is returned in full rather than truncated

### Requirement: Stored AI SDK messages convert to CortexMessage

A converter SHALL map stored AI SDK model-message envelopes to `CortexMessage` parts for the wire. Text content SHALL become text parts and tool calls SHALL become tool-call parts. Provider metadata or reasoning blocks the UI does not render SHALL be omitted from the display value without mutating the stored row.

#### Scenario: A tool-using turn converts to CortexMessage

- **GIVEN** a stored assistant AI SDK message containing text and a tool call
- **WHEN** the converter runs
- **THEN** it yields a `CortexMessage` with a text part and a tool-call part

#### Scenario: Provider metadata is dropped from display without mutating storage

- **GIVEN** a stored message containing provider metadata not rendered by the UI
- **WHEN** the converter runs
- **THEN** the metadata is omitted from the `CortexMessage` and the stored row is unchanged
