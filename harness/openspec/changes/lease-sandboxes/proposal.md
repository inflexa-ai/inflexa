# Proposal

## Why

A sandbox lives as long as the workflow that made it. A pause, a cancel, and a crash break that link. A paused step keeps its machine for the whole pause, and no step can get a new machine after the cluster evicts the old one. A canceled workflow cannot remove its own machine. Each consumer also has its own copy of the lifecycle code.

## What Changes

- A new sandbox module owns the lifecycle of each sandbox. A consumer acquires a lease, runs its execs on the lease, and releases the lease. The module owns the admission, the spawn, the replacement, the idle removal, and the teardown. A consumer holds no lifecycle logic.
- Each generation of a lease has one detached DBOS workflow, the lease workflow. The end of the consumer does not end the lease workflow, thus the lease workflow always removes its machine.
- A machine is replaceable. The state of a lease is its files, its exec records, and the checkpoints of its consumer. sandbox-server writes each exec record to a directory on the volume of the analysis files, and it reads the records again when it starts.
- An idle lease loses its machine and keeps its grant. The next exec gets a new machine, and the agent does not see the replacement.
- When a machine dies during an exec, the result of that exec gives the cause. The next exec gets a new machine. The module runs no exec again.
- Each exec gets its own temporary directory, and sandbox-server deletes the directory when the exec ends.
- **BREAKING** The step agent selects the size of its sandbox with the new tools `acquire_sandbox` and `release_sandbox`. An exec with no lease gives an error result that names `acquire_sandbox`.
- **BREAKING** A plan step carries no resources. The planner, the plan validation, and the ad hoc router do not estimate resources.
- **BREAKING** The run scheduler starts each step when its dependencies are complete. The admission against the machine budget moves to the lease grant, with one budget for all consumers. With no budget, the module grants each request at once. The DAG status `queued` goes away.
- **BREAKING** The lease table `cortex_sandbox_leases` replaces the active-sandbox registry, and the column `cortex_step_executions.sandbox_ref` goes away.
- **BREAKING** A sandbox reconciler replaces the sandbox reaper. `assembleCoreRuntime` registers the lease workflow and the reconciler, and the export `registerSandboxReaper` goes away.
- A label-gate refusal with the suspend flag pauses the lease workflow under the work of its consumer. The resume of that work reaches the lease workflow.
- The data profile uses the same module. `withStepSandbox` and the lifecycle steps of the sandbox-step workflow go away.
- **BREAKING** The report session loses `derive_table`, and the report-value resolution loses its sandbox arm. These were the only consumers with a request session, and the report refactor removes them too.
- **BREAKING** A step has no deadline. The plan step loses `timeout`, and each command has its own timeout.
- A purge of an analysis removes its leases and its lease workflows.

## Capabilities

### New Capabilities

- `sandbox-leases`: the sandbox module. It covers these parts:
  - the lease API, the lease workflow, and the lease table
  - the admission, the idle removal, and the machine replacement
  - the exec records of a lease, and the pause at the label gate
  - the reconciler, and the two agent tools

### Modified Capabilities

- `harness-sandbox-exec`: only the sandbox module calls the `SandboxClient`. The active-sandbox registry, the liveness probe at recovery, and the reaper go away. The spawn identity comes from the lease workflow.
- `sandbox-server`: the exec records go to a directory and survive a restart. Each exec gets its own temporary directory. The health answer counts the running execs.
- `sandbox-labels`: the owner workflow of a machine is its lease workflow.
- `docker-sandbox-provider`: the owner guard and the managed-machine list use the lease workflow, and the reconciler reads the list.
- `resource-budgeted-scheduling`: the scheduler admits no step against a budget. The run input holds no budget, and the DAG status `queued` goes away.
- `dynamic-resource-allocation`: the clamp applies to the size of a lease request. A step has no deadline, and each command has a timeout.
- `planning-enhancements`: the planner prompt and the plan validation carry no resource ceiling, and the planner reports no resource shortfall.
- `adhoc-analysis-execution`: the router selects no resources, and the internal step carries none.
- `step-execution-tracking`: `sandbox_ref` goes away from `cortex_step_executions`.
- `work-pause`: the label gate of a spawn is in the lease workflow. The derivation of a chat turn goes away.
- `tool-rerun-safety`: the derivation and the extraction go away.
- `report-value-resolution`: the sandbox arm goes away, thus a reference that falls through fails with `extraction-unavailable`.
- `report-verification`: the derivation records and their prune go away.
- `provenance-seam`: the derivation event goes away.
- `data-profile-init`: the profile acquires a lease with its estimated size. The lease workflow pauses at a refused spawn.
- `harness-sandbox-agents`: the always-on substrate holds `acquire_sandbox` and `release_sandbox`.
- `analysis-purge`: the purge removes the leases and the lease workflows of the analysis. The reconciler replaces the reaper in the list of the work that the purge does not reach.

## Impact

- Harness:
  - a new sandbox module under `src/sandbox/`, with the lease workflow, the lease table, the reconciler, and the two tools
  - removed: `sandbox/step-sandbox.ts`, `sandbox/reaper.ts`, `state/active-sandboxes.ts`, and the lifecycle steps of `workflows/sandbox-step.ts`
  - changed consumers: `workflows/sandbox-step.ts`, `tasks/data-profile.ts`, and `tools/workspace/execute-command.ts`
  - removed consumers: `tools/report-session/derive-table.ts`, `tasks/extract-values.ts`, and the derivation ledger, with the report-session prompt text that teaches the derivation
  - the scheduler and the run input: `workflows/execute-analysis*.ts` and `tools/execute-analysis.ts`
  - the plan: the plan schema, the plan validation, `tools/research/generate-plan.ts`, the ad hoc router, and their prompts
  - the step prompts: the sandbox standards and the briefing name no fixed quota
  - `contracts/chat-parts.ts` (`queued`), `runtime/assemble.ts`, `index.ts`, and the analysis purge
  - a migration that adds `cortex_sandbox_leases` and drops `cortex_step_executions.sandbox_ref`
- sandbox-server: the records directory, the load at start, the temporary directory of each exec, and the count of the running execs in the health answer.
- CLI: the CLI removes `registerSandboxReaper`, the budget of the run trigger, the resource validation of `dev/run.ts`, and the render of `queued`.
- The managed host: it removes `registerSandboxReaper`. Its label hook does not change.
- Stored plans: the parse of a stored plan step drops its `resources`.
