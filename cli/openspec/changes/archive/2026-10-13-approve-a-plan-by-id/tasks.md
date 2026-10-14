# Tasks

## 1. The links

- [x] 1.1 Run `bun run harness:local` and `bun run kernel:local`, after the harness change and the kernel change are complete. Make sure that `bun run typecheck` sees `approvePlan` on the core runtime and `plan_approved` in `ProvEvent`.

## 2. The provenance member

- [x] 2.1 Add `ProvPlanApprovalRef` to `src/types/prov.ts`, `prov.plan_approved` to `src/types/events.ts`, and its case in `eventFields` of `src/lib/bus.ts` (design D4). Make sure that a test of the bus projection shows the thread id, the plan id, and the run id.
- [x] 2.2 Map `approve-plan` in `createSessionEmit` (design D4). Make sure that a test in `src/modules/harness/prov_bridge.test.ts` covers the scenario "An approval names the person".
- [x] 2.3 Make sure that a test in `src/modules/prov/prov.test.ts` covers the scenario "An approval lands before the start of its run".

## 3. The route

- [x] 3.1 Add `approvePlan` to `HarnessRuntime` and to `RunRoutesOpts`, and the wire types to `src/api/runs.ts` (design D2, D3). Make sure that `bun run typecheck` passes.
- [x] 3.2 Add `POST /plans/:planId/approve` to `runRoutes` (design D1). Make sure that tests in `src/server/routes/runs.test.ts` cover each scenario of "The server approves a plan by its id". Make sure that a test covers each refusal of the harness, and that the gate answers 503 `unavailable` before the boot.

## 4. The TUI

- [x] 4.1 Add the `data-plan-approval` case to `MessageBlock` (design D5). Make sure that a test in `src/tui/layout/message_block.test.tsx` covers the scenario "A reloaded approval shows its line and its run card".

## 5. Verification

- [x] 5.1 Run `bun run format:file` on the changed files. Then run `bun run typecheck`, `bun run lint`, and the test files of tasks 2 to 4. Make sure that each command passes.
