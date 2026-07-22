## Context

`ThreadHistory` (`src/memory/thread-history.ts`) is the harness-owned conversation message store over the `messages` table (`thread_id`, `seq`, `message_envelope`, `tokens`; PK `(thread_id, seq)`). It exposes exactly `appendTurn` / `loadRecent` / `loadPage`. The chat-turn contract persists a turn unconditionally — on an aborted run it appends `[userMessage]` alone — so a host that lets the user retract a just-sent message (inflexa#198: interrupt + retract-and-edit before the model produced output) is left with an orphan user turn it cannot remove.

Two store invariants constrain any deletion:

- **Turn grouping is read-side**: a turn starts on a genuine user-role message (`isGenuineUserStart`); the first row of a thread opens a turn regardless of role (`groupTurns`). There is no turn table — "the last turn" is derivable only from row roles.
- **Prompt-cache prefix stability**: `loadRecent` snaps eviction to `EVICTION_BLOCK_TURNS` blocks so the window head stays byte-stable across appends. Any deletion that can move the window head re-introduces the cache-rewrite cost that discipline exists to avoid.

## Goals / Non-Goals

**Goals:**

- Let a caller atomically remove the thread's most recent turn, restoring the exact pre-append row set.
- Keep the operation turn-shaped and conversation-scoped — consistent with the store's existing vocabulary, usable by any embedder, not shaped around one host's UI.
- Absence handled as data (`neverthrow` ok-variant), `DbError` reserved for database faults.

**Non-Goals:**

- Mid-history deletion, truncate-from-arbitrary-seq, or per-message deletion — these can move the `loadRecent` window head and require message addressing the interface deliberately does not expose.
- Any change to `appendTurn`'s signature or persistence timing (the CLI-side decision of *when* to retract lives in the companion CLI change).
- Undo/redo of answered turns, snapshots, or revert markers.

## Decisions

### D1: One method, tail-only — `retractLastTurn(threadId)`

`retractLastTurn(threadId: string): ResultAsync<RetractOutcome, DbError>` with `RetractOutcome = { kind: "retracted"; messages: number } | { kind: "empty-thread" } | { kind: "no-user-turn" }`.

- *Why tail-only*: retracting the tail restores the exact row set that existed before the matching `appendTurn`, so the next `loadRecent` output is byte-identical to the pre-append call — the cache-prefix discipline is untouched by construction, not by analysis. Mid-history deletion has no such property.
- *Alternative — truncate-from-seq*: rejected. `appendTurn` returns `void`; no caller holds a seq handle, so a seq parameter would force `appendTurn` to return handles (a breaking change rippling to every call site) to serve a capability with one consumer.
- *Alternative — guard parameters* (e.g. `expectedMessageCount`): rejected as speculative. The store's threads are single-writer per conversation (the host's busy gate serializes turns); the outcome's `messages` count lets a caller assert after the fact. If a multi-writer host ever appears, a compare-and-retract can be added without breaking this shape.

### D2: Turn boundary located in SQL by stored role, mirroring the read side

The tail turn's first row is the greatest `seq` whose envelope carries a user-role message (`message_envelope->'message'->>'role' = 'user'`); the delete removes `seq >=` that boundary. When rows exist but none is user-role, the store refuses: it deletes nothing and reports the `no-user-turn` outcome. That shape cannot arise from `appendTurn`-written turns, so it signals anomalous data — and a data anomaly must never trigger a full-thread deletion; the caller decides what a corrupt thread deserves. The envelope path is fixed by the ai-sdk-message-storage spec (`{kind, aiSdkMajor, message}`), so the SQL addresses a stable shape.

### D3: Same serialization as append — advisory lock in a transaction

The delete runs inside `withTransaction` and first takes `pg_advisory_xact_lock(hashtext(threadId))` — the identical lock `appendTurn` takes. A retract therefore never observes (or half-removes) a turn an in-flight append is still writing: it runs strictly before or strictly after, and removes a whole turn either way.

### D4: No metrics, no schema change, no new index

Retract is a rare user-triggered correction, not a per-turn hot path; `loadRecent`'s histograms already capture thread size. The boundary subquery scans one thread via the existing `(thread_id, seq)` PK, matching the whole-thread reads the store already performs.

## Risks / Trade-offs

- [Retract races a subsequent append and removes the *new* tail] → Contract states the single-writer-per-thread assumption; the `{ messages }` count in the outcome gives callers a post-hoc assertion. The companion CLI change's busy gate makes the race unrepresentable in the known consumer.
- [Envelope shape drift breaks the role predicate silently] → The shape is pinned by the ai-sdk-message-storage spec; the retract-after-append round-trip test fails loudly if the predicate stops matching.
- [Interface addition breaks external `ThreadHistory` implementations] → The store is documented as harness-owned (created via `createThreadHistory`, not implemented by embedders); ship as a minor version bump and note the addition in the release notes.

## Migration Plan

Additive: new interface method + factory implementation, no DDL, no data migration. Publish as a minor harness release; the CLI consumes via the local-link workflow (`bun run harness:local`) until the release ships. Rollback is removing the method — no persisted state depends on it.

## Open Questions

None — the companion CLI change owns when to call this (its no-output gate), and deliberately none of that gating leaks into the store contract.
