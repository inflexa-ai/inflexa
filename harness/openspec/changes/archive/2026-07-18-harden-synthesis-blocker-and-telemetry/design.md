## Context

Run synthesis (`src/execution/run-synthesis.ts`, driven by `synthesizeRun` in `src/app/synthesize-run.ts`, called from the parent workflow's `synthesizeFindings` in `src/workflows/execute-analysis.ts`) can reach `report_blocker` on a run whose step summaries are all present and substantive (issue #146). The `generateRunSynthesis` loop offers three tools — `submit_synthesis` (validated, re-callable on rejection), `report_blocker` (terminal skip), `literature_reviewer` — and caps at 25 iterations. Hitting the cap throws (→ `failed`); a skip is therefore always an explicit `report_blocker` call.

Two mechanics enable a blocker on rich inputs:

1. **The blocker copy invites it.** `buildBlockerTool`'s `blockedWhen` lists "no findings worth surfacing" as a warranting condition, while the synthesizer prompt applies heavy "do NOT include methodology/QC/expected/per-step findings" pressure. `RunSynthesisSchema.findings` has no minimum length, so an empty `findings[]` is a schema-valid submission — but nothing tells the model that, so "nothing worth a finding" can route to `report_blocker` instead of `submit_synthesis`.
2. **The record can't tell misjudgment from give-up.** After the archived `record-synthesis-outcome` change, a blocker persists `synthesis_status = "skipped_blocker"` plus a free-text reason — but not how many `submit_synthesis` rejections preceded it. A blocker from LLM misjudgment (zero rejections) is indistinguishable from one from defensive give-up after repeated validation rejections. The wire part `data-synthesis-progress` already declares a `validationAttempts` field (`src/contracts/chat-parts.ts`) and `SynthesisProgressExtra` already carries it — but nothing populates it.

## Goals / Non-Goals

**Goals:**
- Reserve `report_blocker` for genuinely empty/incoherent inputs; route "no findings worth surfacing" to `submit_synthesis` with an empty `findings[]`.
- Make a blocker's cause diagnosable: count `submit_synthesis` rejections, surface the count on the skip progress (via the existing `validationAttempts` wire field) and on the loud-skip warn, with the rejected issue paths.

**Non-Goals:**
- Changing the classified outcome taxonomy, `setRunSynthesisOutcome`, the `cortex_runs` columns, or the `inspect_run` gating (archived `record-synthesis-outcome`).
- Loosening the `semanticCheck` strictness (numeric PMID, theme-ref, keyReferences). The telemetry exists to reveal whether that strictness is the dominant cause before it is touched.
- Any persistence change — the telemetry rides the existing progress wire field and the `Logger`; nothing new is written to the DB.
- Any CLI/embedder change.

## Decisions

### D1: Count rejections in a mutable telemetry cell captured by the submit tool

`generateRunSynthesis` holds a small mutable cell — `{ rejections: number; issuePaths: Set<string> }` — captured by `buildSubmitTool`'s closure alongside the existing `OutcomeHolder`. Each time `fullyValidate` rejects a submission (schema or semantic), the tool increments `rejections` and adds every issue `path` to `issuePaths`. The "a terminal outcome has already been recorded" guard rejection is NOT a validation rejection and does NOT count. After the loop, `generateRunSynthesis` reads the cell.

- **Why a cell over parsing the transcript:** the count is a byproduct of the validation the submit tool already performs; capturing it at the source is exact and needs no message inspection.
- **Why a `Set` for paths:** the same field can be rejected across several attempts; a set yields a stable, deduped summary (e.g. `synthesis.findings[0].references[0].pmid`, `synthesis.themes[1].findings[0]`).
- **Test seam:** `__buildInnerToolsForTest` already exposes the inner tools + holder; it will additionally expose the telemetry cell so a unit test can drive `submit_synthesis` with invalid payloads and assert the count/paths without the full agent loop.

### D2: Carry the count on `GenerateRunSynthesisResult`, don't infer it downstream

`GenerateRunSynthesisResult` gains a `validationRejections: number` on both terminals and a `rejectedIssuePaths: readonly string[]` on the `skipped` terminal:

```
export type GenerateRunSynthesisResult =
  | { kind: "synthesis"; synthesis: RunSynthesis; validationRejections: number }
  | { kind: "skipped"; reason: string; validationRejections: number; rejectedIssuePaths: readonly string[] };
```

The internal field name is `validationRejections` (precise: rejected submit calls); it maps to the existing wire field `validationAttempts` at the `synthesizeRun` boundary. On a skip, every attempt was a rejection (a success would have produced), so `validationAttempts == validationRejections` there — no semantic drift.

- **Why on the result, not inferred in the workflow:** the count is known only inside the loop; the workflow cannot reconstruct it.

### D3: `synthesizeRun` surfaces the telemetry on the skip path

In the `result.kind === "skipped"` branch of `synthesizeRun`:
- `onProgress("skipped", …, { reason: result.reason, validationAttempts: result.validationRejections })` — rides straight onto `data-synthesis-progress` (the workflow's `onProgress` spreads `...extra`).
- `logger.warn("synthesis skipped — synthesizer reported a blocker", { runId, reason: result.reason, validationRejections: result.validationRejections, rejectedIssuePaths: result.rejectedIssuePaths })` — counts and paths as structured fields, never interpolated (structured-logging).

The `no-summaries` skip path returns before the loop runs; it keeps its existing warn/onProgress (no attempt concept applies).

### D4: Forward the existing logger so the warn is not a no-op in production

`synthesizeFindings` (`execute-analysis.ts`) builds the `synthesizeRun` deps without `logger`, so `synthesizeRun` falls back to `createNoopLogger()` and the loud-skip warn never reaches the host sink in the real workflow. Add `logger: deps.logger` to that deps object (`deps.logger` already exists on `ExecuteAnalysisDeps`). This connects an already-present sink; it does not alter the warn's shipped logic.

### D5: Reframe the blocker copy and add a prompt floor

- `buildBlockerTool`'s `blockedWhen` (`run-synthesis.ts`) drops "no findings worth surfacing," restricts warranting conditions to empty/incoherent summaries, and states that a run with non-empty summaries but no notable findings is a `submit_synthesis` with an empty `findings[]`, not a blocker.
- `synthesis-agent.ts` gains a floor: `findings[]` is selective and MAY be empty; a run with nothing individually notable is still completed via `submit_synthesis` (overview + conclusions), never via `report_blocker`. The `report_blocker` section and the Canonical Flow are aligned to the same wording.

These are string-content changes; unit tests assert on the constructed tool description and the prompt string.

## Risks / Trade-offs

- **A model still calls `report_blocker` on rich inputs despite the copy** → the change cannot force LLM behavior, but the telemetry now records zero rejections, exposing it as misjudgment for the next occurrence and informing whether a stronger gate (or `semanticCheck` loosening) is warranted. → Mitigation: this is the intended diagnostic outcome, not a regression.
- **`validationAttempts` wire-field semantics** (rejections vs total attempts) → on a skip they coincide; the field is only populated on the skip path here, so there is no ambiguous produced-path reading. → Mitigation: documented; produced-path population is out of scope.
- **Threading the logger surfaces warns that were previously silent** → operators newly see skip warns. → Mitigation: that is the point (#146 observability); the warn already existed and is `warn`-level, not `error`.

## Migration Plan

No migration. No schema or wire-contract change (the `validationAttempts` field already exists). Rollback is reverting the source edits; no persisted state is affected.
