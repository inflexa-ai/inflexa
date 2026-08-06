## 1. Widen the seam signature

- [x] 1.1 Change `ExecuteAnalysisDeps.emitProvenance` to `(event: RunProvenanceEvent, session: RunSession) => void`, and document why the session is part of the seam (authority, scope, and identity for a persisting realization), why the narrow run-scoped type is deliberate, and that an implementation can ignore the parameter.
- [x] 1.2 Thread the session through `emitProvenanceGuarded`, keeping the guard's log-and-swallow behavior.

## 2. Emit sites

- [x] 2.1 Pass `input.runSession` at the `run_started` emit.
- [x] 2.2 Pass `input.runSession` at the scheduler-loop `step_completed` emit.
- [x] 2.3 Pass `input.runSession` at the terminal `run_completed` emit, keeping fire-and-forget semantics and the checkpointed timestamps unchanged.

## 3. Data-profile hook

- [x] 3.1 Add the optional `emitProvenance` to `DataProfileDeps` with the same signature and rationale.
- [x] 3.2 Extend `RunProvenanceEvent` with the `data_profile_completed` arm (`analysisId`, terminal `status`, checkpointed `atMs`, `durationMs`), and record the no-started-arm choice.
- [x] 3.3 Emit the arm on the profile's completion and failure terminal paths with the session from the durable workflow input, through a guarded invoker, after every operation that can throw.

## 4. Tests

- [x] 4.1 Assert that the session captured at every `executeAnalysis` emit site is the workflow input's `runSession` (captured values, not call counts).
- [x] 4.2 Assert the `data_profile_completed` event and its session on the profile's completion and failure paths, plus the absent-callback and throwing-observer behaviors.

## 5. Release

- [x] 5.1 Bump the package version `0.17.0` → `0.18.0` (additive minor: the widened optional-callback parameter is type-compatible for existing implementations; the new union arm is additive).
