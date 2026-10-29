# sandbox-leases Specification

## Purpose
Define the sandbox module of the harness. A consumer holds a sandbox through a lease. The module owns the admission, the spawn, the replacement, the idle removal, and the teardown.

## Requirements

### Requirement: A consumer reaches a sandbox only through a lease

The harness MUST give a sandbox module with three operations: `acquire(session, leaseKey, size)`, `release(leaseKey)`, and `exec(leaseKey, request, emit)`. A consumer MUST NOT call the `SandboxClient`. The consumer gives the lease key. One lease key MUST hold at most one active lease.

#### Scenario: A tool gives the id of its workflow as the key

- **GIVEN** a sandbox step that runs as the workflow `run-1-2`
- **WHEN** its agent calls `acquire_sandbox`
- **THEN** the module gets the lease key `run-1-2`

#### Scenario: A second acquire with the same size gives the same lease

- **GIVEN** a key that holds a granted lease of `{ cpu: 2, memoryGb: 8 }`
- **WHEN** a consumer acquires `{ cpu: 2, memoryGb: 8 }` for the same key
- **THEN** the module gives the same lease, and it makes no new lease

### Requirement: Acquire returns when the machine is ready

`acquire` MUST return only after the grant, when a machine of the lease answers `/health`. It MUST give the granted size. While it waits, it MUST read the status of the workflow of the consumer at most one time in each 10 s. On `CANCELLED`, it MUST throw `DBOSWorkflowCancelledError`.

#### Scenario: A granted lease gives its size

- **GIVEN** a budget with free capacity
- **WHEN** a consumer acquires `{ cpu: 2, memoryGb: 8 }`
- **THEN** `acquire` gives the granted size `{ cpu: 2, memoryGb: 8 }` after the machine answers `/health`

#### Scenario: A cancel ends the wait

- **GIVEN** a consumer whose `acquire` waits in the queue
- **WHEN** an operator cancels the workflow of the consumer
- **THEN** `acquire` throws `DBOSWorkflowCancelledError` within 10 s

### Requirement: An acquire with a different size replaces the lease

When a key holds an active lease and a consumer acquires a different size, the module MUST release the active lease. Then it MUST make the next generation of the lease with the new size. The new request MUST wait in the queue as each other request.

#### Scenario: A larger size after an out-of-memory kill

- **GIVEN** a key with a granted lease of `{ cpu: 2, memoryGb: 8 }`
- **WHEN** the consumer acquires `{ cpu: 2, memoryGb: 16 }`
- **THEN** the machine of the first lease goes away, and the next generation gets `{ cpu: 2, memoryGb: 16 }`

### Requirement: Acquire and release are idempotent

A rerun of `acquire` MUST find the active lease of its key, and it MUST make no second lease. A rerun of `release` for a key with no active lease MUST do nothing. An `acquire` after a release MUST make the next generation of the lease.

#### Scenario: A recovered tool step finds its lease

- **GIVEN** an `acquire_sandbox` call whose lease the module granted, and then the host stopped before the checkpoint of the step
- **WHEN** the step runs again on recovery
- **THEN** `acquire` gives the same lease, and no second machine starts

#### Scenario: An acquire after a release

- **GIVEN** a key whose lease of the generation 1 was released
- **WHEN** the consumer acquires again
- **THEN** the module makes the lease of the generation 2

### Requirement: Each lease has one detached lease workflow

The module MUST start one DBOS workflow for each generation of a lease, with the id `sandboxlease:{analysisId}:{leaseKey}:{generation}`. The lease workflow MUST NOT be a child of the consumer. Thus a cancel of the consumer does not cancel it.

#### Scenario: A cancel of a run leaves the lease workflow

- **GIVEN** a run whose step holds a granted lease
- **WHEN** the run canceler cancels the run with each child
- **THEN** the lease workflow stays active, and it releases the lease when it finds the owner terminal

