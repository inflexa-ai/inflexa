# Tasks

## 1. Cli: give the installed `ProvenanceSeam` to the canceler of the cancel route

- [x] 1.1 Make sure that the harness change of the same name is complete, and that `npm run build` in `harness/` passes. The cli resolves the linked harness through its `dist`.
- [x] 1.2 In `src/server/routes/runs.ts`, add an exported function that makes the `RunCancelerDeps` of the production canceler from a pool. It gives the noop run charge, the local run authorizer, and `provenance: provenanceSeam()` when a seam is installed. Make `DEFAULT_RUN_ROUTES_OPTS.cancelRun` use it. Make sure that `bun run typecheck` passes.
- [x] 1.3 In `src/server/routes/runs.test.ts`, add a test for the scenario "The production canceler carries the installed provenance binding": install a `ProvenanceSeam`, and assert that the deps carry that exact value. Then install `null`, and assert that the deps carry no seam. Restore the installed seam after the test. Make sure that `bun test src/server/routes/runs.test.ts` passes.
- [x] 1.4 Change the type of each test realization of the run emit that declares a `RunSession` parameter, if the typecheck needs it. Make sure that `bun run typecheck` passes.

## 2. Verification

- [x] 2.1 Run `bun run format:file` on each changed file in `src/`, then `bun run typecheck` and `bun run lint` in `cli/`. Make sure that they pass.
- [x] 2.2 Run `bun test src/server/routes/runs.test.ts src/modules/harness/prov_bridge.test.ts src/modules/harness/run_deps.test.ts src/modules/harness/agent_switch.test.ts`. Make sure that they pass.
- [x] 2.3 Run the full harness suite one time with `bun test` in `harness/`, with the podman `DOCKER_HOST`. Then run the full cli suite one time with `bun run test` in `cli/`. Make sure that they pass, or record each failure with its cause.

Verification notes:

- 2.1: `bun run lint` passes. `bun run typecheck` reports 3 errors, in `src/modules/harness/prov_bridge.ts:391`, `src/modules/prov/prov.ts:121`, and `src/types/prov.ts:23`. No error is in a file of this change. The cause is the installed copy of `@inflexa-ai/prov-kernel` in `cli/node_modules`, which is older than `prov-kernel/src` (it lacks `ProvPlanApprovalRef` and the status `suspended_insufficient_funds`).
- 2.3 harness: 5811 pass, 49 skip, 0 fail.
- 2.3 cli: 3972 pass, 2 skip, 2 fail. Failure 1: `src/modules/prov/prov.test.ts`, "an approval lands before the start of its run". The same stale kernel copy has no `appendPlanApproved`. Failure 2: `the composed layout stays in parity with the provisioner layout`. The python3 on PATH has no `packaging` module. Neither failure touches the cancel route or the run emit.
