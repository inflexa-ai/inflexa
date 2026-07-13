# harness-thread-history Specification (delta)

## ADDED Requirements

### Requirement: Standing briefings persist at thread start and are pinned above the window

`ThreadHistory` SHALL provide an idempotent briefing append that writes a thread's standing briefings in one transaction with `seq` values preceding every turn; if the thread already has briefing rows, the append SHALL be a no-op (first writer wins under concurrent first turns). `loadRecent` SHALL always return the thread's briefing rows first, in ascending `seq`, exempt from the token budget, followed by the windowed turns.

#### Scenario: Briefings survive window eviction

- **GIVEN** a thread whose turn tokens exceed the budget many times over
- **WHEN** `loadRecent` is called
- **THEN** every briefing row is returned ahead of the windowed turns, and only turns are evicted

#### Scenario: Concurrent first turns append one briefing set

- **GIVEN** two requests racing to prepare a new thread's first turn
- **WHEN** both attempt the briefing append
- **THEN** exactly one set of briefing rows exists, in the first writer's order

## MODIFIED Requirements

### Requirement: loadRecent windows by token budget

`loadRecent(threadId, tokenBudget)` SHALL return the most recent messages whose cumulative `tokens` fit the budget, walking newest-first. It SHALL NOT window by message count. The token budget SHALL apply to conversation turns only: pinned briefing rows are returned in addition to the windowed turns and never count against or consume the budget.

#### Scenario: Only recent turns within budget are returned

- **GIVEN** a thread whose total tokens exceed the budget
- **WHEN** `loadRecent` is called
- **THEN** it returns only the most recent turns whose cumulative tokens fit the budget

#### Scenario: Briefing tokens do not shrink the turn window

- **GIVEN** two threads with identical turns, one with briefing rows and one without
- **WHEN** `loadRecent` is called with the same budget on both
- **THEN** both return the same turn window

### Requirement: loadRecent returns a valid AI SDK model-message sequence

The windowed-turn portion returned by `loadRecent` SHALL always begin on a genuine user-input turn and SHALL never split an AI SDK tool-call/tool-result continuation. A briefing row SHALL NOT count as a turn start even though its inner message has role `user`: turn-boundary detection SHALL consult the envelope kind, and window snapping SHALL never anchor the window on, evict part of, or split the briefing prefix. The turn is the atomic unit; a turn is never half-loaded. If the most recent complete turn alone exceeds the budget, it SHALL be returned in full. Messages SHALL be ordered by ascending numeric `seq` — the read MUST order on the `bigint` `seq` column, never on a textual projection of it (a lexicographic sort places `"10"` before `"2"`, reordering a thread past ten messages and splitting tool-call/tool-result pairs across an intervening turn).

#### Scenario: The window is snapped past an orphan tool result

- **GIVEN** a token cut that would start the window on a tool-result continuation
- **WHEN** `loadRecent` snaps the boundary
- **THEN** the returned window starts on a genuine user-input turn and contains no orphan tool result

#### Scenario: A briefing row is not a turn start

- **GIVEN** a thread whose rows are briefings followed by turns, with a token cut landing at the briefing/turn seam
- **WHEN** `loadRecent` snaps the boundary
- **THEN** the windowed portion starts on a genuine user-input turn — never on a briefing row — and the briefing prefix is returned intact ahead of it

#### Scenario: A thread past ten messages keeps numeric order

- **GIVEN** a thread with more than ten messages whose tool-call and tool-result straddle the `seq` 9→10 boundary
- **WHEN** `loadRecent` returns the window
- **THEN** the messages are in ascending numeric `seq` order and every tool-call is immediately followed by its matching tool-result, with no user message between them

#### Scenario: An oversized turn is returned whole

- **GIVEN** a single turn whose tokens exceed the entire budget
- **WHEN** `loadRecent` is called
- **THEN** that turn is returned in full rather than truncated

### Requirement: Thread history is conversation-scoped

The `messages` table and `ThreadHistory` SHALL serve conversation threads only. Workflow and sandbox agent loops SHALL NOT write to it; their message durability is the DBOS step cache and is not migrated by the AI SDK thread-history backfill.

#### Scenario: The interface offers no generic message insert

- **GIVEN** the `ThreadHistory` interface
- **WHEN** a caller inspects it
- **THEN** it exposes only conversation-scoped operations (`appendTurn`, `loadRecent`, `loadPage`, the idempotent briefing append), not a generic row insert
