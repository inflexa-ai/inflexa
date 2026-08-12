# Drop the analysis billing_context column

## Why

Managed Cortex resolves billing attribution lazily at charge-open time via its Nexus `resolve-headers` resolver — decided after the prelaunch audit. The persisted `cortex_analysis_state.billing_context` column is a stale-copy trap left over from the eager model: the host's seed route always writes null, a re-upsert overwrites the stored value unconditionally (`SET billing_context = EXCLUDED.billing_context`, no COALESCE — unlike `seed_input_file_ids`, which is coalesced), and `resolveAnalysisBilling` — the only reader — has zero callers in the harness, the CLI, or managed Cortex. The OSS path leaves it null by construction. A column nobody reads, that every writer nulls or clobbers, is not billing state; it is a place for a future caller to find stale identity.

## What Changes

- **BREAKING** `upsertAnalysis` loses its `billingContext` parameter: `upsertAnalysis(pool, resourceId, context, inputFileIds?)`. The INSERT/UPDATE no longer touches `billing_context`.
- Delete `resolveAnalysisBilling` (zero callers) and its barrel export.
- Remove `billing_context JSONB` from the `cortex_analysis_state` CREATE TABLE and its additive migration; add an idempotent `ALTER TABLE cortex_analysis_state DROP COLUMN IF EXISTS billing_context` alongside the other vestigial-column drops.
- `cortex_target_assessments.billing_context_id` is untouched — TA billing is keyed by id on the session scope, not by a persisted header map, and that model is correct.

## Capabilities

### Modified Capabilities

- `cortex-state-layer`: the `cortex_analysis_state` schema requirement loses the `billing_context` column, and the upsert scenarios lose the billing argument. Billing identity is never persisted in the state layer; it is resolved by the embedder at charge time.

## Impact

- `src/state/analyses.ts` — `upsertAnalysis` signature and SQL; `resolveAnalysisBilling` deleted.
- `src/state/init.ts` — DDL and migrations.
- `src/state/index.ts` — barrel export removed.
- CLI call sites (`seedProfileLedger`, `inflexa run` ledger seed) drop the always-null argument.
- Breaking for embedders that pass the fourth argument; managed Cortex's seed route passes null today and adapts trivially. Pre-1.0, ships in the next minor.
