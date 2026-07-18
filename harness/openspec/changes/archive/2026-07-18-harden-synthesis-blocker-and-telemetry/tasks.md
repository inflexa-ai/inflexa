## 1. Capture validation-rejection telemetry (run-synthesis.ts)

- [x] 1.1 Add a mutable telemetry cell `{ rejections: number; issuePaths: Set<string> }` in `generateRunSynthesis`, captured by `buildSubmitTool`'s closure alongside the `OutcomeHolder`.
- [x] 1.2 In `buildSubmitTool`, increment `rejections` and add every issue `path` to `issuePaths` on each `fullyValidate` rejection; do NOT count the "terminal already recorded" guard rejection.
- [x] 1.3 Extend `GenerateRunSynthesisResult`: add `validationRejections: number` to the `synthesis` terminal, and `validationRejections: number` + `rejectedIssuePaths: readonly string[]` to the `skipped` terminal.
- [x] 1.4 After the loop, read the telemetry cell and populate the result's `validationRejections`/`rejectedIssuePaths` on both terminals (sorted, deduped issue paths on the skip terminal).
- [x] 1.5 Extend `__buildInnerToolsForTest` to expose the telemetry cell so tests can assert count/paths without the full loop.

## 2. Surface telemetry on the skip path (synthesize-run.ts + execute-analysis.ts)

- [x] 2.1 In `synthesizeRun`'s `skipped` branch, pass `validationAttempts: result.validationRejections` in the `onProgress("skipped", …)` extra alongside `reason`.
- [x] 2.2 In the same branch, add `validationRejections` and `rejectedIssuePaths` as structured fields on the loud-skip `logger.warn` (fields, never interpolated into the message).
- [x] 2.3 In `synthesizeFindings` (`execute-analysis.ts`), forward `logger: deps.logger` into the `synthesizeRun` deps object so the warn reaches the injected sink instead of a no-op logger.

## 3. Harden the blocker trigger (run-synthesis.ts + synthesis-agent.ts)

- [x] 3.1 Reframe `buildBlockerTool`'s `blockedWhen`: restrict warranting conditions to empty/incoherent summaries, drop "no findings worth surfacing," and state that a run with non-empty summaries but no notable findings is a `submit_synthesis` with an empty `findings[]`, not a blocker.
- [x] 3.2 In `synthesis-agent.ts`, add a floor stating `findings[]` is selective and MAY be empty — a run with nothing individually notable is completed via `submit_synthesis` (overview + conclusions), never `report_blocker`.
- [x] 3.3 Align the prompt's `report_blocker` section and Canonical Flow wording so no clause directs a blocker on "no findings worth surfacing."

## 4. Tests (bun test — touched suites only)

- [x] 4.1 Unit test: driving `submit_synthesis` with invalid payloads N times increments the telemetry count to N and captures the expected issue paths (via `__buildInnerToolsForTest`).
- [x] 4.2 Unit test: a `skipped_blocker` outcome from `synthesizeRun` emits `onProgress("skipped", …)` with `validationAttempts` set, and a `logger.warn` (spy/fake logger) carrying `runId`, reason, `validationRejections`, and `rejectedIssuePaths`.
- [x] 4.3 Unit test: the constructed `report_blocker` tool description contains no "no findings worth surfacing" phrasing and scopes to empty/incoherent inputs; the synthesizer prompt asserts empty `findings[]` is a valid submission.
- [x] 4.4 Confirm the `no-summaries` skip path and the `produced` path are unchanged (no `validationAttempts` regression; `produced` still writes `synthesis.json` and does not warn).

## 5. Validate

- [x] 5.1 `bun run format:file` on the changed `src/` files.
- [x] 5.2 `tsc -p tsconfig.json` clean.
- [x] 5.3 `eslint` clean on the changed files (no `console`, no `.forEach`, neverthrow rules intact).
- [x] 5.4 `openspec validate harden-synthesis-blocker-and-telemetry --strict` passes.
