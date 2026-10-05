# harness-sandbox-exec Specification

## Purpose

Define the sandbox exec layer of the harness: the `SandboxClient` interface and
the exec protocol that each sandbox caller uses. Each analysis step gets one
container of the base image, and the container runs R and Python. The harness
controls the container over HTTP. If the host process that runs the workflow
stops, a different process continues the work.

**One exec runs inside one DBOS step.** `SandboxClient.exec` runs the command
in the step `sandbox.exec`. The step submits `POST /exec`, and then it polls
`GET /exec/{execId}?since={cursor}` until the result arrives. The exec id is
`${workflowId}:${stepId}`, from the step that runs the exec. Thus a caller mints
no exec id, and one step holds one exec.

**A recovered step attaches to the exec that ran.** A completed step replays
from the step cache, and it sends no request. A step that did not complete runs
again on recovery. It submits the same exec id, and sandbox-server gives the
existing record. Thus the command does not run a second time. sandbox-server
keeps each record for the life of its process.

**The host polls, and the sandbox initiates nothing.** The step gives the
events of the exec to the run-event stream from inside the step. A recovered
step gives the events again, thus each consumer must accept a repeated event.
The step reads the cancel state of its workflow. After failed polls, it probes
the liveness of the machine, and a dead machine ends the exec with a synthetic
failure. No callback and no watchdog exist.

**Confinement is the control on the exec endpoints.** The requests and the
responses carry no signature, and the sandbox holds no secret. A sandbox has no
egress. On Docker, the exec port is published on `127.0.0.1` only, and the
entrypoint installs an egress-deny firewall. On K8s, a NetworkPolicy admits
only Cortex to the exec port, and it denies each egress of the sandbox.

**The spawn is checkpoint-idempotent, and a reaper is the only orphan
cleanup.** If the process stops between the spawn and the checkpoint of one
step, the machine leaks. Thus the spawn has two steps: `sandbox.mint`
checkpoints the `{ sandboxId }` before a machine exists, and `sandbox.create`
spawns or adopts the machine under that name. A canceled workflow cannot run
its own teardown step. Thus a separate scheduled `registerSandboxReaper`
removes each managed machine whose owner workflow is terminal or missing, and
it reconciles the step row.

## Requirements

### Requirement: SandboxClient exposes seven backend-selected operations

The harness MUST expose a `SandboxClient` interface with exactly seven
operations: `createSandbox(session, spec, identity) → ResultAsync<SandboxRef, SandboxError>`,
`exec(ref, request, emit, deadline) → ExecResult`, `isAlive(ref) → SandboxLiveness`,
`isAliveById(sandboxId) → SandboxLiveness`, `teardown(ref) → void`,
`teardownById(sandboxId) → void`, and `listManagedSandboxes() → ManagedSandbox[]`.
A `createSandboxClient()` factory MUST select the Docker (dev) or K8s (prod)
implementation from the `SANDBOX_BACKEND` value. The client MUST be injected at
the composition root as a construction-time dependency. A caller MUST NOT import
a backend implementation directly, and the interface MUST NOT leak a
backend-specific type.

`createSandbox` MUST take the `SpawnSession` of the work, a `RunSession` whose
`runFrame.stepId` is present. Thus a spawn without a session does not compile. The client MUST
read the analysis id from `session.scope.analysisId`, the run id from `session.runFrame.runId`,
and the step id from `session.runFrame.stepId`. `SandboxSpec` holds the other fields of the
spawn: `childWorkflowId`, `image`, `extraEnv`, `resources`, `readOnly`, and `writableTail`.
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
- **AND** the active-sandbox registry records the sandbox under `run-1` and `step-a`

#### Scenario: A session with no step id does not compile

- **GIVEN** a `RunSession` whose `runFrame` has no `stepId`
- **WHEN** a caller gives that session to `createSandbox`
- **THEN** the typecheck fails

### Requirement: The step quota is published inside the sandbox

