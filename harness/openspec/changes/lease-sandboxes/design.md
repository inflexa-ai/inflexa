# Design

## Context

See proposal.md for the motivation. These facts of the current code shape the approach:

- The sandbox-step workflow makes its machine in two body steps, `sandbox.mint` and `sandbox.create`, and it removes the machine in `sandbox.teardown` at the end. A paused step keeps its machine, because a pause keeps the workflow `PENDING`.
- The reaper removes a machine only when the owner workflow is terminal. Thus the reaper never removes the machine of a paused step.
- DBOS 5.3 throws when a step calls `DBOS.recv` or `DBOS.getEvent`. Each tool call of the loop is a step. A `DBOSClient` works inside a step: the run launcher enqueues a run with it from a tool step, and the run is not a child of the caller.
- A machine keeps almost no state. sandbox-server runs each exec as a new process. The analysis tree, the package store, and the reference data are mounts. Only `/tmp` and the in-memory exec records are local to the machine.
- sandbox-server and each command run as uid 1000, and the pod drops each capability. A command can thus write each file that sandbox-server can write.
- The managed label hook resolves its labels with the credential of the session. A run session is a durable reference to the run credential, and it can go into a workflow input. A request session cannot.

## Goals / Non-Goals

**Goals:**

- One module owns the lifecycle of each sandbox, for each consumer.
- The end of a consumer, for any reason, removes its machine.
- A pause holds no machine, and a resume gets a new machine with no action of the agent.
- The agent selects the size of its sandbox, and the agent learns each death of a machine during an exec.

**Non-Goals:**

- No sharing of a machine between consumers.
- No pool of machines that start before a request.
- No change of the exec protocol between the host and sandbox-server, apart from the records and the count of running execs.
- No admission of the model requests of a step. The budget controls only the sandboxes.

## Decisions

### D1. A sandbox module with three operations

The module gives `acquire(session, leaseKey, size)`, `release(leaseKey)`, and `exec(leaseKey, request, emit)`. A consumer calls only these operations. The `SandboxClient` becomes internal to the module, and the embedder still makes it and gives it to `assembleCoreRuntime`.

The consumer gives the lease key. A tool gives the id of its workflow. One key holds at most one active lease.

Alternative: keep the client in each consumer. Rejected, because each consumer then has its own copy of the lifecycle and of its edge cases.

### D2. One detached lease workflow for each generation of a lease

`acquire` enqueues the lease workflow through a `DBOSClient` on the queue of the module. The id of the workflow is `sandboxlease:{analysisId}:{leaseKey}:{generation}`. Thus a rerun of `acquire` finds the same workflow, and a purge finds the workflows of an analysis by the prefix.

The body of the lease workflow:

1. It waits for its grant (D4).
2. It runs the label gate and spawns the machine in steps (D5, D11).
3. It sets the event `granted` with the granted size.
4. It loops on `DBOS.recv` with a timeout of one tick (60 s). A message asks for a machine or for the release. At each tick, it does the owner test (D8) and the idle test (D7).
5. On a release, it removes the machine, deletes the exec records, frees the capacity, sends `capacity` to the next waiting leases, and ends.

The lease workflow is not a child of its consumer. Thus a cancel of the consumer does not cancel it, and its teardown step can run.

Alternatives:

- A child workflow of the consumer. Rejected, because the cancel of a run cancels each child, and a canceled workflow cannot run a step.
- One broker workflow for all leases. Rejected, because its log grows with no limit, and it is one point of failure.
- A lease table with waits outside DBOS. Rejected, because the waits then must have a mechanism of their own.

### D3. The waits of a consumer use a DBOS client

`acquire` and `exec` run inside a step. They wait with `DBOSClient.getEvent` on the lease workflow, in a loop. The loop reads the status of the consumer workflow at most each 10 s, and it throws `DBOSWorkflowCancelledError` on `CANCELLED`. This is the same rule as the poll loop of an exec. A caller in a workflow body wraps the call in a step.

### D4. Admission at the grant, with one budget

The budget is `ResourcePolicy.budget`, read from the configuration at each grant. The grant is a transaction in a step of the lease workflow:

1. It takes one advisory lock.
2. It sums the sizes of the granted leases.
3. It grants the request only when the request is the oldest waiting request and the request fits.

A release sends `capacity` to the waiting leases. A waiting lease also tries again at each tick, thus a lost message delays a grant by one tick only. With no budget, the lease workflow grants at once.

`acquire` clamps the size to `perStep` before the admission. `perStep` is never above the budget, thus each clamped request fits an empty budget, and no request waits for capacity that cannot exist.

Alternative: the skip-over order of the current scheduler. Rejected, because a large request that an agent selects can then wait with no limit behind small requests. The strict order gives up some use of the capacity.

### D5. Machine generations inside a lease

The lease row holds the current machine and a machine generation. The sandbox id comes from a key: the id of the lease workflow and the machine generation. Thus a rerun of the spawn step adopts the same machine, and no `sandbox.mint` step is necessary.

A new machine increments the generation, in the same transaction that clears the old machine. An exec that meets a removal reads the new generation, and it asks for a machine again.

