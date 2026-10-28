## MODIFIED Requirements

### Requirement: SandboxClient exposes seven backend-selected operations

The harness MUST expose a `SandboxClient` type with exactly seven
operations: `createSandbox(session, spec, identity) → ResultAsync<SandboxRef, SandboxError>`,
`exec(ref, request, emit, deadline) → ExecResult`, `isAlive(ref) → SandboxLiveness`,
`isAliveById(sandboxId) → SandboxLiveness`, `teardown(ref) → void`,
`teardownById(sandboxId) → void`, and `listManagedSandboxes() → ManagedSandbox[]`.
A `createSandboxClient()` factory MUST select the Docker (dev) or K8s (prod)
implementation from the `SANDBOX_BACKEND` value. The client MUST be injected at
the composition root as a construction-time dependency. A caller MUST NOT import
a backend implementation directly, and the client type MUST NOT leak a
backend-specific type.

Only the sandbox module calls the client (see the sandbox-leases spec). A consumer of a sandbox
MUST NOT call the client. It holds a lease, and the module calls the client for it.

`createSandbox` MUST take the `SpawnSession` of the work, a `RunSession` whose
`runFrame.stepId` is present. Thus a spawn without a session does not compile. The client MUST
read the analysis id from `session.scope.analysisId`, the run id from `session.runFrame.runId`,
and the step id from `session.runFrame.stepId`.

`SandboxSpec` holds the other fields of the
spawn: `ownerWorkflowId`, `image`, `extraEnv`, `resources`, `readOnly`, and `writableTail`.
`ownerWorkflowId` is the id of the lease workflow that spawns the machine.
`SandboxSpec` carries no label, because the client gets the host labels from its
label hook (see the sandbox-labels spec). `SandboxSpec` carries no exec id.

`createSandbox` MUST give each `SandboxError` as an `err` value, and it MUST NOT throw it. Thus
the caller reads a refusal that asks for a suspension with no `catch`. A caller that must fail
its DBOS step throws the error through `unwrapOrThrow`.

#### Scenario: A failed spawn is a value

- **GIVEN** a spawn that the backend refuses
- **WHEN** a caller runs `createSandbox(session, spec, identity)`
- **THEN** the result is an `err` that carries the `SandboxError` variant
- **AND** the client throws nothing

#### Scenario: Docker backend selected in dev

- **GIVEN** `SANDBOX_BACKEND=docker`
- **WHEN** `createSandboxClient()` is called
- **THEN** the returned client is the Docker implementation
- **AND** `createSandbox` launches a `sandbox-base` container with its exec port published to `127.0.0.1` only

#### Scenario: K8s backend selected in prod

- **GIVEN** `SANDBOX_BACKEND=k8s`
- **WHEN** `createSandboxClient()` is called
- **THEN** the returned client is the K8s implementation
- **AND** `createSandbox` makes a K8s Job whose pod runs `sandbox-base`

#### Scenario: Interface surface is the seven operations

- **WHEN** a consumer imports `SandboxClient`
- **THEN** the type exposes exactly `createSandbox`, `exec`, `isAlive`, `isAliveById`, `teardown`, `teardownById`, and `listManagedSandboxes`
- **AND** it does not leak a backend-specific type (Docker `Container`, K8s `Pod`)

#### Scenario: A spawn takes its ids from the session

- **GIVEN** a `SpawnSession` for the analysis `an-1`, the run `run-1`, and the step `step-a`
- **WHEN** a caller runs `createSandbox(session, spec, identity)`
- **THEN** the sandbox holds the step directory of `an-1`, `run-1`, and `step-a` as its writable mount
- **AND** the sandbox records `spec.ownerWorkflowId` as its owner workflow

#### Scenario: A session with no step id does not compile

- **GIVEN** a `RunSession` whose `runFrame` has no `stepId`
- **WHEN** a caller gives that session to `createSandbox`
- **THEN** the typecheck fails