The Docker backend SHALL make the cpu quota of a step visible inside the
sandbox. It SHALL cover `/proc/cpuinfo` and `/sys/devices/system/cpu/online`
with a read-only bind mount of files that describe `floor(cpu)` cores
(minimum 1). The K8s backend SHALL NOT mount cpu files: the cluster runtime
(gVisor with `cpu-num-from-quota` and `systemd-cgroup`) derives the guest
core count and memory from the pod limits.

Both backends SHALL inject the shared thread-limit env (`thread-env.ts`): the
thread-pool variables at `1`, and the worker-count variables at `floor(cpu)`.
The rationale and the exact variable set are in the docker-sandbox-provider
spec ("The cpu quota is visible inside the container").

#### Scenario: A Docker step sees its quota

- **GIVEN** a step with the resources `{ cpu: 2 }` on the Docker backend
- **WHEN** the client makes the sandbox
- **THEN** a read-only file over `/sys/devices/system/cpu/online` describes 2 cores
- **AND** the env has `OMP_NUM_THREADS=1` and `BIOCPARALLEL_WORKER_NUMBER=2`

### Requirement: isAlive reports per-sandbox-machine liveness per backend

`isAlive(ref)` SHALL report the machine as dead only when the underlying sandbox
machine is observably dead, and SHALL additionally report whether the death was
a memory-limit kill when the backend exposes it. For K8s, "dead" means the pod
phase is `Failed`/`Succeeded` or the pod no longer exists (404); an OOM kill is
recognized from a container terminated state with reason `OOMKilled`. For
Docker, "dead" means the container is not `running` or no longer exists; an OOM
kill is recognized from `State.OOMKilled` on the same
inspect response already used for liveness. Transient API errors SHALL throw
rather than be reported as dead, so callers may retry. The check SHALL be
liveness, not readiness: a starting sandbox is alive.

#### Scenario: K8s missing pod is dead

- **GIVEN** a `ref` whose pod no longer exists in the cluster
- **WHEN** `isAlive(ref)` is called
- **THEN** the K8s API returns 404 and the machine SHALL be reported dead, with no OOM cause

#### Scenario: Docker stopped container is dead

- **GIVEN** a Docker sandbox whose container has exited
- **WHEN** `isAlive(ref)` is called
- **THEN** the machine SHALL be reported dead

#### Scenario: Docker missing container is dead

- **GIVEN** a `ref` whose container no longer exists (inspect returns 404)
- **WHEN** `isAlive(ref)` is called
- **THEN** the machine SHALL be reported dead, with no OOM cause — a removed container is observably dead, not a transient API failure

#### Scenario: Docker OOM-killed container reports the cause

- **GIVEN** a Docker sandbox whose container was killed for exceeding its memory limit (`State.OOMKilled: true`)
- **WHEN** `isAlive(ref)` is called
- **THEN** the machine SHALL be reported dead with the OOM-kill cause

#### Scenario: Transient API error throws

- **GIVEN** the K8s API returns 5xx for `GET pod`
- **WHEN** `isAlive(ref)` is called
- **THEN** it SHALL throw the API error and SHALL NOT silently report the machine dead

### Requirement: teardown and teardownById are idempotent

`teardown(ref)` MUST run as a DBOS step that deletes the K8s Job (or stops and
removes the Docker container) and clears the active-sandbox registry row. It MUST
be idempotent: "already gone" is a successful teardown and MUST NOT throw.

`teardownById(sandboxId)` MUST delete a machine by id alone. This is the path of
the reaper, which holds a `sandboxId` but no full `SandboxRef`. It MUST NOT touch
the registry, because the reaper reconciles the row itself. It too MUST be
idempotent. `isAliveById(sandboxId)` MUST answer liveness on the same id-only
terms, with the semantics and throwing contract of `isAlive`, which MUST
delegate to it.

#### Scenario: Teardown removes the machine and clears the row

- **GIVEN** a K8s sandbox recorded in the active-sandbox registry
- **WHEN** `teardown(ref)` is called
- **THEN** the Job is deleted and the `sandbox_ref` of the step row is cleared

#### Scenario: Teardown of a missing sandbox is a no-op success