### D6. The path of an exec

`exec(leaseKey, request, emit)`:

1. It reads the lease row. With no active lease, it gives the error `no_lease`. The tool changes that error into an error result that names `acquire_sandbox`.
2. With no live machine, it sends `machine` to the lease workflow, and it waits for the event of the next machine generation.
3. It writes `last_used_at` on the lease row before the submit. Then it submits the command and polls, as today. While a command runs, the count of running execs in the health answer keeps its machine (D7).

A machine that dies during the exec gives the synthetic failure of today, with the memory limit of the grant. The exec sends `machine` to the lease workflow, thus the next exec gets a new machine. The module runs no exec again.

The deadline of an exec is the timeout of its command plus a grace for the poll. A command with no timeout gets the default command timeout. A step has no deadline of its own (D13).

### D7. The idle removal

At each tick, the lease workflow reads `last_used_at`, and it asks sandbox-server for the count of running execs (`GET /health`). The lease is idle when no exec runs and `last_used_at` is older than the idle period. The idle period is a configuration value with the default of 15 minutes. An idle lease loses its machine and keeps its grant.

The count of running execs is necessary. A host that restarts stops its polls, but the command continues. Without the count, the idle removal can stop a command that runs. A health answer with no count, from an image older than this change, reads as busy.

### D8. The end of the owner

At each tick, the lease workflow reads the status of the owner workflow. A terminal status releases the lease. The reconciler also sends a release to each lease whose owner ended, for a lease workflow that waits in a pause.

### D9. The exec records of a lease

sandbox-server writes each record to `{EXEC_RECORD_DIR}/{base64url(execId)}.json`, with a write to a temporary file and a rename. It writes the record at the submit and at the end of the command. At start, it reads each file:

- A `running` record becomes `failed` with the reason `sandbox-replaced`.
- A file that it cannot read becomes a lost record for the exec id in the file name.

The directory is `{analysisRoot}/.sandbox/exec-records/{hash(leaseKey)}`. The module mounts it read-write at `/mnt/exec-records` in each machine of the lease. The workspace tools and the artifact walk skip `.sandbox`. The lease workflow deletes the directory at the release.

Accepted risk: a command can change a record, because it runs under the uid of sandbox-server. A changed record changes only the result of an exec of the same lease, after a replacement. The same command can already write a false output, and a command can already submit an exec to its own sandbox-server through loopback. The flat read-only mount of the analysis also shows the records of the other leases of the analysis.

A comment in the sandbox-server source states this risk. No prompt, skill, or tool description states it.

Alternative: a second uid for the commands. Rejected, because sandbox-server then must hold `CAP_SETUID`, `CAP_SETGID`, and `CAP_KILL`, and the pod drops each capability today.

### D10. A temporary directory for each exec

sandbox-server makes a new directory under `/tmp` for each exec, gives it as `TMPDIR`, and deletes it when the exec ends. Thus no exec can keep state for a later exec outside the mounts. The caches that the entrypoint copies to `/tmp` stay, because each new machine makes them again.

### D11. The label gate in the lease workflow

The input of the lease workflow carries the spawn session of the consumer. The lease workflow runs the label gate before each spawn:

- A refusal with the suspend flag pauses the lease workflow with `workPause`, under the work id, the work kind, and the analysis of the consumer. The resume of that work reaches the lease workflow, and `acquire` continues to wait.
- `DBOS.writeStream` writes only to the stream of its own workflow, and a host reads the streams of the run and of its steps. Thus the wait of `acquire` reads the pause row of its lease workflow, and it writes the `data-pause` part to the stream of the consumer.
- A refusal with no suspend flag ends the lease with the reason of the host, and `acquire` gives `refused`.

`acquire` takes only a session that can go into a workflow input: the session of a run step or of a data profile. The report-session derivation and the value extraction were the consumers with a request session, and this change removes them (D16).

### D12. The agent tools

The always-on substrate of a sandbox agent gets two tools:

- `acquire_sandbox({ cpu, memoryGb, gpuCount? })` gives the granted size. A second call with a different size replaces the lease and waits in the queue again.
- `release_sandbox()` releases the lease.

Each tool gives the id of its workflow as the lease key, and the session of its call. It holds no other logic. The tool description tells what the tool does and what it gives. The order "acquire before exec" is a rule of the code: `execute_command` with no lease gives an error result.

The sandbox-step body does not acquire. It releases the lease at the end of the step, also after a failure. The data-profile body acquires with `estimateDataProfileResources` before its first exec, and its agent uses the same lease.

### D13. No step deadline

The plan step loses `timeout`, and `DEFAULT_STEP_TIMEOUT_SECONDS` goes away. The pause, the cancel, the stop of a work, the idle removal, and the timeout of each command bound the work. A wait for a grant then uses up no time of the step.

### D14. The scheduler starts each ready step

The scheduler starts a step when its dependencies are complete. The run input holds no budget. The DAG status `queued` goes away. The wait of a step for its grant shows as the activity of its `acquire_sandbox` call.

### D15. The plan carries no resources

