# Design: synthesis-step-ledger-row

## Context

`executeAnalysis` runs synthesis as a parent-body `DBOS.runStep` (`synthesize-findings`, `src/workflows/execute-analysis.ts:625`) after `runSchedulerLoop` returns. It is frequently the longest phase of a run, yet the only ledger it touches is `cortex_runs` — and only *after* it finishes (`persist-synthesis-outcome`, after `persist-final-status`). Every progress reader — the TUI sidebar, `inflexa run`, the `inspect_run` tool — polls `cortex_step_executions` via `queryStepsByRun`, where synthesis has no row, so all of them read a finished run while synthesis works and cannot name the phase when it fails.

The ledger's own conventions already anticipate this fix:

- `seedStepExecutions` seeds the full DAG as `pending` at run start with `ON CONFLICT DO NOTHING`, explicitly "so consumers can render honest done/total progress" (`src/state/step-executions.ts:22`).
- The status vocabulary (`pending/running/completed/failed/skipped/canceled/blocked` + `blocked_reason`) maps 1:1 onto the classified `SynthesisStatus` outcomes of the run-synthesis-outcome spec.
- The scheduler dispatches from `input.steps`, never from ledger rows — the ledger is presentation/inspection state only, so an extra row cannot perturb scheduling, recovery, or replay.
- Plan validation already maintains a reserved step-id set (`RESERVED_STEP_IDS`, `src/schemas/validate-plan.ts:28`) for ids that would collide with harness-owned names.

## Goals / Non-Goals

**Goals:**

- Synthesis progress and terminal shape visible to every existing `queryStepsByRun` reader with no new read path, transport, or consumer change.
- Honest denominators from the first frame: the synthesis row is seeded `pending` with the DAG seed, not popped into existence when synthesis starts.
- A synthesis failure names its phase: the row flips `failed` before the run row goes terminal.
- The reserved id can never collide with a plan step.

**Non-Goals:**