- **GIVEN** a sandbox whose backing machine has already been deleted
- **WHEN** `teardown(ref)` is called
- **THEN** the call returns success without throwing

#### Scenario: teardownById deletes by id without registry touch

- **GIVEN** the reaper holding only a `sandboxId`
- **WHEN** `teardownById(sandboxId)` is called
- **THEN** the backend machine is deleted
- **AND** the call does not clear any registry row itself

### Requirement: Recovery re-checks liveness before continuing a step

After `sandbox.create`, the step body SHALL re-check `isAlive(ref)` in a DBOS step
before continuing. On first execution this is a cheap no-op; on replay it catches
a sandbox that died between checkpoints. If `isAlive` returns `false`, the step
SHALL throw so it fails and DBOS retry restarts it from a fresh sandbox, rather
than resuming against a dead machine.

#### Scenario: Live sandbox continues normally

- **GIVEN** a recovered step whose `isAlive(ref)` returns `true`
- **WHEN** the body resumes
- **THEN** it SHALL continue into the agent loop as normal

#### Scenario: Dead sandbox on recovery fails the step

- **GIVEN** a recovered step whose `isAlive(ref)` returns `false`
- **WHEN** the re-check step runs
- **THEN** it SHALL throw so the step fails and DBOS retry restarts it from a fresh sandbox

### Requirement: A scheduled reaper is the sole orphan cleanup

The harness SHALL register a separate `@DBOS.scheduled` `registerSandboxReaper`
workflow (~5-minute cadence, unsharded) as the only garbage collector for
orphaned sandbox machines and stale registry rows. One sweep SHALL run as a
single DBOS step: `listManagedSandboxes`, then for each machine read its
owner-workflow status. A machine whose owner is in `{PENDING, ENQUEUED, RUNNING}`
SHALL be left alone; one whose owner is terminal (`SUCCESS`/`ERROR`/`CANCELLED`)
SHALL be reaped via `teardownById`, and the stuck step row SHALL be reconciled to
the workflow's terminal status.

A machine whose owner does **not** resolve to a workflow at all — it records no
owner, or the id it records names no `dbos.workflow_status` row — SHALL NOT be
reaped on age alone. Age cannot distinguish a genuine orphan from a live machine
whose owner id failed to resolve, and DBOS records the owner's status at enqueue,
*before* the machine exists, so a missing status is never evidence that the work
has finished. Past a creation-time grace (~10 minutes) the sweep SHALL instead
probe `isAliveById` and reap only an observably dead machine. A machine still
alive SHALL be left standing and counted in the sweep summary, so an
unattributable machine is a reported leak rather than a silent teardown of live
work. A probe that throws SHALL leave the machine for the next sweep.

#### Scenario: Terminal-owner machine is reaped and its row reconciled

- **GIVEN** a managed machine whose owning workflow status is `CANCELLED`
- **WHEN** the reaper sweep runs
- **THEN** `teardownById` SHALL delete the machine
- **AND** the stuck `status='running'` step row SHALL be reconciled to `canceled`

#### Scenario: In-flight-owner machine is left alone

- **GIVEN** a managed machine whose owning workflow status is `RUNNING`
- **WHEN** the reaper sweep runs
- **THEN** the machine SHALL NOT be torn down

#### Scenario: Unresolvable-owner machine is left alone within the grace

- **GIVEN** a managed machine whose owner does not resolve to a workflow
- **WHEN** the reaper sweep runs before the creation-time grace elapses
- **THEN** the machine SHALL be left alone, and SHALL NOT be probed

#### Scenario: Unresolvable-owner machine past the grace is reaped only when dead

- **GIVEN** a managed machine past the grace whose owner does not resolve to a workflow
- **WHEN** the reaper sweep runs and `isAliveById` reports the machine dead
- **THEN** `teardownById` SHALL delete the machine

#### Scenario: A live machine is never reaped for being unattributable

- **GIVEN** a managed machine past the grace whose owner does not resolve to a workflow
- **WHEN** the reaper sweep runs and `isAliveById` reports the machine alive
- **THEN** the machine SHALL NOT be torn down
- **AND** the sweep summary SHALL count it as live-unattributed

