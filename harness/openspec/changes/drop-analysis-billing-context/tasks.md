# Tasks

## 1. State layer

- [x] 1.1 Remove the `billingContext` parameter from `upsertAnalysis` and drop `billing_context` from its INSERT/UPDATE SQL; restate the docstring (the split-attribution paragraph described billing rotation and goes with it).
- [x] 1.2 Delete `resolveAnalysisBilling` and its `src/state/index.ts` barrel export.
- [x] 1.3 Remove `billing_context JSONB` from the `cortex_analysis_state` CREATE TABLE and the `ADD COLUMN IF NOT EXISTS billing_context` additive migration; append `ALTER TABLE cortex_analysis_state DROP COLUMN IF EXISTS billing_context` to the `dropMigrations` array beside the other `cortex_analysis_state` drops.

## 2. Call sites

- [x] 2.1 Update harness test call sites to the 4-arg signature (state, runtime, app, report-session, and DBOS budget-cascade suites).
- [x] 2.2 Update CLI call sites: `seedProfileLedger` (`cli/src/modules/harness/profile_trigger.ts`) and the `inflexa run` ledger seed (`cli/src/modules/harness/dev/run.ts`); fix the `billingContext` mention in the seed comment.

## 3. Spec

- [x] 3.1 Modify the `cortex_analysis_state table schema` requirement: column gone, upsert scenarios lose the billing argument, startup-drop scenario added.
- [ ] 3.2 On archive, update the capability's Purpose paragraph, which still lists "billing identity" among the table's contents.

## 4. Verification

- [x] 4.1 `npx tsc --noEmit` clean in the harness; CLI tsc errors confined to the stale published 0.19 types (resolve on next publish).
- [x] 4.2 `bun test` green on the touched suites: plans, report-session-state, report-versions, record-version, reconcile-orphaned-data-profile, assemble, report-session-runtime, budget-cascade.