### Requirement: The host keeps each exec stream up to the maximum of the tool output store

The submit of each exec MUST carry `stdoutByteCap` and `stderrByteCap`, with the value `EXEC_STREAM_BYTE_CAP`. `runExec` attaches them to each request, and a caller of `exec` gives no budget.

`exec` of the client MUST cut each stream of the result at the same value with `capExecStreams`, inside the `sandbox.exec` step, before the step returns. The cut on receipt stays, because a server that is older than the budget returns each stream whole.

`EXEC_STREAM_BYTE_CAP` MUST be 1,048,576 bytes, the maximum of a kept text of the tool output store (refer to the harness-agent-loop capability). Thus the host gets each stream that the store can keep, and the loop decides what the model sees. An embedder can give a different value with `execStreamByteCap` of the client configuration.

Each caller of the client gets the same bound: the step agent and the data profile.

#### Scenario: A submit carries the budget

- **GIVEN** an exec request that carries no budget
- **WHEN** `exec` submits it
- **THEN** the body of `POST /exec` carries `stdoutByteCap` and `stderrByteCap` with the value 1,048,576

#### Scenario: A long stream from an older server is cut on receipt

- **GIVEN** a server that ignores the budget and returns a stdout of 2,097,152 bytes
- **WHEN** the `sandbox.exec` step of the client returns
- **THEN** the stdout holds 1,048,576 bytes, `stdoutTruncated` is true, and `stdoutTotalBytes` gives 2,097,152

#### Scenario: A stream under the budget reaches the host whole

- **GIVEN** a command that writes 300 KiB to stdout
- **WHEN** the result reaches the host
- **THEN** the stdout holds the 300 KiB, and `stdoutTruncated` is false

### Requirement: The exec stops when its workflow is canceled

A DBOS step does not see a cancel of its workflow. Thus the exec MUST read the
status of its workflow during the poll loop, at most one time in each 10 s. When
the status is `CANCELLED`, the exec MUST throw `DBOSWorkflowCancelledError`. The
command in the sandbox continues until the lease of the consumer ends, because
sandbox-server has no kill route. The lease workflow ends the lease when it finds
its owner terminal (see the sandbox-leases spec).

#### Scenario: A cancel stops the poll loop

- **GIVEN** an exec that polls a command that runs
- **WHEN** its workflow is canceled
- **THEN** the next status read finds `CANCELLED`, and the exec throws `DBOSWorkflowCancelledError`
- **AND** the exec sends no more polls

#### Scenario: The lease removes the machine of a canceled exec

- **GIVEN** an exec whose workflow was canceled while its command runs
- **WHEN** the lease workflow finds the owner terminal
- **THEN** the lease workflow removes the machine, and the command stops with it

## ADDED Requirements

### Requirement: teardown removes only the machine, and it is idempotent

`teardown(ref)` MUST run as a DBOS step that deletes the K8s Job (or stops and removes the Docker container). It MUST touch no row of the database. It MUST be idempotent: "already gone" is a successful teardown and MUST NOT throw.

#### Scenario: Teardown removes the machine

- **GIVEN** a K8s sandbox of a lease
- **WHEN** `teardown(ref)` is called
- **THEN** the Job is deleted, and no row of the database changes

#### Scenario: Teardown of a missing sandbox is a no-op success

- **GIVEN** a sandbox whose backing machine has already been deleted
- **WHEN** `teardown(ref)` is called
- **THEN** the call returns success without throwing

### Requirement: teardownById removes a machine by id alone

`teardownById(sandboxId)` MUST delete a machine by id alone. This is the path of the reconciler, which holds a `sandboxId` but no full `SandboxRef`. It MUST be idempotent. `isAliveById(sandboxId)` MUST answer liveness on the same id-only terms, with the semantics and the throw contract of `isAlive`, which MUST delegate to it.

#### Scenario: teardownById deletes by id

- **GIVEN** the reconciler that holds only a `sandboxId`
- **WHEN** `teardownById(sandboxId)` is called
- **THEN** the backend machine is deleted