### Requirement: The host keeps each exec stream up to the maximum of the tool output store

The submit of each exec MUST carry `stdoutByteCap` and `stderrByteCap`, with the value `EXEC_STREAM_BYTE_CAP`. `runExec` attaches them to each request, and a caller of `exec` gives no budget.

`exec` of the client MUST cut each stream of the result at the same value with `capExecStreams`, inside the `sandbox.exec` step, before the step returns. The cut on receipt stays, because a server that is older than the budget returns each stream whole.

`EXEC_STREAM_BYTE_CAP` MUST be 1,048,576 bytes, the maximum of a kept text of the tool output store (refer to the harness-agent-loop capability). Thus the host gets each stream that the store can keep, and the loop decides what the model sees. An embedder can give a different value with `execStreamByteCap` of the client configuration.

Each caller of the client gets the same bound: the step agent, the data profile, a session derivation, and a value extraction.

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

### Requirement: Each sandbox exec runs as one durable step

`SandboxClient.exec(ref, request, emit, deadline)` MUST run one command to its
terminal result inside one DBOS step named `sandbox.exec`. The `request` MUST
carry `command`, and it can carry `cwd`, `env`, and `timeoutSeconds`. It MUST
carry no exec id. `deadline` is an absolute unix-ms timestamp.

The exec id MUST be `${workflowId}:${stepId}`: the id of the workflow and the
DBOS function id of the step that runs the exec. A caller MUST NOT mint an exec
id. When a workflow body calls `exec`, the exec is its own step. A step can also
call `exec`, for example the step of a tool call of the agent loop. Then the
exec runs inside that step and takes the id of that step.

Thus one step MUST hold at most one exec. A second exec in the same step gets
the same id, and the sandbox gives it the record of the first exec. Outside a
workflow, `exec` MUST throw before it sends a request.

A step that completed MUST replay from the DBOS step cache. The replay gives the
cached `ExecResult`, and it sends no request to the sandbox. A step that did not
complete runs again on recovery. It MUST submit again with the same exec id. The
sandbox MUST give the existing record of that id, and it MUST start no second
command (see the sandbox-server spec).

The client MUST cut the stdout and the stderr of the result to the retention
budget before the step returns. Thus the step cache holds a bounded value.

#### Scenario: The exec id comes from the step

- **GIVEN** a workflow `wf-1` whose body calls `exec` as its step with the function id `4`
- **WHEN** the step submits the command
- **THEN** the submit carries `execId: "wf-1:4"`

#### Scenario: The exec of a tool call takes the id of the tool step

- **GIVEN** an `execute_command` call that the loop runs as the step `7` of the workflow `wf-1`
- **WHEN** the tool calls `exec`
- **THEN** the exec runs inside that step, and its exec id is `"wf-1:7"`

#### Scenario: A completed step replays with no request

- **GIVEN** a `sandbox.exec` step that completed on process A
- **WHEN** the workflow recovers on process B
- **THEN** the step gives the cached result, and process B sends no request to the sandbox

#### Scenario: A recovered step attaches to the existing exec

- **GIVEN** a host that stops while its `sandbox.exec` step polls a command that runs
- **WHEN** the step runs again on recovery
- **THEN** it submits the same exec id, and the sandbox starts no second command
- **AND** the poll gives the result of the first command

#### Scenario: An exec outside a workflow throws

- **WHEN** a caller calls `exec` with no active DBOS workflow
- **THEN** the call throws, and no request reaches the sandbox

### Requirement: The exec submits, then polls the cursor endpoint

The exec MUST `POST /exec` with
`{ command, execId, cwd?, env?, timeoutSeconds?, stdoutByteCap, stderrByteCap }`.
A `202` is the ack. Any other status MUST throw, and the step fails.

Then the exec MUST poll `GET /exec/{execId}?since={cursor}` from cursor 0. A
response is `{ status, events, cursor, truncated?, result? }`, and `status` is one
of `running`, `completed`, and `failed`. The exec MUST wait 1.5 s after each of
the first 40 polls, and 10 s after each later poll.

