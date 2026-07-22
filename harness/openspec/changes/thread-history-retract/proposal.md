## Why

A host that cancels a turn before the model produced anything has no way to take the persisted user turn back: the chat-turn contract appends `[userMessage]` even on an aborted run, and `ThreadHistory` is append-only (`appendTurn` / `loadRecent` / `loadPage`), so a retract-and-edit UX (inflexa#198) leaves an orphan user turn in the thread that the edited resend would duplicate.

## What Changes

- `ThreadHistory` gains one method: `retractLastTurn(threadId)` — remove the thread's most recent turn (every row from the last genuine-user-start `seq` onward) in a single transaction, serialized against concurrent appends by the same per-thread advisory lock `appendTurn` takes.
- Absence is a normal outcome, not an error: retracting an empty thread reports "nothing to retract" as a data variant, and a thread whose rows lack any user-start (anomalous data) is refused with a distinct outcome rather than emptied; the error channel stays `ResultAsync<_, DbError>` and carries only database faults.
- The outcome reports what was removed (the retracted turn's message count), so a caller can assert it took back what it expected.
- Scope limit, by design: **tail turn only** — no mid-history deletion and no arbitrary truncate-from-seq. Retracting the tail restores the exact pre-append row set, so a subsequent `loadRecent` returns byte-identical output to before the append and the prompt-cache prefix discipline is untouched; mid-history deletion would shift the window head and is out of scope.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `harness-thread-history`: the store's operation set grows from append-only to append-plus-tail-retract — a new requirement covers atomic tail-turn removal, its serialization against appends, and the empty-thread outcome; the existing "conversation-turn operations only" enumeration extends to include the retract (it remains a turn-shaped operation, not a generic row delete).

## Impact

- `harness/src/memory/thread-history.ts` — interface + the Postgres factory (`createThreadHistory`); new method alongside `appendTurn`/`loadRecent`/`loadPage`.
- `harness/src/memory/thread-history.test.ts` — coverage for retract-after-append round-trip, empty-thread outcome, multi-row-turn removal, and append/retract serialization.
- No schema change: operates on the existing `messages` table (`thread_id`, `seq`, `message_envelope`, `tokens`).
- Consumer: the companion CLI change (interrupt + retract-and-edit, inflexa#198) calls this after an aborted no-output turn. Until a harness release ships, the CLI consumes it via the local-link workflow.
