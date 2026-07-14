## Context

Step rows are born at "mark-running" inside each sandbox-step child workflow (`src/workflows/sandbox-step.ts` → `insertStepExecution`, which inserts with `status='running'` / `ON CONFLICT DO UPDATE`). The parent scheduler (`src/workflows/execute-analysis.ts`) already knows the full DAG the moment the run starts: `input.steps` (id + depends_on), `computeTopologicalLevels` for the wave, and `input.agentByStepId` for the agent assignment. It even tracks a full in-memory `stepRuntime` map (pending/queued/running/…) and emits `data-dag-state` stream parts — but ledger readers (`queryStepsByRun`) see only rows that exist, i.e. started steps.

`StepExecutionStatus` already includes `pending` (never written) and `skipped` (written only via `updateStepExecution` callers). The table schema needs no change: `started_at` is nullable, and all needed values (`run_id`, `step_id`, `analysis_id`, `wave`, `agent_id`) are known at run start.

## Goals / Non-Goals

**Goals:**
- `queryStepsByRun(runId)` returns every plan step from run start, so any consumer can render honest `done/total` and upcoming steps.
- Recovery-safe: a re-executed parent workflow must not regress rows a prior execution already advanced.
- A terminal run leaves no rows that read as "still going to start".

**Non-Goals:**
- No `queued` (budget-held) status in the ledger — the scheduler's pending/queued distinction stays stream-only (`data-dag-state`); the ledger keeps one "not started" bucket.
- No stream read-side work; this change is ledger-only.
- No change to consumers (the CLI already maps `pending`/`skipped` onto its queued view).

## Decisions

**D1 — Seed in the parent at run start, not lazily in children.** One durable step in `runExecuteAnalysisBody` right after `validateAndInit` succeeds (beside the `data-run-started` emit), inserting all rows in a single multi-row INSERT. Alternative rejected: having each child insert its own `pending` row earlier is impossible — a child workflow does not exist until the scheduler starts it.

**D2 — New `seedStepExecutions(pool, rows)` helper with `ON CONFLICT (run_id, step_id) DO NOTHING`, not a reuse of `insertStepExecution`.** The existing helper's upsert semantics (reset to running, clobber timing) are exactly wrong for seeding: on DBOS recovery the parent body re-runs and the seed step may replay against rows that are already `running`/`completed`. DO NOTHING makes the seed idempotent and monotone — it can only ever add missing rows. Seeded rows carry `status='pending'`, `started_at=NULL`, `attempts` left to its column default (no attempt has happened).

**D3 — Ordering: `ORDER BY wave, started_at NULLS LAST, step_id` (explicit `NULLS LAST`).** Postgres defaults to NULLS LAST for ASC, but making it explicit documents the intent: within a wave, started steps in start order, then unstarted steps in stable id order. Alternative rejected: ordering pending rows by plan declaration order would require persisting a plan-position column — not worth a schema change when step ids are already human-ordered in practice (`s1_…`, `s2_…`) and wave already carries the topology.

**D4 — Sweep `pending → skipped` in `collectAndComplete`, gated on the genuinely-terminal branch (NOT status values).** `collectAndComplete` is the spec-designated single finalisation hook that runs on every path — including the 402 budget pause, which sets the run row `"canceled"` yet leaves the parent resumable (`DBOS.cancelWorkflow` → later `DBOS.resumeWorkflow`, per the workflow-failure-lifecycle spec). A status-based gate would therefore wrongly sweep the pause path; the gate must be the branch itself: sweep on the genuine-terminal paths (success, fail-fast, external cancel, synthesis failure) and skip it on the resumable budget-pause branch, whose pending rows the resumed workflow still needs. The sweep is one `UPDATE cortex_step_executions SET status='skipped', completed_at=… WHERE run_id=$1 AND status='pending'` durable step. `skipped` is the honest label ("never ran, never will"), already in the enum and already mapped by consumers. Alternative rejected: sweeping to `canceled` — that status means "torn down mid-flight" (fail-fast cascade) and would misreport steps that never started.

**D5 — `wave` comes from `computeTopologicalLevels`, same value the child would write.** The seed and the mark-running upsert therefore agree on `wave`; the child's `ON CONFLICT DO UPDATE` re-writes the identical level, so there is no ordering flicker between seed and start.

## Risks / Trade-offs

- [Seed step replays after a crash] → `DO NOTHING` conflict action makes replay a no-op; rows advanced by children are untouched.
- [A plan step whose agent assignment is missing from `agentByStepId`] → `agent_id` is NOT NULL; seed with the same fallback the scheduler uses when dispatching (empty-string assignments are rejected earlier by plan validation — verify at implementation and reuse that guarantee rather than inventing a default).
- [Sweep races a still-finishing child on the fail-fast path] → children are awaited/settled before `collectAndComplete` runs (the scheduler loop returns only after in-flight children settle), so no child can flip a row to `running` after the sweep. Verify with the cancel-cascade test rig.
- [Consumers that assumed "row exists ⇒ step ran"] → survey in-repo readers: `queryStepsByRun` consumers (CLI dialog/sidebar, `inspect-run` tool) all map by status, not existence; the `inspect-run` tool's output should be spot-checked for wording that implies execution.

## Migration Plan

No schema migration. Old runs simply lack seeded rows — readers already tolerate partial ledgers. Forward-only behavior change; rollback = revert the code.

## Open Questions

None — decisions above resolve the exploration's open points (pending renders as the consumer's existing queued view; no pagination/stream concerns on this side).
