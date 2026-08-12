# Design

## Context

`cortex_analysis_state.billing_context` dates from the eager billing model, where the seed wrote attribution headers and `resolveAnalysisBilling` read them back per request. Managed Cortex now resolves attribution lazily at charge-open time (Nexus `resolve-headers`), the OSS path never billed, and the reader lost its last caller. What remains is write-only state that a re-upsert clobbers unconditionally.

## Goals / Non-Goals

- Goal: remove the column, its writer parameter, and its dead reader in one cut.
- Goal: existing databases converge on the new shape at startup with no operator action.
- Non-goal: any change to target-assessment billing — `cortex_target_assessments.billing_context_id` is an id the session scope keys on, not a persisted header map.
- Non-goal: replacing the reader; charge-time resolution is the embedder's, outside the state layer.

## Decisions

- **Drop the column, don't deprecate it.** A nullable column with no reader invites a future caller to trust a value every writer nulls or clobbers. `DROP COLUMN IF EXISTS` in the existing `dropMigrations` array follows the `user_id`/`profile`/`input_files` precedent exactly, and runs before `addMigrations` — so removing the old `ADD COLUMN IF NOT EXISTS billing_context` line means the column never comes back.
- **Migration lives in the JS array, not the DDL string.** The DDL template is split naively on `';'`; the drop-migration arrays are per-statement `client.query` calls with no such constraint. Matching the existing structure keeps the split hazard untouched.
- **Positional removal over deprecation of the parameter.** `upsertAnalysis` is pre-1.0 and both known callers pass literal `null`. Keeping an ignored parameter would preserve source compatibility at the cost of a lying signature.

## Risks / Trade-offs

- [Embedder passing the old 4th argument] → compile error against the new types; both known call sites (managed Cortex seed route, CLI ledger seed) pass `null` today, so the fix is deletion.
- [Rows carrying real billing JSON in some old database] → dropped without backfill. Nothing has read the column since the lazy resolver landed; per-call attribution lives in usage rows.

## Migration Plan

Ships in the harness package; embedders pick it up on upgrade. Startup DDL drops the column idempotently. Rollback is the previous package version — its `ADD COLUMN IF NOT EXISTS` recreates the column (empty), which the old code tolerates because the seed always wrote null anyway.

## Open Questions

None.
