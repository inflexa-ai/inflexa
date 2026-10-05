## Context

`sweepExpired` (src/tools/approval/queries.ts) updates every `pending` row in
`cortex_asks` to `expired` with no age predicate. Hosts call
`askGateway.sweepExpired()` on every pod boot, so any boot — including each pod
of a rolling deployment — expires every live pending approval fleet-wide. The
ledger has no `expires_at`/deadline column; `created_at` is fixed-width UTC ISO
text written by the gateway. `src/state/init.ts` (DDL) is owned by a concurrent
change and must not be edited here.

## Goals / Non-Goals

- Goal: a boot sweep cannot expire an ask a live pod is still polling.
- Goal: smallest change; no DDL, no new config surface beyond one optional arg.
- Non-goal: per-ask deadlines (`expires_at` column) or TTL enforcement while a
  turn is live — the poll loop's `ctx.signal` already bounds a live ask's life.

## Decisions

- **Age predicate on `created_at`** over a new deadline column: the column is
  the only lifetime signal available without touching init.ts. Text comparison
  (`created_at < $2`) is sound because every write is `Date.toISOString()` —
  fixed-width UTC, lexicographic = chronological — the same property
  `selectPending`'s `ORDER BY created_at` already relies on. A `::timestamptz`
  cast was rejected: it adds failure modes on nothing and diverges from the
  existing ordering convention.
- **`sweepExpired(maxAgeMs?: number)` with a 24 h default** over a construction
  dep or env config: callers keep compiling unchanged, the default is far beyond
  any plausible live turn (turn aborts mark rows `aborted` long before), and a
  host wanting a tighter policy passes a number. Exported as
  `DEFAULT_SWEEP_MAX_AGE_MS`.
- **Cutoff computed at the gateway**, queries stay dumb: the query takes
  `expiredAt` + `olderThan` strings; time arithmetic lives in one place.

## Risks / Trade-offs

- [A genuinely orphaned ask lingers `pending` up to 24 h before the next boot
  sweeps it] → acceptable: `pending()` still surfaces it, `answer` still works
  against it, and nothing awaits it; the ledger records the loss on the next
  sweep.
- [A live human decision outlasting 24 h is swept] → the turn's own lifetime
  (abort/timeout) ends far earlier in practice; the poll loop then observes
  `expired` and denies safely via `AskRejectedError`.

## Migration Plan

Behavior-tightening only; zero-arg callers are source-compatible. No data
migration. Rollback is reverting the predicate.

## Open Questions

- A future `expires_at` column (per-ask deadline at insert) would make expiry
  exact rather than heuristic — deferred as a DDL ask on the init.ts owner.