`PlanStepSchema` loses `resources` and `timeout`. The parse of a stored plan drops the two keys. The planner prompt loses its section on the resources, the plan validation loses the ceiling rule, and the ad hoc router selects no resources.

### D16. The removal of the derivation and of the extraction

The report session loses `derive_table`, and the report-value resolution loses its sandbox arm. A reference that falls through then fails with `extraction-unavailable`, as the report-value-resolution spec gives for an absent arm. The report refactor removes the same parts.

### D17. The reconciler

The reconciler replaces the reaper, with the same sweep each 5 minutes. The owner of a machine is its lease workflow. The reconciler also does these tasks:

- It marks each lease row released whose lease workflow is terminal. Thus a lease workflow that an operator canceled frees its capacity.
- It sends a release to each lease whose owner workflow is terminal.

`assembleCoreRuntime` registers the reconciler. The embedder no longer registers it.

### D18. The lease table

`cortex_sandbox_leases` has one row for each lease workflow:

- `lease_workflow_id` (the primary key), `lease_key`, `generation`, and `analysis_id`
- `owner_workflow_id`, `work_kind`, and `work_id`
- `requested` and `granted`, each a size
- `state`: `requested`, `granted`, or `released`, with `release_reason`
- `machine` (`{ sandboxId, host, port, backend }`) and `machine_generation`
- `requested_at`, `granted_at`, `last_used_at`, and `released_at`

A unique partial index on `lease_key` for the rows that are not `released` keeps one active lease for each key. The row holds no secret and no exec id.

### D19. Metrics

The module records two durations for each backend:

- the wait from the request to the grant
- the time from the spawn to the health of the machine

It counts each machine replacement by its cause: idle, death, out of memory, and release. These metrics show if a cold start is a problem.

## Edge cases

| Case | What the module does |
|-|-|
| The consumer recovers after a crash | `acquire` runs again, finds the same lease, and `getEvent` answers at once. A recovered exec submits the same exec id, and the records give the first result. |
| The consumer pauses | The idle removal takes the machine and keeps the grant. The next exec after the resume gets a new machine. |
| The consumer is canceled or stopped | The owner test releases the lease at the next tick. The reconciler is the backstop. |
| The consumer ends without a release | The same as a cancel. The sandbox-step body also releases at the end of the step. |
| An acquire after a release | The key finds no active lease. `acquire` makes the next generation, with a new workflow id. |
| An acquire with a different size | `acquire` releases the active lease, and it makes the next generation with the new size. |
| The step of an acquire runs again after a resize | The rerun finds the active lease with the requested size, and it gives that lease. |
| The label gate refuses with the suspend flag | The lease workflow pauses under the work of the consumer, and `acquire` waits. |
| The machine dies during an exec | That exec gives the cause and the memory limit. The next exec gets a new machine. |
| The machine dies between two execs | The next exec gets a new machine. The agent sees nothing. |
| The host restarts during a long command | The count of running execs keeps the machine. The recovered exec attaches to the command. |
| The machine is replaced during a host restart | The new machine marks the record of the command `failed` with `sandbox-replaced`. The recovered exec gives that result. |
| An idle removal meets a new exec | The machine generation changes in one transaction. The exec asks for a machine again. |
| An operator cancels a lease workflow | The reconciler marks the row released and removes the machine. |
| The request is above the per-step ceiling | `acquire` clamps the size, and the result gives the clamped size. |
| A purge of the analysis | The purge cancels the lease workflows by their prefix and deletes the lease rows. The reconciler removes the machines. |

## Risks / Trade-offs

- [The scheduler starts each ready step of a wide plan at one time.] → More model requests run in parallel. The provider retry envelope and the pause cover a rate limit, and a cap on the parallel steps can come later.
- [The strict order of the grants leaves some capacity unused.] → A small request waits only behind older requests, and a release wakes the queue.
- [An idle lease keeps its grant, thus a long pause holds local capacity.] → The machine goes away, and only the reservation stays. A release of the grant at a pause can come later.
- [An agent selects a size that is too large.] → The clamp to `perStep`, and the metrics of the wait.
- [A model round that is longer than the idle period removes the machine.] → The next exec pays a cold start, and the agent sees nothing.
- [A lease workflow of many hours writes one operation for each tick.] → A tick of 60 s gives about 1,000 operations for each 10 hours of a lease.
- [A command can change the exec records of its lease.] → Refer to D9.

## Migration Plan

1. The migration adds `cortex_sandbox_leases` and drops `cortex_step_executions.sandbox_ref`. It is forward-only, as each migration of the harness.
2. The deploy runs during a downtime, with no `DBOS.patch`. A workflow that is active at the upgrade fails at its next replay. Stop or finish each active run and each active data profile before the upgrade.
3. The reconciler removes each machine of the old code, because the old owner workflow of the machine is terminal after step 2.
4. The CLI and the managed host remove `registerSandboxReaper` and the budget of the run trigger in the same release.

For a rollback, the column `sandbox_ref` is necessary again. Thus a rollback restores the database from a backup, or it adds the column back by hand.
