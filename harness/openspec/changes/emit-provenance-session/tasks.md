## 1. Widen the seam signature

- [x] 1.1 Change `ExecuteAnalysisDeps.emitProvenance` to `(event: RunProvenanceEvent, session: RunSession) => void`, and document why the session is part of the seam (authority, scope, and identity for a persisting realization), why the narrow run-scoped type is deliberate, and that an implementation can ignore the parameter.
- [x] 1.2 Thread the session through `emitProvenanceGuarded`, keeping the guard's log-and-swallow behavior.

## 2. Emit sites

- [x] 2.1 Pass `input.runSession` at the `run_started` emit.
- [x] 2.2 Pass `input.runSession` at the scheduler-loop `step_completed` emit.
- [x] 2.3 Pass `input.runSession` at the terminal `run_completed` emit, keeping fire-and-forget semantics and the checkpointed timestamps unchanged.

## 3. Tests

- [x] 3.1 Assert that the session captured at every `executeAnalysis` emit site is the workflow input's `runSession` (captured values, not call counts).

## 4. Release

- [x] 4.1 Bump the package version `0.17.0` → `0.18.0` (additive minor: the widened optional-callback parameter is type-compatible for existing implementations).
