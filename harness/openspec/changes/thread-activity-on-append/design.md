## Context

`cortex_analysis_threads.updated_at` is bumped only by `ThreadStore.updateTitle`; `appendTurn` (`memory/thread-history.ts`) writes the turn's `messages` rows and never touches the thread row. `listThreads` orders by `updated_at DESC`, so its ordering currently tracks creation/rename, not conversation activity. The CLI change `pg-single-home-sessions` (issue #233) makes `listThreads` the source of "resume the most-recent session", which needs activity ordering to be correct.

## Goals / Non-Goals

**Goals:**

- `updated_at` means "last activity": bumped by turn appends and title updates.
- The touch is atomic with the turn it reflects — no window where messages exist but the thread reads stale.

**Non-Goals:**

- No new `ThreadStore` method, no schema change, no change to `retractLastTurn` (a retract is an undo, not new activity — the slightly-stale `updated_at` it leaves is harmless and not worth a second write).
- Archive/hard-delete lifecycle and the multi-session columns (issues #234/#235).

## Decisions

**1. The touch lives inside `appendTurn`'s transaction, not in a host-called `touchThread`.**
Every host appends turns through `createThreadHistory(pool).appendTurn`; doing the touch there gives all hosts activity ordering with zero wiring, and the same-transaction guarantee is free. Alternative — a `ThreadStore.touchThread` the host calls after a turn — rejected: it makes correct ordering opt-in per host and can race the append it describes. Cross-module table write (thread-history writing the thread-store-owned row) is accepted and documented in both specs; the alternative of moving `appendTurn` into the thread store would merge two deliberately separate capabilities.

**2. Zero-row touch is a no-op, not an error.**
`appendTurn` on a thread with no metadata row (possible for anomalous/legacy data; the normal path creates the row in `prepareChatTurn` first) updates zero rows and proceeds. Failing the append over missing metadata would turn a breadcrumb update into a data-loss path.

## Risks / Trade-offs

- [One extra `UPDATE` per turn] → negligible: one indexed-PK row touch per turn append, in an already-open transaction.
- [`updateTitle`'s "changes only the title (and bumps `updated_at`)" wording now has a sibling writer] → both specs cross-reference; the store's invariant ("no other *field* changes") is untouched.
