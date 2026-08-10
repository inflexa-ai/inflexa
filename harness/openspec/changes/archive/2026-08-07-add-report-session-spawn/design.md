## Context

The thread store already accepts the whole child shape: the type, the parent id, and the anchor (`src/memory/thread-store.ts:104-122`). It enforces the paired anchor, the same-analysis parent, and the closed type set. The listing narrows by `type` and by `parentThreadId` (`src/memory/thread-store.ts:578-585`). The resolver refuses the type `report` until an agent registers (`src/runtime/assemble.ts:136-147`).

What is absent is the composition: nothing reads the anchor, nothing mints the child id, and nothing makes a `report` thread. The append path computes the latest seq privately (`src/memory/thread-history.ts:362-365`), and no public read exists.

## Goals / Non-Goals

**Goals:**

- One spawn operation that makes the report child thread with its anchor and its title.
- Typed refusals for the absent parent, the archived parent, and the empty transcript.
- A public `latestSeq` read on the thread history.
- The children listing for one analysis.
- The session-version policy as a requirement in the `report-versions` spec.

**Non-Goals:**

- The tool that lets the conversation agent call the spawn (#314).
- The agent that runs in the session (#225), and the context transfer (#223).
- The CLI navigation (#312).
- A behavior change in the version store. The policy binds the caller, and the store stays as #308 shipped it.

## Decisions

### D1. The spawn is a composition, and it owns no table.

The operation lives in `src/app/spawn-report-session.ts`, beside the chat-turn preparation. It composes four existing reads and writes: `getThread` for the parent, `latestSeq` for the anchor, `listThreads` for the count of report children, and `createThread` for the insert. The one new piece of storage code is the `latestSeq` read, and it lives in `thread-history.ts`, because that module owns the `messages` table.

### D2. The refusals are typed data on the err channel.

The spawn returns `ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError>`. `SpawnRefusal` is a closed set: `parent_not_found` for an absent or archived parent, `parent_not_a_conversation` for a parent whose type is not `conversation`, and `empty_parent_transcript` for a parent with no messages.

The parent-type rule keeps the tree flat: a report session cannot spawn another report session. Each variant carries the identifiers, in the pattern of `ThreadInputError` (`src/memory/thread-store.ts:135-156`). The store refusals pass through unchanged.

An archived parent refuses because `getThread` filters `deleted_at IS NULL` (`src/memory/thread-store.ts:442`). A spawn from an archived conversation is a hidden-state write, and the host unarchives first when the user wants it.

### D3. No lock and no transaction across the anchor read and the insert.

Between the read and the insert, a concurrent turn can append, and a retract can cut the tail. A transaction cannot stop the conversation from moving one turn later, thus a lock buys no real guarantee. The store already tells a reader to treat an anchor past the parent's end as a normal state (`src/memory/thread-store.ts:87-91`). The anchor records the spawn point, and skew is the documented semantics.

### D4. The title composes at the spawn, and a race is cosmetic.

N is the total of the existing report children plus one, from `listThreads` narrowed by `parentThreadId` and `type`. Two concurrent spawns can compose the same N. The result is two threads with one title, which a user renames, and no identifier collides. A unique title is not a goal, thus no lock guards the count.

The parent title is present in practice: the first turn seeds it (`src/app/chat-turn.ts:66-81`), and the spawn refuses an empty transcript, thus a legal spawn follows a first turn. The seed is best-effort (`src/app/chat-turn.ts:85`), thus the `Report N` fallback stays as one line.

### D5. The spawn mints the child id.

The thread id of a conversation comes from the host UI (`src/memory/thread-store.ts:6-7`). The spawn is a harness operation with no UI in front of it, thus it mints a `randomUUID` and returns the full `Thread` row. A managed deployment gets the same behavior with no CLI.

### D6. The children listing is a named question, not new SQL.

`listReportSessions(analysisId)` wraps `listThreads({ analysisId, type: "report" })`. The wrapper exists because #309 names the question, and a named operation is what #312 and #225 bind to. It adds no predicate of its own.

Issue #309 words the question as "which report versions belong to this analysis". Under the one-session-one-version policy, each report session holds at most one version. Thus the sessions listing answers the versions question, and no version-store read by analysis is necessary.

### D7. The session-version policy is a caller requirement, and the store stays permissive.

The `report-versions` delta adds one requirement. A caller records at most one version for each report thread, and the record lands at the acceptance. A correction is a new session, and its version names the earlier one through `parentVersionId`. The store keeps its ordinal generality, per the posted policy on #221. An enforcement inside the store would change shipped #308 behavior, and that is out of scope here.

## Risks / Trade-offs

- [Two spawns race and compose one title] → cosmetic, per D4. No identifier collides.
- [The anchor lags a concurrent append] → the documented semantics, per D3. The reader treats it as normal.
- [A future caller records many versions in one thread] → the added `report-versions` requirement binds the caller. The #310 gate and the #225 loop obey it.
- [`latestSeq` duplicates the append computation] → the read shares the table, not the statement. The append needs its lock, and the read must not take one.

## Migration Plan

The work is additive and dormant. No roster changes, and `src/index.ts` exports none of it. A revert is one commit.

## Open Questions

- None.