### Requirement: The grant admits a lease against one budget

When the `ResourcePolicy` has a budget, a lease MUST get its grant only when the granted leases and the request fit the budget. The budget MUST cover each lease of each consumer. The module MUST grant in the order of the request time. With no budget, the module MUST grant each request at once.

#### Scenario: Two runs share the budget

- **GIVEN** a budget of `{ cpu: 4, memoryGb: 16 }`, and a lease of `{ cpu: 4, memoryGb: 16 }` that a step of the run A holds
- **WHEN** a step of the run B acquires `{ cpu: 1, memoryGb: 2 }`
- **THEN** the request of the run B waits until the lease of the run A ends

#### Scenario: An older request goes first

- **GIVEN** a full budget, a waiting request R1 of `{ cpu: 4, memoryGb: 16 }`, and a later waiting request R2 of `{ cpu: 1, memoryGb: 2 }`
- **WHEN** a release frees `{ cpu: 2, memoryGb: 8 }`
- **THEN** R2 does not get a grant before R1

#### Scenario: No budget grants at once

- **GIVEN** no `ResourcePolicy`
- **WHEN** five consumers acquire at the same time
- **THEN** each lease gets its grant with no wait

### Requirement: A release removes the machine and frees the capacity

On a release, the lease workflow MUST remove the machine of the lease and delete the exec records of the lease. Then it MUST mark the lease `released`, free its capacity, and wake the waiting requests. Then the lease workflow ends.

#### Scenario: A release wakes the queue

- **GIVEN** a full budget, and a waiting request
- **WHEN** a consumer releases its lease
- **THEN** the machine of the released lease goes away, and the waiting request gets its grant

### Requirement: The lease ends when its owner ends

The lease workflow MUST read the status of the owner workflow at each tick. When the status is terminal, the lease workflow MUST release the lease. A lease that waits in a pause MUST also end when its owner ends. A run cancel MUST end the leases of the canceled workflows at once, without a wait for the next tick.

#### Scenario: A run cancel removes the machines at once

- **GIVEN** a run whose step holds a lease with a machine that runs a command
- **WHEN** a host cancels the run
- **THEN** the canceler ends the lease of the step before the cancel returns, and the machine and its command go away without a wait for a tick

#### Scenario: A step that fails without a release

- **GIVEN** a step whose workflow ends with `ERROR` while it holds a lease
- **WHEN** the lease workflow reaches its next tick
- **THEN** the lease workflow releases the lease, and the machine goes away

### Requirement: An idle lease loses its machine and keeps its grant

A lease is idle when no exec runs on its machine, and no exec used the lease for the idle period. The idle period is a configuration value. An idle lease MUST lose its machine, and it MUST keep its grant.

#### Scenario: A paused step holds no machine

- **GIVEN** a step that holds a lease and waits in a pause for longer than the idle period
- **WHEN** the lease workflow finds the lease idle
- **THEN** the machine goes away, and the lease stays granted

#### Scenario: A command that runs keeps the machine

- **GIVEN** a command that runs for longer than the idle period, while the host is down
- **WHEN** the lease workflow tests the lease
- **THEN** sandbox-server counts one running exec, and the machine stays

### Requirement: An exec gets a machine of its lease

`exec` with no active lease MUST give the error `no_lease`, and it MUST submit nothing. The exec id MUST be the SHA-256 of the exec salt of the lease and the step key (the workflow id and the function id of the step). Thus a recovered step gives the same id, and a command in the sandbox cannot find the id of a later exec. When the lease has no live machine, `exec` MUST get a new machine from the lease workflow before it submits. The consumer does not see the new machine.

#### Scenario: An exec with no lease

- **WHEN** a sandbox agent calls `execute_command` before `acquire_sandbox`
- **THEN** the tool gives an error result that names `acquire_sandbox`, and no command runs

#### Scenario: A command cannot find the id of a later exec

