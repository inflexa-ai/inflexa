## Why

A run whose synthesis silently skips (the synthesizer calls `report_blocker`, or no summaries load) currently finalises as `status = "completed"` with empty findings, writes no `synthesis.json`, and logs nothing — indistinguishable from a genuinely clean run. Worse, `inspect_run` advertises `synthesisPath` on any completed run, so a consumer reads whatever sits at `runs/{runId}/synthesis.json` — a stale/absent file — as this run's synthesis. This is exactly how run `fb0f43f5` served a `"test"` stub to the conversation agent, which then reconstructed the whole summary by hand. There is no authoritative record anywhere of whether synthesis produced a result: `cortex_runs` has no synthesis column, `synthesis.json` is not a registered artifact, and the only DB trace is a best-effort vector-index row written only on success.

## What Changes

- Run synthesis resolves to an explicit, classified **outcome** — `produced | skipped_no_summaries | skipped_blocker | failed` — returned up through `synthesizeRun` / `synthesizeFindings` instead of being flattened to `{ findings: [] }`.
- The outcome (and a nullable human-readable reason) is persisted on the **`cortex_runs` run ledger** as the authoritative record, written by `collectAndComplete` alongside the terminal run status. The disk `synthesis.json` remains the content store; the DB row becomes the authority on whether that content exists and is valid.
- Both non-fatal skip paths **log a warning** with `runId` + reason. A skip on a run with N non-empty summaries is an anomaly, not silence.
- `inspect_run` gates `synthesisPath` on `synthesis_status = "produced"` (not on `status = "completed"`) and surfaces the synthesis outcome + reason, so the conversation agent falls back to step summaries deliberately instead of reading a phantom file. The "Interpreting Results" conversation guidance is reconciled to treat synthesis as present-only-when-produced.

## Capabilities

### New Capabilities
- `run-synthesis-outcome`: The run synthesizer resolves every terminal to a classified outcome (`produced`/`skipped_no_summaries`/`skipped_blocker`/`failed`), the non-fatal skips are logged rather than silent, and run consumers (`inspect_run`, the conversation guidance) key on the recorded outcome instead of the presence of a disk file.

### Modified Capabilities
- `run-state-persistence`: `cortex_runs` gains `synthesis_status` and `synthesis_reason` columns; `CortexRunRow` and the run query helpers carry them.
- `workflow-failure-lifecycle`: `collectAndComplete` records the synthesis outcome onto the run row on every terminal path, extending the existing synthesis-failure rule from "force failed status" to "record the full outcome (produced/skipped/failed)".

## Impact

- **Harness (owner):** `state/schema.ts`, `state/init.ts` (additive `ADD COLUMN IF NOT EXISTS`), `state/runs.ts` (`updateRunStatus`/`mapRunRow`/queries), `app/synthesize-run.ts` (return outcome + warn on skip), `workflows/execute-analysis.ts` (`synthesizeFindings` return, `collectAndComplete` persist), `tools/research/inspect-run.ts` (gate + surface), `prompts/conversation.ts` (Interpreting Results guidance). New spec `run-synthesis-outcome`.
- **DB:** additive, backward-compatible migration — existing rows read `synthesis_status = NULL` (unknown), no backfill required.
- **Embedder (CLI):** no wiring change required; synthesis is enabled by default and the outcome flows through the existing run-completed path. The CLI consumes the harness surface unchanged.
- **Out of scope (tracked in GitHub issue #146):** hardening *why* the synthesizer reaches `report_blocker` on rich, valid inputs. This change does not alter the synthesizer's blocker or validation behavior.