- Consuming the run-event stream (`data-synthesis-progress`, `data-loop-event`) in the CLI — issue #203's "full fidelity" direction, tracked separately.
- The unbounded-shutdown fix (#204).
- Live activity labels or any other run-event-stream-fed rendering — the sidebar renders the row through its existing `stepStateOf` mapping. (The elapsed-age polish for running step rows IS in scope for this effort, but it is CLI presentation behavior owned by the CLI's spec tree — it rides the companion change `cli/openspec/changes/run-step-elapsed-age`.)
- Provenance events for synthesis (the run-level `run_completed` event already brackets it).

## Decisions

### D1: A reserved row in `cortex_step_executions`, not a new table, column, or CLI-side inference

The row is `(run_id, step_id = "synthesis", agent_id = "run-synthesizer", wave = max DAG level + 1, status, timing, error, blocked_reason)` — existing columns only, no migration.

Alternatives rejected:

- **CLI-synthesized pseudo-row** (issue #203's "cheapest" direction): derives "synthesizing" from `run.status === "running" && all rows terminal` in `sidebar_live.ts`. Fixes one of three blind surfaces, guesses at state the harness owns (it cannot see `synthesisEnabled`), and violates the harness-first boundary rule.
- **`cortex_runs.phase` column**: a second write path and a second read path for the same fact; every consumer would need new code, where the step row needs none.
- **Run-event stream consumption**: the right long-term transport for *activity detail*, but the read helper does not exist OSS-side and phase visibility should not wait for it.

`wave = max level + 1` makes `queryStepsByRun`'s `ORDER BY wave, started_at NULLS LAST, step_id` sort the row after every DAG step with no query change.

### D2: Seed with the DAG, gated on `synthesisEnabled` only

The synthesis row joins the existing `seed-step-executions` step's row array when `deps.synthesisEnabled` (default true) holds. The full run gate is `synthesisEnabled && final.completed.size > 0`, but `completed.size` is unknowable at seed time — a seeded row whose gate later fails simply stays `pending` and the existing terminal sweep (`sweepPendingStepExecutions`) marks it `skipped`, which is the honest reading ("never ran, never will"). When synthesis is disabled the row is never seeded: a run configured without synthesis is a 5-step run, not a 6-step run with a permanently skipped tail.

Riding the existing seed step (rather than a separate insert) inherits its replay contract for free: `ON CONFLICT DO NOTHING` is idempotent and monotone, so a recovery replay cannot reset a row a prior execution already advanced.

### D3: Transitions reuse the two existing mutation shapes

- **pending → running**: `insertStepExecution` (the mark-running upsert the DAG children use — stamps `started_at`, resets telemetry; `childWorkflowId: null` since synthesis runs in the parent body). Wrapped in a named `DBOS.runStep` immediately before `synthesize-findings`, executed only when the run gate passes.
- **running → terminal**: `updateStepExecution` in a named `DBOS.runStep` immediately after the synthesis step settles — on the success path *and* in the existing `catch` — and strictly **before** `collectAndComplete`, so no reader can observe a terminal run row beside a still-`running` synthesis row. `durationMs` comes from bracketing `DBOS.now()` reads (checkpointed, replay-stable), matching how the run span is measured.

On a recovery replay the cached `synthesize-findings` step returns instantly, so the re-executed mark-running upsert is immediately overwritten by the re-executed terminal stamp — transient, ordered, and convergent.

### D4: Outcome → status mapping keeps the blocker honest

| Synthesis outcome | Row status | Reason column |
|-|-|-|
| `produced` | `completed` | — |
| `skipped_no_summaries` | `skipped` | — |
| `skipped_blocker` | `blocked` | `blocked_reason` = blocker reason |
| threw | `failed` | `error` = the same message persisted to `cortex_runs.synthesis_reason` |

`skipped_blocker → blocked` is deliberate even though the CLI's `stepStateOf` renders `blocked` in the error tone while the *run* completes green: `blocked` is the ledger's word for "the agent honestly declared it could not produce its deliverable" (step-execution-tracking spec), which is exactly what `report_blocker` is, and a run with no synthesis warrants attention. Flattening it to `skipped` would erase the reason and the distinction from "nothing to synthesize". Accepted trade-off, documented in the spec delta.

The `error` string mirrors what the parent already persists to `cortex_runs` (`synthesis_reason`, and `synthesis-failed: …` in `cortex_runs.error`), so the row adds no new information exposure beyond the run row's existing treatment.

### D5: Ledger writes on the synthesis row are log-don't-fail; the seed keeps its existing throw

The mark-running and terminal stamps follow the finalisation discipline of `collectAndComplete`'s sibling steps (`persist-final-status`, `persist-synthesis-outcome`): a failed display-ledger write logs and continues, because a progress row must never fail an otherwise-healthy run. The seed keeps its current `unwrapOrThrow` — it already fails the run on a DB error today, and splitting one row out of that contract would complicate the seed for no gain.

### D6: `synthesis` joins the reserved step-id set

`RESERVED_STEP_IDS` currently equals `STEP_SUBDIRS` (`scripts/output/figures/logs/notebooks`). It becomes that set plus `"synthesis"`, and the validation error message names both collision reasons (artifact-subdir convention; the run-phase ledger row and `runs/{runId}/synthesis.json`). Case-insensitive, like the existing check.

### D7: Cancellation is not a synthesis outcome

The synthesis `catch` re-throws `DBOSWorkflowCancelledError` before any classification, mirroring the established sandbox-step rule (`src/workflows/sandbox-step.ts:513`): a cancelled workflow must never be recorded as a synthesis failure — not on the row, not in `cortex_runs.synthesis_*`. Today this is latent rather than observable (the mislabeled outcome never persists because every subsequent DBOS operation raises the same cancellation error before `persist-synthesis-outcome` runs, and no external caller cancels the parent workflow — every `cancelWorkflow` site is internal), but the guard makes it structural instead of accidental.

After the re-throw the row is deliberately left `running`: on that path `collectAndComplete` never executes, so `cortex_runs` also still reads `running` — the pair stays consistent, and a CANCELLED workflow over a `running` ledger is the pre-existing wedge class `inflexa run` already detects via its DBOS terminal-status cross-check (`DBOS_TERMINAL_STATUSES` includes `CANCELLED`). No new finalisation machinery is warranted for a path that has no live caller.

## Risks / Trade-offs

- **[Denominators grow by one everywhere]** → Accepted and intended: a 5-step plan reports a 6-row run (sidebar `x/6`, `inflexa run` "6 step(s)", `inspect_run`). The row is labeled `synthesis`, which is self-explanatory; per-consumer exclusion would re-introduce exactly the special-casing the ledger row eliminates.
- **[Existing plans with a step literally named `synthesis`]** → The reserved-id check rejects them only at *new* plan validation; a historical run containing such a step would collide on `(run_id, step_id)` for *new runs of that plan* — the seed's `DO NOTHING` means the synthesis row silently merges with the plan step's row. Mitigation: validation now rejects the id, and replayed/resumed old runs re-validate through the same gate (`validateAndInit`). Residual risk is confined to pre-existing plans that already used the id, which the T#S# planner convention makes unlikely.
- **[`blocked` renders error-toned beside a green run]** → Accepted (D4); the tone signals "needs attention", which a synthesis blocker is.
- **[A crash between the synthesis step and the terminal stamp leaves the row `running`]** → DBOS recovery re-executes the body; the cached synthesis step returns and the stamp re-runs. A run that dies *permanently* (workflow ERROR before the stamp) leaves a `running` row beside a wedged run — the same wedge shape `inflexa run` already detects via DBOS terminal-status cross-checks, not a new failure class.
- **[Budget-pause path]** → Synthesis runs before the self-cancel and its row reaches a terminal status normally; the pause branch's sweep skip (which preserves `pending` DAG rows for resume) does not touch it. No new handling needed.

## Migration Plan

No schema migration (existing columns/statuses only). Rows written by older harness versions simply lack the synthesis row — consumers already render whatever rows exist, and `cortex_runs.synthesis_status` `NULL` remains the "unknown" marker for legacy runs. Rollback is dropping the writes; orphaned `synthesis` rows in the ledger remain valid, self-describing step rows.

## Open Questions

None — all decisions above were resolved against the code (`execute-analysis.ts`, `step-executions.ts`, `validate-plan.ts`) and the affected consumers.