- **GIVEN** a command that reads the exec records of its lease
- **WHEN** it computes an id from the ids in the records
- **THEN** the id is not the id of a later exec of the lease, because the host derives each id from the salt of the lease

#### Scenario: An exec after a pause

- **GIVEN** a lease whose machine went away during a pause
- **WHEN** the agent calls `execute_command` after the resume
- **THEN** a new machine starts, the command runs on it, and the result holds no note of the replacement

### Requirement: A death during an exec reaches the agent

When the machine dies during an exec, that exec MUST give a synthetic failure with the cause and the memory limit of the grant. The module MUST NOT run the exec again. The next exec of the lease MUST get a new machine. The files of the analysis stay.

#### Scenario: An out-of-memory kill

- **GIVEN** a lease of `{ cpu: 2, memoryGb: 8 }` whose command exceeds the memory limit
- **WHEN** the exec ends
- **THEN** the result carries the reason `sandbox-oom-killed` and the limit of 8 GB
- **AND** the next exec runs on a new machine of the same size

### Requirement: The exec records of a lease survive a replacement

The module MUST give each lease one directory of exec records, outside each write tree of the workspace. It MUST mount the directory read-write into each machine of the lease. The workspace tools and the artifact walk MUST NOT show the directory. The release MUST delete it.

#### Scenario: A new machine gives the first result

- **GIVEN** a command that completed after the host stopped, and a machine that went away before the host started again
- **WHEN** the recovered exec submits the same exec id on the new machine
- **THEN** the new machine gives the result of the first command, and the command does not run again

#### Scenario: The workspace tools do not show the records

- **WHEN** an agent lists the root of the analysis
- **THEN** the list holds no directory of exec records

### Requirement: A refused spawn pauses the lease workflow

The lease workflow MUST call the label gate before each spawn. A refusal with the suspend flag MUST pause the lease workflow under the work of the consumer. `acquire` MUST continue to wait, and it MUST write the pause part to the stream of the consumer. A refusal with no suspend flag MUST end the lease, and `acquire` MUST give `refused` with the reason of the host.

#### Scenario: A resume of the run reaches the lease workflow

- **GIVEN** a label hook that gives `err({ reason: "account_frozen", suspend: true })` and then `ok`
- **WHEN** a step acquires a lease, and the user resumes the run
- **THEN** the lease workflow pauses under the run before the first spawn, and the resume lets it spawn the machine

#### Scenario: The stream of the consumer shows the pause

- **GIVEN** a lease workflow that pauses at the label gate
- **WHEN** the `acquire_sandbox` call of the step waits
- **THEN** the stream of the step holds a `data-pause` part of the lease workflow, and the part reads `running` after the resume

#### Scenario: A refusal with no suspend flag

- **GIVEN** a label hook that gives `err({ reason: "no_quota", suspend: false })`
- **WHEN** a step acquires a lease
- **THEN** `acquire` gives `refused` with the reason `no_quota`, and no machine starts

### Requirement: Acquire takes only a session that can go into a workflow input

`acquire` MUST take the spawn session of a run step or of a data profile. The input of the lease workflow MUST carry that session, because the label gate reads it at each spawn. A request session MUST NOT go into the input.

#### Scenario: A data profile acquires

- **WHEN** the data-profile body acquires its lease
- **THEN** the lease workflow input carries the run session of the profile

### Requirement: A reconciler removes each machine that no live lease owns

The harness MUST register a scheduled reconciler that runs each 5 minutes. It MUST remove each managed machine whose lease workflow is terminal. It MUST mark `released` each lease whose lease workflow is terminal. It MUST send a release to each lease whose owner is terminal. A machine whose owner does not resolve MUST be removed only when a liveness probe finds it dead.

#### Scenario: An operator cancels a lease workflow

- **GIVEN** a lease workflow that an operator canceled while it held a machine
- **WHEN** the reconciler runs
- **THEN** the machine goes away, and the lease row is `released`

