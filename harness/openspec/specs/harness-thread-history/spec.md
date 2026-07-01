# harness-thread-history Specification

## Purpose
Defines the harness `messages` table — the single source of truth for conversation turns — and the `appendTurn` / `loadRecent` API on top of it. Turns are persisted atomically with a monotonic per-thread `seq`, content is Anthropic-shaped `ContentBlockParam[]` JSONB, and `loadRecent` walks newest-first to a token budget snapping the window to valid turn boundaries (no orphan `tool_result`). Stored content blocks convert to `CortexMessage` parts for the wire.

## Requirements

### Requirement: A turn is appended atomically with monotonic sequence

`appendTurn(threadId, messages)` SHALL write all messages of a turn in one transaction, assigning each a `seq` that is monotonically increasing per thread. Each row SHALL store its `content` as Anthropic-shaped JSONB and a `tokens` count computed at write time.

#### Scenario: A turn round-trips

- **GIVEN** a turn of messages appended to a thread
- **WHEN** the thread is read back
- **THEN** the messages return oldest-first with strictly increasing `seq`

#### Scenario: A thinking signature survives persistence

- **GIVEN** a message containing a `thinking` block with a signature is appended
- **WHEN** it is read back
- **THEN** the `signature` is byte-identical

### Requirement: loadRecent windows by token budget

`loadRecent(threadId, tokenBudget)` SHALL return the most recent messages whose cumulative `tokens` fit the budget, walking newest-first. It SHALL NOT window by message count.

#### Scenario: Only recent turns within budget are returned

- **GIVEN** a thread whose total tokens exceed the budget
- **WHEN** `loadRecent` is called
- **THEN** it returns only the most recent turns whose cumulative tokens fit the budget

### Requirement: loadRecent returns a valid Anthropic message sequence

The window returned by `loadRecent` SHALL always begin on a `user` message that is genuine user input — not a `tool_result` continuation — and SHALL never split a `tool_use`/`tool_result` pair. The turn is the atomic unit; a turn is never half-loaded. If the most recent complete turn alone exceeds the budget, it SHALL be returned in full.

#### Scenario: The window is snapped past an orphan tool_result

- **GIVEN** a token cut that would start the window on a `user` message containing only `tool_result` blocks
- **WHEN** `loadRecent` snaps the boundary
- **THEN** the returned window starts on a genuine user-input message and contains no orphan `tool_result`

#### Scenario: An oversized turn is returned whole

- **GIVEN** a single turn whose tokens exceed the entire budget
- **WHEN** `loadRecent` is called
- **THEN** that turn is returned in full rather than truncated

### Requirement: loadRecent emits a thread-overflow metric

Every `loadRecent` call SHALL emit an OTel metric recording the thread's total token count, whether eviction occurred, and how many turns were evicted.

#### Scenario: Eviction is recorded

- **GIVEN** a thread whose total tokens exceed the budget
- **WHEN** `loadRecent` runs
- **THEN** the emitted metric reports `eviction: true` with a non-zero evicted-turn count

### Requirement: Thread history is conversation-scoped

The `messages` table and `ThreadHistory` SHALL serve conversation threads only. Workflow and sandbox agent loops SHALL NOT write to it; their message durability is the DBOS step cache.

#### Scenario: The interface offers no generic message insert

- **GIVEN** the `ThreadHistory` interface
- **WHEN** a caller inspects it
- **THEN** it exposes only conversation-turn operations (`appendTurn`, `loadRecent`), not a generic row insert

### Requirement: A paginated message read backs the messages endpoint

`ThreadHistory` SHALL provide a thread-scoped, paginated read (`loadPage(threadId, page, perPage)`) of the `messages` table for serving the thread messages endpoint, returning a page of messages (oldest-first) together with `total`, `page`, `perPage`, and `hasMore`. Pagination SHALL be by whole turns — `page`, `perPage`, and `total` count turns, not rows — so a multi-row turn always reloads intact. This read SHALL be distinct from `loadRecent` (which windows by token budget for the LLM) — it serves UI display, not the agent loop, and SHALL NOT apply token-budget eviction.

#### Scenario: A page of messages is returned with totals

- **GIVEN** a thread with more messages than one page holds
- **WHEN** the paginated read is called with a page and perPage
- **THEN** it returns that page oldest-first plus `total` and `hasMore`

#### Scenario: The display read is not token-windowed

- **GIVEN** a thread whose total tokens exceed the loop budget
- **WHEN** the paginated read is called
- **THEN** it returns messages by page boundaries, not by token budget, and evicts nothing

### Requirement: Stored content blocks convert to CortexMessage

A converter SHALL map a stored message's Anthropic `ContentBlockParam[]` (the `content_jsonb` shape) to `CortexMessage` parts for the wire. Text blocks SHALL become text parts and tool-use blocks SHALL become tool-call parts; blocks the UI does not render (e.g. thinking) SHALL be dropped without mutating the stored row. The converter operates on the harness `messages` content shape.

#### Scenario: A tool-using turn converts to CortexMessage

- **GIVEN** a stored assistant message containing text and a tool-use block
- **WHEN** the converter runs
- **THEN** it yields a `CortexMessage` with a text part and a tool-call part

#### Scenario: A thinking block is dropped without mutating storage

- **GIVEN** a stored message containing a thinking block
- **WHEN** the converter runs
- **THEN** the thinking block is omitted from the `CortexMessage` and the stored row is unchanged
