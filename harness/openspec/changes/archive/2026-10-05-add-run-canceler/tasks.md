# Tasks

## 1. State accessor

- [x] 1.1 Add `markRunCanceledIfActive(pool, runId, reason)` to `src/state/runs.ts` — conditional `canceled` write over the active-status set, reporting the transition
- [x] 1.2 Extend `src/state/runs.test.ts`: transitions running→canceled (stamps `completed_at` + `error`), refuses completed→canceled

## 2. Seam extension

- [x] 2.1 Add required `revokeByJti(ref: { jti; auth }, reason)` to `RunAuthorizer` in `src/execution/run-authorizer.ts` with the out-of-band JSDoc contract
- [x] 2.2 Add the no-op `revokeByJti` to `createLocalRunAuthorizer` and to every hand-built `RunAuthorizer` fake in the repo

## 3. Canceler module

- [x] 3.1 Create `src/execution/run-canceler.ts` — `createRunCanceler(deps)`, `RunCanceler`, `CancelRunResult`, `UnknownRunError`; engine cancel via the purger's `DBOSClient` realization behind an optional `cancelWorkflows` test seam; four isolated convergence phases
- [x] 3.2 Unit tests in `src/execution/run-canceler.test.ts` (fakes, no live DBOS): already-terminal short-circuit, happy convergence, late-committing child re-query, charge-close failure isolation, no-mandate vacuous convergence, conditional-write race, unknown run

## 4. Surface

- [x] 4.1 Export `createRunCanceler`, `RunCanceler`, `CancelRunResult`, `UnknownRunError`, and `markRunCanceledIfActive` from `src/index.ts` beside the sibling execution/state exports

## 5. Verification

- [x] 5.1 `npx tsc --noEmit` clean for touched files; `bun test src/execution/run-canceler.test.ts` and `bun test src/state/runs.test.ts` green