#### Scenario: A live machine with no resolved owner stays

- **GIVEN** a managed machine whose owner does not resolve, and a liveness probe that finds it alive
- **WHEN** the reconciler runs
- **THEN** the machine stays, and the summary of the sweep counts it

### Requirement: The lease table records each lease

The table `cortex_sandbox_leases` MUST hold one row for each lease workflow. The row MUST hold the lease key, the generation, the analysis, the owner workflow, and the work of the owner. It MUST hold the requested size, the granted size, the state, the current machine, and the machine generation. It MUST hold the exec salt, a random value that the database makes at the request and that no machine receives. It MUST hold no exec id.

#### Scenario: One active lease for each key

- **GIVEN** a key with a lease in the state `granted`
- **WHEN** a second row with the same key and the state `requested` is written
- **THEN** the database refuses the row

### Requirement: The module measures the cold start

For each backend, the module MUST record the wait from a request to its grant. It MUST also record the time from a spawn to the health of the machine. It MUST count each machine replacement by its cause.

#### Scenario: A spawn records its duration

- **WHEN** a machine of a lease answers `/health`
- **THEN** the module records the duration from the spawn, with the backend as an attribute

### Requirement: A sandbox agent acquires and releases its sandbox with two tools

A sandbox agent MUST get `acquire_sandbox` and `release_sandbox`. `acquire_sandbox` takes `cpu`, `memoryGb`, and an optional `gpuCount`, and it gives the granted size. `release_sandbox` takes no input. Each tool MUST give the id of its workflow as the lease key, and it MUST hold no other lifecycle logic.

#### Scenario: The grant gives the clamped size

- **GIVEN** a per-step ceiling of 16 GB
- **WHEN** an agent calls `acquire_sandbox({ cpu: 2, memoryGb: 64 })`
- **THEN** the result gives the granted `memoryGb` of 16

#### Scenario: A release frees the lease before the step ends

- **WHEN** an agent calls `release_sandbox` and then continues to write files
- **THEN** the machine goes away, and a later `execute_command` gives the error result that names `acquire_sandbox`

### Requirement: The resource policy gives the per-step ceiling and the lease budget

The harness MUST define `ResourcePolicy` in `config/resource-limits.ts`:

```typescript
type ResourcePolicy = {
  perStep: ResourceLimits;
  budget: { cpu: number; memoryGb: number };
}
```

The policy is embedder-supplied at the composition root and optional. The `budget` is the budget of the lease grant, and it covers each lease of each consumer (see the sandbox-leases capability). An embedder that supplies no policy gets a grant at once for each lease, plus the historical per-step defaults.

When a policy is supplied, construction MUST reject one
where `perStep.maxCpu > budget.cpu` or
`perStep.maxMemoryGb > budget.memoryGb`. The module clamps each lease request to `perStep`, thus a clamped request always fits an empty budget. `budget.cpu` and `budget.memoryGb` MUST be positive
numbers. The policy MUST NOT contain an execution-mode-specific resource
field.

#### Scenario: Valid policy accepted

- **WHEN** a policy with `perStep: { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 }` and `budget: { cpu: 8, memoryGb: 16 }` is constructed
- **THEN** construction succeeds

#### Scenario: Per-step ceiling exceeding the budget is rejected

- **WHEN** a policy with `perStep.maxMemoryGb: 32` and `budget.memoryGb: 16` is constructed
- **THEN** construction throws a configuration error naming the violated invariant

#### Scenario: Resource policy has no ephemeral value

- **WHEN** configuration includes an `ephemeral` resource value
- **THEN** the resolved `ResourcePolicy` contains no `ephemeral` field and no special execution budget is supplied

#### Scenario: No policy grants each lease at once

- **GIVEN** an embedder that supplies no `ResourcePolicy`
- **WHEN** some consumers acquire a lease at the same time
- **THEN** each lease gets its grant with no wait for capacity
