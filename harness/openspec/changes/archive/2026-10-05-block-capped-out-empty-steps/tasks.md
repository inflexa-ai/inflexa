# Tasks: block-capped-out-empty-steps

## 1. The branch

- [x] 1.1 Hoist the `walkStepArtifacts` call in `src/workflows/sandbox-step.ts` above the blocked branch. Keep it inline, and keep the `safeRunValue` wrap.
- [x] 1.2 Extend the branch predicate: enter it on a blocker outcome, or on `hitMaxSteps` with an empty manifest.
- [x] 1.3 Write a deterministic reason for the capped-out case. Name the cap and the empty manifest.
- [x] 1.4 Keep the blocker reason for a step that called `report_blocker`. The blocker outcome wins over the capped-out reason.
- [x] 1.5 Make sure that the completed path does not walk a second time. Pass the hoisted manifest into the post-step stages.

## 2. Tests

- [x] 2.1 A capped-out step with an empty manifest terminates `blocked`, with the deterministic reason in `blocked_reason`.
- [x] 2.2 A capped-out step with artifacts terminates `completed`, with `hitMaxSteps` persisted.
- [x] 2.3 A clean empty step with no blocker terminates `completed`.
- [x] 2.4 A blocker outcome keeps its own reason when the step also capped out.
- [x] 2.5 The parent does not dispatch the dependents of the blocked step.

## 3. Verify

- [x] 3.1 Run `npx tsc --noEmit` in `harness/` and make sure that it is clean.
- [x] 3.2 Run `bun test src/workflows/` against the DBOS test rig.
- [x] 3.3 Run `bun run format:file` on the changed `src/` files.
- [x] 3.4 Read the delta spec against the branch, one scenario at a time.
