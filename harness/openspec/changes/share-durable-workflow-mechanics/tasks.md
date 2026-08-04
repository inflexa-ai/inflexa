## 1. Shared Durable LLM Step

- [ ] 1.1 Move `runLlmStep` and `structuredLlmCall` from `src/workflows/target-assessment/lib/` to a shared `src/workflows/lib/`, with no change to their options, behaviour, budget-marker handling, or error classification.
- [ ] 1.2 Repoint `executeTargetAssessment` and its phase modules at the new paths and delete the old files.
- [ ] 1.3 Confirm every call site still supplies its own attempt-numbered step name, so no DBOS cache key changes.
- [ ] 1.4 Run the target-assessment suite unmodified and confirm it passes, including the 402 suspend/resume coverage.

## 2. Shared Run Finalisation

- [ ] 2.1 Extract the generic finalisation sequence from `collectAndComplete` into `src/workflows/lib/finalise-run.ts`, parameterized by derived terminal status, failure reason, terminal part, and whether the pending-row sweep applies.
- [ ] 2.2 Keep each side effect in its own named `DBOS.runStep`, keep the terminal-event-before-status-write ordering, and keep the log-don't-roll-back rule for a partial finalisation failure.
- [ ] 2.3 Rebind `executeAnalysis`'s `collectAndComplete` onto the shared sequence with byte-identical durable step names, leaving scheduler-drain handling, the synthesis outcome note, and synthesis-failure status forcing in `executeAnalysis`.
- [ ] 2.4 Keep the 402 pause branch structurally selected by the pause path itself, never inferred from the written run status, and keep the sweep suppressed on that branch.
- [ ] 2.5 Run the execute-analysis suite unmodified and confirm it passes, including partial finalisation failure, unreachable-dependent sweep, budget pause, and external cancel.

## 3. Verification

- [ ] 3.1 Format the changed source files with the subsystem formatter.
- [ ] 3.2 Run `tsc -p tsconfig.json`, `bun run lint`, and `bun run test:full` from `harness` and resolve regressions.
- [ ] 3.3 Confirm no durable step name, emitted part, or run-status transition differs from before the refactor.
- [ ] 3.4 Run `openspec validate share-durable-workflow-mechanics --strict`.
