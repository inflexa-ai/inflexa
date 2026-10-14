# Tasks

## 1. The event

- [x] 1.1 Add `ProvPlanApprovalRef` to `src/types.ts`, the member `plan_approved` to `ProvEvent`, its arm in `applyProvEvent`, and `appendPlanApproved` in `src/document.ts` (design D1, D2, D3). Export the ref type from `src/index.ts`. Make sure that a test in `src/test/events.test.ts` covers each scenario of "The plan approval is core format". Make sure that a test in `src/test/lineage.test.ts` gives an `informed` edge from the run to the approval when the approval arrives before its run.
- [x] 1.2 Add the `plan_approved` section to the "Events" part of `SPEC.md`. Add the member to the event set of the golden fixture, and regenerate the fixture on purpose. Make sure that `src/test/golden.test.ts` passes against the new bytes.

## 2. Verification

- [x] 2.1 Run `bun run format:file` on the changed files. Then run `bun run typecheck`, `bun run lint`, `bun test src/test/events.test.ts src/test/golden.test.ts src/test/lineage.test.ts`, and `bun run build && bun run smoke`. Make sure that each command passes.