The exec MUST give each event whose sequence number is above its local cursor to
`emit`, in sequence order. It MUST wait for each `emit` before the next poll. The
exec MUST apply this filter itself, because a response can hold events at or
below the cursor. The exec MUST return `result` when a response holds it.

A gap between the local cursor and the next sequence number shows that the ring
of the sandbox dropped events. The exec MUST log the gap as a warning and
continue. The terminal result, not the event stream, is the outcome of the exec.

A failed poll MUST NOT fail the exec. A network error, a timeout, a non-200
status, and a `404` are each a failed poll. The exec MUST continue to poll until
the deadline. The exec MUST compare the time with the deadline after a poll.
Thus the exec always polls one time more before it throws `ExecTimeoutError`.

The returned `ExecResult` MUST carry an optional `provenance` frame that mirrors
the completion payload of sandbox-server: `{ disabled, reads, writes, deletes }`,
and each entry is `{ path, layers }`. Each arm MUST have a default. Thus a result
with no frame parses, for example a synthetic failure.

#### Scenario: A poll gives the terminal result

- **GIVEN** an exec whose command completed
- **WHEN** the exec polls `GET /exec/{execId}?since={cursor}`
- **THEN** the response holds `result`, and the exec returns it

#### Scenario: Each new event reaches emit one time

- **GIVEN** an exec whose command makes events between two polls
- **WHEN** the exec polls with its last cursor
- **THEN** only the events above the cursor reach `emit`, and the cursor moves to the new high-water mark

#### Scenario: A repeated snapshot gives no event again

- **GIVEN** a response that holds events at or below the local cursor
- **WHEN** the exec reads it
- **THEN** only the events above the local cursor reach `emit`

#### Scenario: Events that the ring dropped give a warning

- **GIVEN** a response whose first sequence number leaves a gap above the local cursor
- **WHEN** the exec reads it
- **THEN** the exec logs a warning that names the lost range, and it continues

#### Scenario: A failed poll is not a failed exec

- **GIVEN** a poll that times out, that the sandbox refuses, or that gets a `404`
- **WHEN** the exec reads the outcome
- **THEN** the exec continues to poll until the deadline, and the step does not fail

#### Scenario: The deadline check polls one time more

- **GIVEN** an exec whose deadline is past
- **WHEN** the exec sees the deadline
- **THEN** it polled one time after the deadline, and it returns the result of that poll when the poll holds one
- **AND** it throws `ExecTimeoutError` only when that poll holds no result

#### Scenario: The cadence slows for a long exec

- **GIVEN** an exec that still runs after 40 polls
- **WHEN** the exec waits for the next poll
- **THEN** it waits 10 s

#### Scenario: A refused submit fails the step

- **WHEN** `POST /exec` gets a status that is not `202`
- **THEN** the exec throws, and the `sandbox.exec` step fails

#### Scenario: A result with no provenance frame parses

- **WHEN** a terminal result holds no `provenance`
- **THEN** the exec returns the result with no throw, and the `provenance` is absent or has empty arms

### Requirement: The exec stops when its workflow is canceled

A DBOS step does not see a cancel of its workflow. Thus the exec MUST read the
status of its workflow during the poll loop, at most one time in each 10 s. When
the status is `CANCELLED`, the exec MUST throw `DBOSWorkflowCancelledError`. The
command in the sandbox continues until the reaper removes the machine, because
sandbox-server has no kill route.

#### Scenario: A cancel stops the poll loop

- **GIVEN** an exec that polls a command that runs
- **WHEN** its workflow is canceled
- **THEN** the next status read finds `CANCELLED`, and the exec throws `DBOSWorkflowCancelledError`
- **AND** the exec sends no more polls

### Requirement: Sustained unavailability escalates to a liveness probe

The exec MUST count the consecutive `unavailable` polls. An `ok` poll resets the
count. When the count gets to the escalation threshold, the exec MUST run one
liveness probe inside its step: the backend inspect `SandboxClient.isAlive(ref)`.
The threshold is a module constant. The probe MUST give one of three verdicts,
and it MUST NOT throw:

