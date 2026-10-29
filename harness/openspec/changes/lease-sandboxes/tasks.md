# Tasks

## 1. sandbox-server

- [x] 1.1 Write each exec record to `{EXEC_RECORD_DIR}/{base64url(execId)}.json` with a temporary file and a rename, at the submit and at the end of the command. Refuse to start when `EXEC_RECORD_DIR` is absent (D9). Do a Go test: a record survives a restart of the server.
- [x] 1.2 At start, read each record file. A `running` record becomes `failed` with `lost: { reason: "sandbox-replaced" }`. A file that the server cannot read becomes a lost record for the id in its name (D9). Do Go tests for the two cases and for a start that a bad file does not stop.
- [x] 1.3 Add the comment on the accepted risk of D9 beside the record writer. The comment states the risk and its bound, and no prompt, skill, or tool description states it.
- [x] 1.4 Give each exec a new `TMPDIR` under `/tmp`, and delete it when the exec ends (D10). Do a Go test: a file that one exec writes to `TMPDIR` is absent in the next exec.
- [x] 1.5 Give the count of running execs in the `GET /health` answer (D7). Do a Go test with one running exec and one completed exec.

## 2. The lease table

- [x] 2.1 Add a migration that makes `cortex_sandbox_leases` with the unique partial index on `lease_key`, and that drops `cortex_step_executions.sandbox_ref` (D18). Do a migration test: the table exists, the column is gone, and a second run changes nothing.
- [x] 2.2 Add the state module of the leases (D4, D5, D6). It holds these operations:
  - the request, and the grant transaction under one advisory lock, in the order of the request time
  - the release, and the change of the machine generation
  - the write of `last_used_at` at most each minute, and the reads of the reconciler

  Do DB tests for the order of the grants, the budget sum, and one active lease for each key.
- [x] 2.3 Remove `state/active-sandboxes.ts` and each write and read of `sandbox_ref`. Do the typecheck.

## 3. The sandbox client

- [x] 3.1 Rename `SandboxSpec.childWorkflowId` to `ownerWorkflowId`, and take the sandbox id from the lease workflow id and the machine generation (D5). Do the adopt tests of both backends with the new owner.
- [x] 3.2 Mount the records directory of the lease read-write at `/mnt/exec-records`, and give `EXEC_RECORD_DIR`, on both backends (D9). Do the mount-plan tests.
- [x] 3.3 Map a server result that carries `lost` to a synthetic failure with the reason `sandbox-replaced`. Do a test of the exec parse.
- [x] 3.4 Hide `.sandbox` from the workspace read tools and from the artifact walk (D9). Do the tests of `list_files`, `grep`, and the walk.

## 4. The lease workflow and the module API

- [x] 4.1 Register the queue of the module and the lease workflow in `assembleCoreRuntime`, with the id `sandboxlease:{analysisId}:{leaseKey}:{generation}` (D2). Do the assembly test.
- [x] 4.2 Write the body of the lease workflow (D2, D4, D7, D8, D11). It holds these parts:
  - the grant, and the label gate with `workPause` under the work of the consumer
  - the keyed spawn, and the event `granted`
  - the tick loop with the owner test, the idle test, and the machine requests
  - the release

  Do DBOS tests: a release wakes the queue, a terminal owner releases the lease, and an idle lease loses its machine and keeps its grant.
- [x] 4.3 Write `acquire`, `release`, and `exec` with the waits of a `DBOSClient`, the cancel read each 10 s, the resize, and the clamp to `perStep` (D1, D3, D4, D6). Do DBOS tests: a rerun of `acquire` finds its lease, and a resize makes the next generation. Also, an exec with no lease gives `no_lease`, and a cancel ends a wait.
- [x] 4.4 Write the mirror of the pause part from the wait of `acquire` to the stream of the consumer (D11). Do a DBOS test: a refused spawn with the suspend flag shows a `data-pause` part in the stream of the step. A resume of the run then grants the lease.
- [x] 4.5 Give a new machine to an exec after a pause and after a death, and run no exec again (D6). Do DBOS tests with a backend double: an exec after an idle removal runs on a new machine, and an out-of-memory kill gives the cause and the limit.
- [x] 4.6 Record the metrics of the wait for a grant, of the spawn time, and of the replacements by cause (D19). Do a test of the recorded values.

