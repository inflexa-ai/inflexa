# Promote Ephemeral Execution to Adhoc Runs

## Why

The ephemeral sandbox was built to fill the gap between workspace read tools and a full plan-then-execute run, but its implementation opts out of the harness's own machinery at every seam: it cannot create files (read-only mount, no write tools, provenance frames discarded), it blocks the chat turn inline and dies on disconnect, and a single 120s absolute deadline — shared with LLM think-time — makes it time out after roughly one command. Users expect an ad-hoc executor that can write and run scripts; the current shape cannot fulfil that role, and every one of its limitations duplicates or bypasses machinery that planned steps already have.

## What Changes

- **BREAKING** Retire the `run_ephemeral` conversation tool. Its replacement `run_adhoc` launches a first-class *adhoc run*: a plan-less, one-step workflow run identified by a null `plan_id`.
- Adhoc runs reuse the existing sandbox-step workflow wholesale: writable step tree at `runs/{runId}/adhoc/`, standard step timeout (3600s), artifact sync, provenance collection, and the `summary.md` convention. The executor's final answer is the step's `summary.md`; adhoc runs have **no synthesis**.
- `run_adhoc` is fire-and-forget like `execute_plan`: it returns `{runId}` immediately, emits a run card, and results are pulled via `inspect_run` on a later turn. The inline `launchAndAwait` path, cancel-on-disconnect, and the boot-time cancellation of `ephemeral:`-prefixed workflows are removed — adhoc runs recover like any durable run.
- The instruction channel stays free text: `run_adhoc` takes a single `prompt`, composed into a briefing using the shared sections (task = the raw prompt, workspace block with writable cwd, data-profile orientation). No plan-style schema fields.
- Rename `ephemeral-executor` to `adhoc-executor` (agent roster unchanged in size); rebuild it with default sandbox-agent options — write tools, analysis-step standards, standard 50-iteration cap.
- **BREAKING** `ResourcePolicy.ephemeral` becomes `ResourcePolicy.adhoc` (embedder-facing config key for adhoc sandbox sizing).
- Delete `src/execution/ephemeral-runner.ts` entirely: the 120s `DEFAULT_DEADLINE_MS`, `ephemeralSeed`, the private sandbox create/teardown, the no-op `emit`, and the unused `maxIterations` workflow-input override.

## Capabilities

### New Capabilities

- `adhoc-run`: The `run_adhoc` tool contract and adhoc-run semantics — plan-less one-step run launch (run row with null `plan_id`, one seeded step-execution row with stepId `adhoc`), briefing composition from free text, dispatch through the sandbox-step workflow, results via `summary.md`, no synthesis phase, standard recovery.

### Modified Capabilities

- `harness-durable-runtime`: The ephemeral launch semantics (inline `launchAndAwait`, cancel on chat disconnect, boot-time cancel of `ephemeral:`-prefixed PENDING workflows, zero-recovery rule) are replaced by fire-and-forget durable launch with standard recovery.
- `agent-roster`: `ephemeral-executor` is renamed `adhoc-executor` in the roster, meta expectations, and catalog exclusions.
- `harness-sandbox-agents`: The executor's structural-honesty contract changes — the adhoc executor has write tools and a writable mount; "cannot save files, results inline" language is retired. Catalog-exclusion naming follows the rename.
- `resource-budgeted-scheduling`: The `policy.ephemeral` sizing knob becomes `policy.adhoc` and applies to `run_adhoc` sandbox creation.
- `run-synthesis-outcome`: Synthesis outcomes are scoped to planned runs; a plan-less run has no synthesis outcome and consumers surface no synthesis path for it.
- `run-state-persistence`: Adhoc run rows — `workflow_name = "runAdhoc"`, null `plan_id` — and the explicit consequence that the one-active-run-per-`(analysis_id, plan_id)` partial-unique index does not constrain plan-less runs (concurrent adhoc runs are permitted).

## Impact

- **Deleted**: `src/execution/ephemeral-runner.ts`, `src/tools/run-ephemeral.ts`, the `RunLauncher.launchAndAwait` path (ephemeral was its only consumer), the `ephemeral:` workflow-id prefix and its boot sweep rule.
- **Added**: `src/tools/run-adhoc.ts`; a thin `runAdhoc` DBOS workflow (insert run row + seed step row + compose briefing + dispatch the existing sandbox-step workflow); adhoc briefing composition reusing `renderWorkspace`/`renderOrientation`.
- **Renamed/rewritten**: `src/agents/sandbox/ephemeral-executor.ts` → `adhoc-executor.ts` (default opts, new prompt); conversation-agent tool registration (`run_ephemeral` → `run_adhoc`); `inspect_run` returns no `synthesisPath` for plan-less runs.
- **Embedder API**: `ResourcePolicy.ephemeral` → `ResourcePolicy.adhoc` (breaking for embedders that set it); `run_ephemeral` disappears from the conversation-agent tool surface.
- **Cross-subsystem follow-up (separate cli change)**: the cli `harness-runtime` spec's boot sweep ("cancel stale `ephemeral:` PENDING workflows") becomes obsolete — the sweep is dropped and adhoc runs resume like planned runs. The cli sidebar needs no change: it already polls run/step ledger rows, so adhoc runs appear automatically.
- **Deferred (not in this change)**: auto-waking the conversation agent on run completion (pull-only via `inspect_run` remains the contract); an optional `agent?` selector on `run_adhoc`; `report_blocker` for adhoc runs.
