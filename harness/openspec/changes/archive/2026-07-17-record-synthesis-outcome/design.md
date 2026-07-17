## Context

Run-level synthesis (`app/synthesize-run.ts`, driven by the parent `executeAnalysis` workflow via `synthesizeFindings` in `workflows/execute-analysis.ts`) has three terminal shapes today:

- **produced** — `submit_synthesis` succeeds; `synthesis.json` is written to `runs/{runId}/synthesis.json`, a vector row is indexed, findings are returned.
- **skipped** — either no step summaries loaded (`synthesize-run.ts:94`) or the synthesizer called `report_blocker` (`:115`). Both `return { findings: [] }`, write no file, and log nothing.
- **failed** — any thrown error re-throws (`:160`), the parent sets `forceFailed`, and the run row goes to `status = "failed"`.

The gap is entirely in the **skipped** shape. It is invisible: no log line, no distinct run status (the run is `"completed"`), and no file. `inspect_run` (`tools/research/inspect-run.ts:53`) then advertises `synthesisPath` on any `status === "completed"` run, so a consumer reads a stale/absent `synthesis.json` as authoritative. On run `fb0f43f5` that stale file was a `"test"` stub.

The run ledger (`cortex_runs`) is the natural authority for run-level state — it already owns `status`, `error`, and the terminal write in `collectAndComplete` — but it has no synthesis column. `synthesis.json` is not a `cortex_artifacts` row, and the vector index entry is best-effort (written only on success, swallowed-on-failure), so neither is a reliable "did synthesis produce?" signal.

## Goals / Non-Goals

**Goals:**
- A single authoritative, DB-side record of the synthesis outcome per run, written on every terminal path by the existing finalisation hook.
- A skipped synthesis is observable in logs, never silent.
- Consumers (`inspect_run`, conversation guidance) key on the recorded outcome, never on the presence of a mutable disk file.
- Backward-compatible: existing rows and existing CLI wiring keep working with no backfill.

**Non-Goals:**
- Changing *why* the synthesizer reaches `report_blocker` on valid inputs (GitHub issue #146).
- Registering `synthesis.json` as a `cortex_artifacts` row, or moving synthesis content into the DB — the file stays the content store.
- Any CLI/embedder wiring change — synthesis is enabled by default and the outcome rides the existing run-completed path.

## Decisions

### D1: Record the outcome on `cortex_runs`, not on disk or the vector index

Two new columns: `synthesis_status TEXT` and `synthesis_reason TEXT` (both nullable). `synthesis_status` takes `produced | skipped_no_summaries | skipped_blocker | failed`; `synthesis_reason` carries the blocker/skip/failure reason string (null for `produced`).

- **Why the run ledger:** `collectAndComplete` already owns the authoritative terminal write for the run and runs on every terminal path (`workflow-failure-lifecycle`). The synthesis outcome is run-level state with the same lifetime as `status` — it belongs on the same row, written in the same finalisation hook. Precedent: `cortex_step_executions.blocked_reason` records an agent-declared blocker reason on the step ledger.
- **Why not the disk file:** a disk marker is mutable by users/tools and absent-on-skip — the exact fragility that caused this bug.
- **Why not the vector index:** it is a search index, written only on the produced path, inside a `try/catch` that only warns — not a status of record.

`synthesis_status` is stored as free `TEXT` (not a Postgres enum) to match the existing convention — `cortex_runs.status` and `cortex_step_executions.status` are all `TEXT`, validated by a Zod enum at the `mapRunRow` boundary. A nullable column reads as "unknown" for legacy rows and for runs where synthesis was disabled or never reached (`final.completed.size === 0`).

### D2: Thread a typed outcome up from `synthesizeRun`, don't infer it in the workflow

`synthesizeRun` / `synthesizeFindings` return a discriminated outcome alongside findings, e.g. `{ status: "produced" | "skipped_no_summaries" | "skipped_blocker" | "failed"; reason?: string; findings: readonly RunFinding[] }`. The workflow body captures it and passes it to `collectAndComplete`, which persists it via a focused `setRunSynthesisOutcome(pool, runId, status, reason?)` helper (mirroring the existing `setRunMandate` writer) invoked inside the terminal finalisation, next to the `persist-final-status` write.

- **Why a focused helper over overloading `updateRunStatus`:** `updateRunStatus` is also called mid-run (`status = "running"`) where synthesis is irrelevant; a dedicated writer keeps the two concerns separate and testable, matching the `setRunMandate` precedent for focused column writes.

- **Why:** the classification is known only inside `synthesizeRun` (it distinguishes `no-summaries` from `blocker` from `produced`). Inferring it in the workflow from `findings.length` would conflate "produced with zero surfaced findings" with "skipped". The `failed` case already re-throws and is caught in the body (`synthesisError`), so the body maps that catch to `status: "failed"` for the column while the existing `forceFailed` path handles the run status.

### D3: Loud skip via the injected logger

Both skip sites in `synthesizeRun` log `logger.warn` with `runId` and the reason (`no-summaries` / `blocker` + the blocker reason). `synthesizeRun` already accepts `deps.logger` (used in the vector-index catch), so no new dependency. Per structured-logging, identifiers ride as fields, "which stage" rides as the `named("synthesize-run")` namespace.

### D4: `inspect_run` gates and surfaces the outcome

`formatRun` sets `synthesisPath` only when `synthesis_status === "produced"` (falling back to `null` otherwise), and always includes `synthesisStatus` + `synthesisReason` in the formatted run so the agent has the authoritative signal. The conversation "Interpreting Results" guidance (`prompts/conversation.ts`) is reconciled to say synthesis exists only when the run reports it produced, and to fall back to step summaries otherwise.

## Risks / Trade-offs

- **A produced synthesis whose `persistSynthesis` write later disappears** (manual deletion) → the DB says `produced` but the file is gone. Mitigation: acceptable — the DB records the run's own outcome truthfully; a consumer that fails to read the advertised file surfaces a read error rather than silently reading a phantom, which is strictly better than today.
- **Column drift between the base `CREATE TABLE` and the additive `ADD COLUMN IF NOT EXISTS`** → both must list the two columns. Mitigation: mirror the existing `mandate_jti` pattern which appears in both places; a spec scenario asserts a fresh DB and a migrated DB converge.
- **Outcome taxonomy grows later** (e.g. `skipped_disabled`) → `TEXT` + Zod enum absorbs new members without a DDL change; only the Zod enum and consumers update.

## Migration Plan

Additive, no backfill. `ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS synthesis_status TEXT` and `... synthesis_reason TEXT` join the existing `addMigrations` list in `state/init.ts`; the base `CREATE TABLE cortex_runs` gains both columns for fresh DBs. Existing rows read `synthesis_status = NULL` (unknown), which `inspect_run` treats as "not produced" — so pre-migration completed runs stop advertising a synthesis path, matching the truth that we cannot vouch for their file. Rollback is dropping the two columns; no data loss for other columns.
