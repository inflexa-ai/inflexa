# Design

## Context

- `readTurns` (`src/memory/thread-history.ts:603-676`) sends one statement with no bound on `seq`, and no `LIMIT`. It parses each row, then it groups the rows with `groupTurns` (`src/memory/conversation-view.ts:44-54`). `loadAll` (`:678-680`) wraps it.
- The JSDoc of `loadAll` (`:235-249`) says that the read has no paginated form. The comment above `readTurns` (`:597-602`) stops in the middle of a sentence.
- `messages` has the primary key `(thread_id, seq)`, and `cortex_thread_turns` has the primary key `(thread_id, start_seq)` (`src/state/migrations/20260927120000_baseline.ts:284-322`). A btree scan of the first key, in the two directions, serves a read of the rows of one thread in a `seq` range.
- `GENUINE_USER_START_SQL` (`:314-315`) is the SQL twin of `isGenuineUserStart`. `retractLastTurn` and `countUserTurnsAfter` cut on it.
- `seq` is a `bigint`. Each read in the module sends it as text, and it makes the crossing with `Number` in one place (`latestSeq`, `:735-747`).
- `healTailOrphan` (`cli/src/modules/harness/turn.ts:279-287`) reads the tail turn with `loadAll`. It is the only host caller of `loadAll` other than the transcript route.

## Goals / Non-Goals

**Goals:**

- One read whose work grows with the rows of its page, not with the rows of the thread.
- The page and the whole read give the same row for one stored row.

**Non-Goals:**

- No change of `loadAll` and of its callers.
- No new index and no migration.
- No count of the turns of the thread. A count reads each row of the thread.
- No host cap of the limit. The host chooses its default and its maximum.

## Decisions

### D1. A new method `loadPage` beside `loadAll`

Add to `ThreadHistory`:

```ts
interface LoadPageOptions {
    /** The cursor that the previous page gave. Absent for the newest page. */
    readonly before?: number;
    /** The maximum count of turns in the page. */
    readonly limit: number;
}

interface TurnPage {
    /** The whole turns of the page, oldest-first. */
    readonly turns: StoredMessage[][];
    /** The cursor of the next older page, or `null` when the page holds the oldest row of the thread. */
    readonly before: number | null;
}

loadPage(threadId: string, options: LoadPageOptions): ResultAsync<TurnPage, DbError>;
```

The package root exports `LoadPageOptions` and `TurnPage` beside `StoredMessage`.

Alternative: an optional window on `loadAll`. `loadAll` gives no cursor, and its callers want the whole thread. A second shape for one method makes each caller read the options to know what it gets.

Alternative: a read in the host. The host then repeats the SQL of the turn boundary, and the harness owns that predicate.

### D2. The cursor is the opening `seq` of the oldest turn of the page

The next page reads the rows whose `seq` is below the cursor. The cursor is a `number`, the same as `latestSeq` and `countUserTurnsAfter`. The host encodes it for its wire. A `seq` never moves, and a retract removes only the tail. Thus a cursor that a client holds stays correct across a later append and a later retract.

### D3. One statement for each page

The read is one statement, thus one snapshot. A concurrent append or retract cannot add a turn between the boundary read and the row read. The statement has these parts:

1. `starts`: a recursive walk down from the cursor, one row for each step. Each step is a `LIMIT 1` read of the primary key that evaluates `GENUINE_USER_START_SQL` in the select list, not in a `WHERE`. The walk counts the starts and stops at the `limit`-th. The walk reads only the rows of the page.
2. `lower`: when `starts` holds `limit` rows, the smallest of them. Otherwise no lower bound, because the page reaches the start of the thread and holds the rows before the first turn start.
3. `upper`: the first `seq` at or above the cursor that matches `GENUINE_USER_START_SQL`, found by a walk up with `LIMIT 1` reads. Without a cursor, or with no such row, there is no upper bound. For a cursor that a page gave, `upper` is the cursor itself, and the scan evaluates the predicate on one row. For a cursor inside a turn, the scan walks forward to the end of that turn. Thus the newest turn of the page is whole for each cursor.
4. The rows: the select of `readTurns`, with `seq >= lower` and `seq < upper`, in ascending order.
5. The next cursor: `lower` when a row of the thread has a `seq` below `lower`, else `null`. An `EXISTS` on the primary key answers it, and it reads no envelope.

An absent bound is not a SQL `NULL` in a comparison, because `seq >= NULL` matches no row. Express an absent `lower` with a `COALESCE` to a value below the first `seq`. Express an absent `upper` with the largest `bigint`, or omit its predicate.

Each bound on `seq` must be an index condition. A form such as `($2 IS NULL OR seq < $2)` is a filter, and the scan then visits each newer row. Each `seq` parameter is cast to `bigint`, the same as `retractLastTurn`.

Alternative for step 1: `WHERE <predicate> ORDER BY seq DESC LIMIT n`. The planner has no statistics for a JSON path and estimates that few rows match, so it chooses a bitmap scan and a sort of each row of the thread, and it evaluates the predicate on each envelope. A measurement of a thread of 500 turns with 20 KB tool results gave a median of 36 ms, against 6.5 ms for a thread of 20 turns. The walk removes the dependence on the estimate.

Alternative for a cursor that is not a turn start: refuse it. A retract can remove the turn of a cursor that a page gave, and the rows below that cursor stay correct. A refusal then fails a correct request, and the cli rule is to degrade and not to fail.

Alternative: separate statements for the boundary and for the rows. They read two snapshots, thus an append between them can add a turn past the limit.

Alternative: read `limit + 1` starts, and drop the `EXISTS`. The scan then walks each row of one more turn, and a turn can hold many tool rows.

### D4. A limit below 1 reads one turn

A limit of 0 gives no start. The bound then reads as "the page reaches the start of the thread", and the read gives the whole thread. Thus the store reads a limit that is not finite as 1. It reads each other limit as its integer part, with a minimum of 1. The host validates its own query value before the call.

### D5. One row mapping for the two reads

Move the mapping from a result row to a `StoredMessage` out of `readTurns` into a function that the two reads call. Thus the two reads cannot give a different row for one stored row. Correct the JSDoc of `loadAll` and the comment above `readTurns`, because the two state that no paged read exists.

## Risks / Trade-offs

- Risk: the page read evaluates `GENUINE_USER_START_SQL` on each row of its range. `message_envelope` is `json`. Thus each evaluation parses the text of the row. Mitigation: the range holds only the rows of the page, and the read parses them in TypeScript too. The cost stays proportional to the page.
- Risk: the rows before the first turn start can make a page of one group. Mitigation: none is necessary. This occurs only on the oldest page, and the page is correct.

## Migration Plan

None. The read is new, and it uses the existing primary keys.