- **dead**: the machine is observably dead. The exec MUST return a
  synthetic-failure `ExecResult` with no wait for the deadline. The reason MUST
  be `"sandbox-oom-killed"` when the backend gives the memory limit as the cause
  of the death, and `"sandbox-dead"` for each other cause.
- **alive**: the machine runs, for example with a slow exec or a non-200 answer.
  The exec MUST reset the count and continue to poll, bounded by the deadline.
- **inconclusive**: the inspect threw, for example on a transient error of the
  backend API. The exec MUST reset the count and continue to poll. A failed
  probe is not a failed exec.

A poll outcome alone MUST NOT fail an exec. An `unavailable` poll cannot tell an
unreachable sandbox from an unknown exec id. Thus the backend inspect is the only
judge of a dead machine. When the exec has no `isAlive`, it MUST NOT escalate,
and only the deadline bounds it.

#### Scenario: A dead machine ends the exec fast

- **GIVEN** an exec whose machine stops during the command
- **WHEN** the threshold count of consecutive polls are `unavailable`, and the probe finds the machine dead
- **THEN** the exec returns a synthetic-failure `ExecResult` with the reason `"sandbox-dead"`, with no wait for the deadline

#### Scenario: A machine that ran out of memory gives the OOM reason

- **GIVEN** an exec whose machine the backend reports as OOM-killed
- **WHEN** the probe runs
- **THEN** the synthetic-failure result carries the reason `"sandbox-oom-killed"`

#### Scenario: A slow machine that is alive never fails the exec

- **GIVEN** an exec whose polls are `unavailable` past the threshold, and whose machine the probe finds alive
- **WHEN** the verdict arrives
- **THEN** the exec resets the count and continues to poll, and only the deadline bounds it

#### Scenario: An ok poll resets the count

- **GIVEN** a series of `unavailable` polls one short of the threshold
- **WHEN** the next poll is `ok`
- **THEN** no probe runs, and the count starts again from zero

#### Scenario: A transient probe error is inconclusive

- **GIVEN** a probe whose backend inspect throws a transient API error
- **WHEN** the probe runs
- **THEN** the probe does not throw, the exec does not fail, and the exec continues to poll with the count at zero

#### Scenario: No inspect, no escalation

- **GIVEN** an exec with no `isAlive`
- **WHEN** the polls are `unavailable` past the threshold
- **THEN** the exec continues to poll, and only the deadline bounds it

### Requirement: The exec gives its events at least once

The exec MUST call `emit` from inside its step. A step that runs again on
recovery polls from cursor 0. Thus it MUST give the events of its exec to `emit`
again, and a consumer of `emit` MUST tolerate a repeated event.

A write to a DBOS stream from inside a step is permitted, and it is
at-least-once. The write takes no function id of the workflow. Thus an event
write inside a step does not change the replay sequence of the body.

The sandbox-step body obeys this rule. It folds each file-tree delta into one
path set, and it writes the whole tree under one reconciling part id. Thus a
repeated delta adds no path two times.

After a recovery, the live tree holds only the deltas of the execs that ran in
the new process. The terminal tree of the step replaces the live tree at the end
of the step.

#### Scenario: A recovered step writes its events again

- **GIVEN** a `sandbox.exec` step that gave two file-tree events to `emit`, and then its host stopped
- **WHEN** the step runs again on recovery
- **THEN** the exec gives the two events to `emit` again
- **AND** each file-tree part that the body writes is a whole tree under the same reconciling id

### Requirement: A sandbox has no egress

A sandbox MUST NOT start a network connection. The host connects to the
sandbox, and the sandbox answers on that connection. The exec endpoints carry no
signature. Thus confinement is the only control that keeps a different peer away
from the exec endpoints of a sandbox.

- On the Docker backend, the client MUST publish the exec port on `127.0.0.1`
  only. The entrypoint of the image MUST install the egress-deny firewall before
  the workload starts (see the docker-sandbox-provider spec and the
  sandbox-server spec).
