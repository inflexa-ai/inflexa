## 1. Ledger storage

- [x] 1.1 Add migration version 3 to `src/db/primary_migrations.ts` creating the `llm_usage` table: `record_key TEXT PRIMARY KEY`, `recorded_at INTEGER NOT NULL`, the attribution columns (`agent_id`, `call_path`, `scope_kind`, `scope_id` NOT NULL; `thread_id`, `run_id`, `step_id`, `requested_model_id`, `served_model_id` nullable), and the five nullable token columns — no NOT NULL and no DEFAULT on any token column, and no foreign key on any column
- [x] 1.2 Add the one index this change's reads need — `(scope_kind, scope_id)`, which every surface filters on first and under which the model and agent breakdowns are grouped. Add no `run_id` or `served_model_id` index: nothing here queries by either without a scope, and an index whose only justification is a query no surface makes is cost without a reader
- [x] 1.3 Extend the migration test's pinned version list to `[1, 2, 3]` and assert the new table's token columns are nullable with no default
- [x] 1.4 Add `upsertLlmUsage` to `src/db/primary_mutation.ts` — `INSERT … ON CONFLICT(record_key) DO UPDATE` refreshing the token and model columns while leaving `recorded_at` untouched, returning `Result<void, DbError>` through `tryMutation`
- [x] 1.5 Add the read functions to `src/db/primary_query.ts`: the analysis total, the per-served-model breakdown, and the per-agent breakdown, each via `tryQuery` and each using `SUM()` so an all-absent group reads back as absent rather than zero
- [x] 1.6 Test the storage layer: upsert idempotency under a repeated key, `recorded_at` immutability across re-delivery, NULL preservation for unreported quantities, and a row whose `scope_id` matches no analysis
- [x] 1.7 Test that deleting an analysis leaves its usage rows intact and that they contribute to no other analysis's report — the retention position is a decision, so it gets a test rather than an absence of one

## 2. The recorder realization

- [x] 2.1 Add `src/modules/harness/usage_recorder.ts` mapping `LlmUsageRecord` to the row shape — scope destructured to `(scope_kind, scope_id)` plus `thread_id` over both `Scope` variants, `callPath` joined, every optional field omitted rather than defaulted
- [x] 2.2 Make `record` total and silent: consume the `Result`, log a failure through the structured logger at `warn`, and let nothing throw or return a promise
- [x] 2.3 Test the realization against a recorder whose write always fails, asserting `record` throws nothing and the failure is logged; test that both `Scope` variants map without loss

## 3. Seam wiring

- [x] 3.1 Construct the recorder once in `bootHarnessRuntime` and pass it into `assembleCoreRuntime` at the composition root in `src/modules/harness/runtime.ts`
- [x] 3.2 Verify the recorder reaches every loop — extend `runtime.test.ts` to assert the assembled deps carry it, covering the conversation, workflow, and data-profile bags
- [x] 3.3 Confirm end to end that a real turn writes rows: an integration-level test driving one turn against a stub provider that reports usage, asserting the ledger contains one row per call with the expected attribution

## 4. Turn usage on the shared engine

- [x] 4.1 Widen `RunPhase` in `src/modules/harness/turn.ts` to carry the finish's `turnUsage` on all three `runAgent`-reaching branches, including the aborted and failed ones
- [x] 4.2 Add the optional turn-usage field to `TurnOutcome` and populate it on the `ok`, `aborted`, and `failed` returns
- [x] 4.3 Test the engine: a turn whose provider reports usage carries the total; an aborted turn carries what was spent before the abort; a turn reporting nothing carries no total

## 5. Turn display

- [x] 5.1 Carry the turn total into the conversation store's finished assistant message in `src/tui/hooks/conversation.ts`, beside the existing duration stamp
- [x] 5.2 Render the input and output figures on the message meta line as two figures, rendering nothing when the rollup is absent
- [x] 5.3 Test three cases at the store and render level: a reported rollup appears next to the duration, an absent rollup leaves the line unchanged, and a rollup carrying cache or reasoning counts does not fold them into either figure

## 6. Sidebar USAGE section

- [x] 6.1 Add the USAGE section to `src/tui/layout/sidebar.tsx` reading the analysis total synchronously in a memo, on the local-read pattern the ANALYSIS section already uses
- [x] 6.2 Drive its reactivity from the existing `messageCount` prop and the existing bus subscription, extending the latter to observe `run.observed` — no new poll and no new seam
- [x] 6.3 Render the three states distinctly: the input and output figures, a muted absence when no rows exist, and an unavailable state on a read failure — dropping a figure rather than combining them if the 40-column rail cannot fit both
- [x] 6.4 Replace the comment recording that no accounting source exists, and correct the stale section count in the file's header comment
- [x] 6.5 Update `sidebar.render.test.tsx`, including the section-slicing helpers that assume the current section order, and add coverage for the three states

## 7. The usage command

- [x] 7.1 Add `src/modules/usage/usage.ts` exporting `runUsage`, resolving the analysis from the context or the `--analysis` option, and reporting per-quantity figures plus the per-model and per-agent breakdowns — never a single summed token count
- [x] 7.2 Report an analysis with no recorded usage as such, rather than as zeroed figures or an empty table
- [x] 7.3 Confirm the command's agent-policy classification with the user before registering it — the house rule is to ask, never guess, and design Decision 8 proposes `{ kind: "auto", safeFlags: ["analysis"] }` as a reviewable default rather than a settled answer
- [x] 7.4 Register the command in `src/cli/index.ts` through `registerAction` with the confirmed policy, a description (the docs generator fails without one), and a lazy import
- [x] 7.5 Update the pinned agent-policy snapshots for both the dev-off and dev-on trees
- [x] 7.6 Add an end-to-end test asserting the command reports an analysis's consumption with no harness runtime booted, and writes nothing

## 8. Verification

- [x] 8.1 Run `bun run lint`, `tsc --noEmit`, and the full test suite; regenerate the CLI reference docs
- [ ] 8.2 Drive a real turn in the TUI against the linked local harness and confirm the ledger row count, the turn's displayed total, the sidebar total, and the command's report all agree