## 5. The reconciler

- [x] 5.1 Replace the reaper with the reconciler: remove each machine whose lease workflow is terminal, mark each such lease `released`, and send a release to each lease whose owner is terminal (D17). Do the tests of the sweep.
- [x] 5.2 Register the reconciler in `assembleCoreRuntime`, and remove `registerSandboxReaper` from the exports. Do the export test.

## 6. The agent tools

- [x] 6.1 Add `acquire_sandbox` and `release_sandbox` to the always-on substrate, also under `readOnly` (D12). Each tool gives the id of its workflow as the key and holds no other lifecycle logic. Do the composition tests of the tool list.
- [x] 6.2 Make `execute_command` call `exec(leaseKey, request, emit)`, and change `no_lease` into an error result that names `acquire_sandbox`. Remove the step deadline from its input text. Do the tool tests.

## 7. The consumers

- [x] 7.1 Remove `sandbox.mint`, `sandbox.create`, `sandbox.recheck-alive`, `sandbox.teardown`, and the step deadline from the sandbox-step body. Release the lease at the end of the step and after a failure (D12, D13). Do the DBOS tests of the step workflow.
- [x] 7.2 Make the data profile acquire its lease with `estimateDataProfileResources` before its first exec (D12). Give the same lease to its agent and to the input scan, and release it at the end. Do the DBOS tests of the profile, with a refused spawn that pauses the lease workflow.
- [x] 7.3 Remove `sandbox/step-sandbox.ts`, `derive_table` with its ledger and its prompt text, and the extraction arm with `tasks/extract-values*.ts` (D16). Do a test: a reference on the fall-through path fails with `extraction-unavailable`.

## 8. The plan and the scheduler

- [x] 8.1 Remove `resources` and `timeout` from the plan step, and drop the two keys when a stored plan parses (D15). Do a test of the parse of a stored plan with the old keys.
- [x] 8.2 Remove the resource section of the planner prompt, the ceiling rule of the plan validation, and the resource selection of the ad hoc router. Do the planner and router tests.
- [x] 8.3 Make the scheduler start each step when its dependencies are complete. Remove the budget from the run input and the status `queued` from the contracts (D14). Do the scheduler tests.
- [x] 8.4 Remove each fixed quota from the step briefing and the sandbox standards, and let the grant of `acquire_sandbox` carry the size. Do the prompt snapshot tests.

## 9. The purge

- [x] 9.1 Make the purge cancel the lease workflows of the `sandboxlease:{analysisId}:` prefix, and delete the rows of `cortex_sandbox_leases` of the analysis. Do the purge test.

## 10. The documents and the CLI

- [x] 10.1 Update the sandbox sections of `harness/CLAUDE.md`, `harness/CONTEXT.md`, and `harness/README.md`: the lease, the lease workflow, the reconciler, and the records. Remove the registry and the reaper.
- [x] 10.2 Adapt the CLI: remove `registerSandboxReaper`, the budget of the run trigger, the resource validation of `dev/run.ts`, and the render of `queued`. Run the CLI typecheck and the CLI tests with the linked harness.

## 11. Verification

- [x] 11.1 Run `tsc -p tsconfig.build.json` and the full `bun test` of the harness one time, and the Go tests of sandbox-server.
- [ ] 11.2 On the Docker backend, run a plan with two steps under a budget that fits one step. Make sure that the second step waits for its grant. Pause and resume a step, and make sure that the resume gets a new machine.

## Workflow follow-up

- The managed host removes `registerSandboxReaper` and the budget of its run trigger in its own repository.
- Before the upgrade, stop or finish each active run and each active data profile (refer to the Migration Plan).
- At the archive, update the Purpose of `harness-sandbox-exec`, `docker-sandbox-provider`, `step-execution-tracking`, `adhoc-analysis-execution`, and `dynamic-resource-allocation`, because each names the registry, the reaper, the plan resources, or the step timeout.
- After the archive, delete `openspec/specs/resource-budgeted-scheduling/`, because the change removes each of its requirements.