- On the K8s backend, the deployment MUST apply a NetworkPolicy to the sandbox
  pods. The policy MUST admit ingress to the exec port from the Cortex pods
  only, and it MUST deny each egress of a sandbox pod. The harness sets no
  firewall flag on a K8s pod.

#### Scenario: A Docker sandbox cannot open a connection

- **GIVEN** a sandbox on the Docker backend
- **WHEN** the workload opens a new outbound connection
- **THEN** the firewall drops the connection
- **AND** the poll of the host still gets its answer

#### Scenario: Only Cortex reaches a K8s sandbox

- **GIVEN** a sandbox pod under the NetworkPolicy of the deployment
- **WHEN** a pod that is not a Cortex pod connects to the exec port
- **THEN** the policy refuses the connection

### Requirement: The active-sandbox registry records the machine, not the exec

The active-sandbox registry MUST be the `cortex_step_executions` rows with a
non-null `sandbox_ref` and `status='running'`. The `sandbox.create` step MUST
write `sandbox_ref`, and `teardown` MUST clear it. The reaper MUST clear it when
it reconciles the row of a machine that it removed. The row MUST hold no exec
id. The exec id is the id of a DBOS step, and nothing outside that step reads
it.

#### Scenario: A step row holds no exec id

- **GIVEN** a step whose agent runs some execs
- **WHEN** a reader reads the row while the step runs
- **THEN** the row holds the `sandbox_ref` of the machine, and it holds no exec id

### Requirement: The sandbox spawn is a checkpoint-idempotent two-step sequence

The spawn MUST run as two DBOS steps. Step 1 (`sandbox.mint`) MUST checkpoint a
`SandboxIdentity` `{ sandboxId }`, a `sbx-{run8}-{rand8}` name. Thus the name is
durable before a machine exists. Step 2 (`sandbox.create`) MUST spawn the
`sandbox-base` machine under that identity and wait for `/health`. Then it MUST
record the machine in the active-sandbox registry and return the `SandboxRef`
`{ sandboxId, host, port, backend }`. The machine gets no secret.

The idempotency MUST come from the step-1 checkpoint, not from the name. A
recovery run of step 2 whose machine exists already MUST adopt that machine
under the same name, and it MUST NOT leak a second machine.

#### Scenario: Identity is durable before the machine exists

- **WHEN** the `sandbox.mint` step runs
- **THEN** `{ sandboxId }` is checkpointed as the output of that step
- **AND** no sandbox machine exists yet

#### Scenario: The identity persists across replay

- **GIVEN** a workflow that ran the mint step and the spawn step on process A
- **WHEN** the workflow recovers on process B
- **THEN** the cached step outputs are returned, and no new name is minted

#### Scenario: Recovery adopts an already-spawned machine

- **GIVEN** a process restart between the backend spawn and the step-2 checkpoint
- **WHEN** `sandbox.create` runs again on recovery and the backend reports that the machine exists
- **THEN** it adopts that machine under the step-1 identity
- **AND** it does not make a second machine

### Requirement: A scheduled sweep clears the unconsumed DBOS sends

The harness MUST register a `@DBOS.scheduled` sweep that runs about each 5
minutes. The sweep deletes the `dbos.notifications` rows whose target workflow
is terminal (`SUCCESS`, `ERROR`, or `CANCELLED`) and whose `consumed` is
`false`. A
`DBOS.send` to a workflow that ends before it reads the message stays forever
otherwise. The suspension notice of a child to a parent that failed already is
one example. The delete MUST be bounded for each run, and the sweep MUST log the
row count.

#### Scenario: Stale notifications cleared for terminal workflows

- **GIVEN** a `dbos.notifications` row with `consumed=false` whose workflow status is `SUCCESS`
- **WHEN** the sweep runs
- **THEN** the row is deleted

#### Scenario: Live-workflow notifications preserved

- **GIVEN** a `dbos.notifications` row with `consumed=false` whose workflow status is `PENDING`
- **WHEN** the sweep runs
- **THEN** the row is not deleted
