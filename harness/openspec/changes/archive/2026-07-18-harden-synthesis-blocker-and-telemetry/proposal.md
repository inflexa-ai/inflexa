## Why

The run synthesizer can reach a `report_blocker` terminal on a run whose step summaries are all present, non-empty, and substantive — ending the run with no synthesis on genuinely rich inputs (issue #146, root-cause trigger behind run `fb0f43f5`). Two mechanics enable this: the blocker tool copy invites a "no findings worth surfacing" exit even though an empty `findings[]` is a schema-valid submission, and nothing records how many `submit_synthesis` rejections preceded a blocker — so a blocker born of LLM misjudgment is indistinguishable from one born of a defensive give-up after repeated validation rejections.

## What Changes

- **Harder-to-fire blocker on non-empty summaries.** Reframe the run synthesizer's blocker `blockedWhen` prose so `report_blocker` is reserved for genuinely empty or incoherent inputs, not "no findings worth surfacing." Add a synthesizer-prompt floor stating that an empty `findings[]` is a valid submission (findings are SELECTIVE), so "nothing worth a finding" routes to `submit_synthesis`, never to a blocker.
- **Validation-rejection telemetry.** `generateRunSynthesis` counts `submit_synthesis` rejections and captures the rejected issue paths; the count is threaded up through its result on every terminal. `synthesizeRun` populates the already-declared-but-unwired `validationAttempts` field on the skip `onProgress`, and adds the attempt count plus an issue-path summary as structured fields on the existing loud-skip `logger.warn` — so a blocker skip's cause (misjudgment vs give-up) is diagnosable from the record.

## Capabilities

### New Capabilities
- `run-synthesis-blocker-discipline`: The run synthesizer reserves `report_blocker` for genuinely empty or incoherent inputs; on non-empty step summaries it always resolves through `submit_synthesis` (an empty `findings[]` is a valid submission), and the blocker tool copy and synthesizer prompt reflect this discipline.

### Modified Capabilities
- `run-synthesis-outcome`: The skip observability is enriched with validation-rejection telemetry — `generateRunSynthesis` counts `submit_synthesis` rejections and threads the count through its result, and the skip `onProgress` and loud-skip `logger.warn` carry the attempt count and an issue-path summary so a blocker skip's cause is diagnosable.

## Impact

- **Harness (owner):**
  - `src/execution/run-synthesis.ts` — count `submit_synthesis` rejections + capture issue paths in `generateRunSynthesis`; extend `GenerateRunSynthesisResult` to carry the count on both terminals; reframe `buildBlockerTool`'s `blockedWhen`.
  - `src/app/synthesize-run.ts` — populate `validationAttempts` on the skip `onProgress`; add count + issue-path summary to the loud-skip `logger.warn` fields.
  - `src/prompts/synthesis-agent.ts` — add the empty-`findings[]`-is-a-valid-submission floor; align the `report_blocker` guidance.
  - `src/workflows/execute-analysis.ts` — forward the already-present `deps.logger` into the `synthesizeRun` deps in `synthesizeFindings`, so the loud-skip warn (and its new telemetry fields) reaches the injected sink in the real workflow path instead of a no-op logger. This connects an existing sink; it does not change the warn's shipped logic.
  - Spec: new `run-synthesis-blocker-discipline`; delta on `run-synthesis-outcome`.
- **No DB change** — telemetry rides the existing `data-synthesis-progress` wire fields (`validationAttempts`) and the `Logger`; nothing is persisted to `cortex_runs`.
- **Embedder (CLI):** no wiring change — the count rides the existing progress part and log sink the CLI already consumes.
- **Not in scope / not re-opened:** the shipped outcome ledger (`synthesis_status`, `setRunSynthesisOutcome`), the loud-skip warns' existence, and the `inspect_run` gating from the archived `record-synthesis-outcome` change are unchanged. The `semanticCheck` strictness (numeric PMID, theme-ref, keyReferences) is untouched — the telemetry exists precisely to reveal whether that strictness is the dominant cause before it is revisited.