#### Scenario: teardownById of a missing machine succeeds

- **GIVEN** a `sandboxId` whose machine is already gone
- **WHEN** `teardownById(sandboxId)` is called
- **THEN** the call returns success without throwing

### Requirement: The sandbox spawn is idempotent on a keyed identity

The lease workflow MUST spawn each machine in a DBOS step, under a `SandboxIdentity` `{ sandboxId }` that comes from a key. The key is the id of the lease workflow and the machine generation, and the name has the form `sbx-{run8}-{hash12}`. The step MUST wait for `/health` and return the `SandboxRef` `{ sandboxId, host, port, backend }`. A rerun MUST adopt a machine that exists already. The machine gets no secret.

#### Scenario: The same key gives the same name

- **GIVEN** a lease workflow `sandboxlease:an-1:run-1-2:1` at the machine generation 1
- **WHEN** its spawn step runs two times
- **THEN** each run gives the same `sandboxId`, and no step mints a name before the spawn

#### Scenario: Recovery adopts an already-spawned machine

- **GIVEN** a process restart between the backend spawn and the checkpoint of the spawn step
- **WHEN** the spawn step runs again on recovery and the backend reports that the machine exists
- **THEN** it adopts that machine under the same name
- **AND** it does not make a second machine

#### Scenario: A new machine of the lease gets a new name

- **GIVEN** a lease whose machine went away at the machine generation 1
- **WHEN** the lease workflow spawns the machine of the generation 2
- **THEN** the new machine has a `sandboxId` that differs from the first

### Requirement: A record that a new machine lost gives a synthetic failure

A poll can give a result that carries the lost reason of sandbox-server. Then the exec MUST return a synthetic-failure `ExecResult` with the reason `"sandbox-replaced"` and no exit code. The exec MUST NOT submit the command again. A lost record shows that the machine of the lease changed while the command ran.

#### Scenario: A recovered exec meets a lost record

- **GIVEN** a command that ran when its machine went away, and a new machine of the same lease that marked its record lost
- **WHEN** the recovered exec submits the same exec id and polls
- **THEN** the exec returns a synthetic failure with the reason `"sandbox-replaced"`
- **AND** the command does not run again

## REMOVED Requirements

### Requirement: Recovery re-checks liveness before continuing a step

**Reason**: A consumer holds a lease, not a machine. When the machine of a lease is dead, the next exec of the lease gets a new machine from the lease workflow.

**Migration**: None for a consumer. The sandbox-leases spec gives the replacement of a machine.

### Requirement: A scheduled reaper is the sole orphan cleanup

**Reason**: The reconciler of the sandbox module replaces the reaper. The owner of a machine is its lease workflow, and the lease workflow removes its machine when its consumer ends.

**Migration**: Remove the call of `registerSandboxReaper` from the embedder. `assembleCoreRuntime` registers the reconciler (see the sandbox-leases spec).

### Requirement: The active-sandbox registry records the machine, not the exec

**Reason**: The lease table `cortex_sandbox_leases` records the current machine of each lease. The step row holds no sandbox reference.

**Migration**: Read the machine of a lease from `cortex_sandbox_leases` (see the sandbox-leases spec).

### Requirement: teardown and teardownById are idempotent

**Reason**: The teardown no longer clears a registry row, because the registry goes away. The requirements "teardown removes only the machine, and it is idempotent" and "teardownById removes a machine by id alone" replace it.

**Migration**: None. The lease workflow calls `teardown`, and the reconciler calls `teardownById`.

### Requirement: The sandbox spawn is a checkpoint-idempotent two-step sequence

**Reason**: The lease workflow spawns each machine under a keyed identity, thus no `sandbox.mint` step is necessary. The requirement "The sandbox spawn is idempotent on a keyed identity" replaces it.

**Migration**: None for a consumer. The sandbox module owns the spawn (see the sandbox-leases spec).
