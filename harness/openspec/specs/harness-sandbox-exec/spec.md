# harness-sandbox-exec Specification

## Purpose

Define the harness sandbox exec seam — the `SandboxClient` interface and the
submit/recv protocol every sandbox-backed module sits on. A single base-image
container per analysis step runs R/Python; the harness drives it over HTTP and
recovers cleanly when the workflow-owning host process dies mid-run.

**Submit + durable recv, not a long-lived stream.** The old protocol held one
HTTP `POST /exec` open for hours while sandbox-server streamed `ndjson`; under
multi-replica DBOS recovery a reassigned workflow could not resume that stream
and would re-issue the command. So `/exec` is split into a `submitExec` DBOS
step (POST, return after 202) and a workflow-body recv loop. Sandbox-server runs
the command in the background and POSTs progress and the final result back to
the host; whichever host process receives a callback forwards it via `DBOS.send`
onto a **single per-exec DBOS topic** `exec-event:${execId}`, unblocking the
recv on whatever process owns the workflow at that moment. There is no in-memory
fast-path bus — delivery is `DBOS.send` only. (This rationale is owned by the
harness's sandbox-submit/recv decision; the protocol flip and the
`executeAnalysis` cutover shipped as one atomic deploy, with no dual-protocol
sandbox-server carrying both the old stream and the new path.)

**Callbacks are HMAC-signed, verified in the workflow body at recv.** Because a
callback may land on a process that is not executing the workflow body, the
authentication cannot live at the host edge. A per-sandbox `callbackSecret` is
minted once, handed to sandbox-server once, and never transmitted again;
sandbox-server signs each callback `HMAC-SHA256(callbackSecret,
"${execId}:${timestamp}:${sha256Hex(body)}")`. The host callback handler is
dumb: no secret, no verification, no DB read — it parses the workflowId out of
the execId and forwards the `{payload, payloadRaw, signature, timestamp}`
envelope. The workflow body — which holds the secret from the cached create
step output — verifies the HMAC and timestamp freshness on each message; a bad
or stale signature hard-cancels the run. Network isolation is the primary
control; the HMAC is defense-in-depth.

**Create is checkpoint-idempotent; a reaper is the sole orphan cleanup.** A
single create step that minted the secret, spawned the machine, then
checkpointed could leak a running machine nothing referenced if the process
restarted in the spawn→checkpoint window. So creation is two steps: `sandbox.mint`
checkpoints `{ sandboxId, callbackSecret }` before any machine exists, and
`sandbox.create` spawns (or, on a recovery re-run, adopts) the machine under
that durable identity. Because a cancelled workflow structurally cannot run its
own teardown step, a separate scheduled `registerSandboxReaper` is the only
orphan cleanup: it enumerates Cortex-managed machines (`listManagedSandboxes`),
tears down any whose owning workflow is terminal/missing (`teardownById`), and
reconciles the stuck step row.

## Requirements

### Requirement: SandboxClient exposes seven backend-selected operations

The harness SHALL expose a `SandboxClient` interface with exactly seven
operations: `createSandbox(meta, identity) → SandboxRef`, `submitExec(ref, body)
→ void`, `awaitExec(execId, callbackSecret, emit, deadline) → ExecResult`,
`isAlive(ref) → boolean`, `teardown(ref) → void`, `teardownById(sandboxId) →
void`, and `listManagedSandboxes() → ManagedSandbox[]`. A `createSandboxClient()`
factory SHALL select the Docker (dev) or K8s (prod) implementation based on the
`SANDBOX_BACKEND` value. The client SHALL be injected at the composition root as
a construction-time dependency; callers SHALL NOT import a backend
implementation directly, and the interface SHALL NOT leak backend-specific types.

#### Scenario: Docker backend selected in dev

- **GIVEN** `SANDBOX_BACKEND=docker`
- **WHEN** `createSandboxClient()` is called
- **THEN** the returned client SHALL be the Docker implementation
- **AND** `createSandbox` SHALL launch a `sandbox-base` container with a host-port mapping

#### Scenario: K8s backend selected in prod

- **GIVEN** `SANDBOX_BACKEND=k8s`
- **WHEN** `createSandboxClient()` is called
- **THEN** the returned client SHALL be the K8s implementation
- **AND** `createSandbox` SHALL create a K8s Job whose pod runs `sandbox-base`

#### Scenario: Interface surface is the seven operations

- **WHEN** a consumer imports `SandboxClient`
- **THEN** the type SHALL expose exactly `createSandbox`, `submitExec`, `awaitExec`, `isAlive`, `teardown`, `teardownById`, and `listManagedSandboxes`
- **AND** SHALL NOT leak backend-specific types (Docker `Container`, K8s `Pod`)

### Requirement: Sandbox creation is a checkpoint-idempotent two-step sequence

Creation SHALL run as two DBOS steps. Step 1 (`sandbox.mint`) SHALL checkpoint a
`SandboxIdentity` `{ sandboxId, callbackSecret }` — a `sbx-{run8}-{rand8}` name
and a 32-byte base64 HMAC secret — so both are durable before any machine
exists. Step 2 (`sandbox.create`) SHALL spawn the `sandbox-base` machine under
that identity, pass the secret via `SANDBOX_CALLBACK_SECRET`, wait for `/health`,
record the live handle (minus the secret) in the active-sandbox registry, and
return the in-memory `SandboxRef` (which carries the secret). Idempotency SHALL
come from the step-1 checkpoint, not the name: a recovery re-run of step 2 whose
machine already exists SHALL adopt it under the same name and secret rather than
leak a second machine. The returned `callbackSecret` SHALL be part of the cached
step output so the workflow body holds it verbatim on replay.

#### Scenario: Identity is durable before the machine exists

- **WHEN** the `sandbox.mint` step runs
- **THEN** `{ sandboxId, callbackSecret }` SHALL be checkpointed as that step's output
- **AND** no sandbox machine SHALL have been created yet

#### Scenario: callbackSecret persists across replay

- **GIVEN** a workflow that ran the mint+create steps on process A
- **WHEN** the workflow recovers on process B
- **THEN** the cached step output SHALL be returned without re-minting the secret
- **AND** the `callbackSecret` SHALL equal the value originally minted

#### Scenario: Recovery adopts an already-spawned machine

- **GIVEN** a process restart between the backend spawn and the step-2 checkpoint
- **WHEN** `sandbox.create` re-runs on recovery and the backend reports the machine already exists
- **THEN** it SHALL adopt that machine under the step-1 identity
- **AND** SHALL NOT create a second machine

### Requirement: submitExec is a DBOS step keyed on execId

`submitExec(ref, body)` SHALL run as a DBOS step named
`sandbox.submit-exec.${execId}` that POSTs `${ref.host}:${ref.port}/exec` with
`{ command, execId, cwd?, env?, timeoutSeconds? }` and returns after the HTTP 202
ack — it SHALL NOT wait for command completion. The `execId` SHALL be
`"${workflowId}:${stepId}:${functionId}"` so it is stable across replay and
doubles as the step's replay cache key. On replay the cached step output SHALL be
returned without re-POSTing; any duplicate POST that reaches sandbox-server
during the narrow in-flight window relies on sandbox-server's `execId` dedup. A
non-202 response SHALL throw.

#### Scenario: submitExec returns after 202

- **GIVEN** a created sandbox
- **WHEN** `submitExec(ref, { command: ["sleep","10"], execId })` is called
- **THEN** the step SHALL return after the 202 ack, before the command exits

#### Scenario: Replay does not re-POST

- **GIVEN** a workflow that completed `submitExec` on process A
- **WHEN** the workflow recovers on process B
- **THEN** the cached step output SHALL be returned without a new POST to sandbox-server

#### Scenario: In-flight duplicate is deduped by sandbox-server

- **GIVEN** a process failure between the `submitExec` POST and the 202 receipt
- **WHEN** the recovering process re-POSTs the same `execId`
- **THEN** sandbox-server SHALL return the existing state without spawning a second command

### Requirement: awaitExec is a workflow-body recv loop with HMAC verification

`awaitExec` SHALL run in the workflow body (not as a DBOS step) because
`DBOS.recv` and `DBOS.writeStream` are body-only. It SHALL loop
`DBOS.recv("exec-event:${execId}", T)` over a **single per-exec topic** carrying
both progress events and the completion marker. Each received envelope is
`{ payload, payloadRaw?, signature, timestamp }`. A message with `signature: null`
SHALL be accepted only when its payload is a `synthetic-failure` done-marker
(the in-process watchdog is a trusted sender); any other null-signature message
SHALL hard-cancel. Otherwise the body SHALL recompute `HMAC-SHA256(callbackSecret,
"${execId}:${timestamp}:${sha256Hex(payloadRaw)})")` and compare in constant
time, and SHALL reject a timestamp outside the freshness window; a mismatch or
stale timestamp SHALL throw `HardCancelError`, which DBOS treats as a fatal,
non-retried workflow error. A verified done-marker SHALL return its `result`;
other verified events SHALL be forwarded via `emit`. The loop SHALL be bounded by
an absolute unix-ms `deadline`; `T` is liveness-agnostic recv pacing only
(`min(5s, remaining)`).

The returned `ExecResult` SHALL carry an optional `provenance` frame mirroring
the sandbox-server completion payload (`{ disabled, reads, writes, deletes }`,
each entry `{ path, layers }`), with all arms defaulted so a completion that
omits the frame (a synthetic watchdog failure, or a pre-field cached message)
still parses. Because the frame rides the recv payload, it SHALL reconstruct
verbatim from the durable recv output on replay.

#### Scenario: Valid event is forwarded to the stream

- **GIVEN** an `awaitExec` recv loop running with `callbackSecret` S
- **WHEN** a message arrives whose signature equals `HMAC-SHA256(S, execId:timestamp:sha256Hex(payloadRaw))` within the freshness window
- **THEN** the body SHALL call `emit(payload)` and continue the recv loop

#### Scenario: Done marker returns the result

- **GIVEN** an `awaitExec` recv loop
- **WHEN** a verified message with `{ done: true, result }` is received
- **THEN** `awaitExec` SHALL return `result` and the loop SHALL terminate

#### Scenario: Completion frame surfaces on the result

- **GIVEN** an `awaitExec` recv loop
- **WHEN** a verified done marker arrives whose `result.provenance.reads` is `[{ path: "/r/data/x.csv", layers: ["python"] }]`
- **THEN** the returned result's `provenance.reads` SHALL equal that entry

#### Scenario: Missing provenance frame parses with defaults

- **GIVEN** an `awaitExec` recv loop
- **WHEN** a verified done marker omits `provenance` (e.g., a synthetic watchdog failure)
- **THEN** `awaitExec` SHALL return the result without throwing, with absent or empty-armed `provenance`

#### Scenario: Bad signature hard-cancels the run

- **GIVEN** an `awaitExec` recv loop
- **WHEN** a non-synthetic message arrives whose signature does not match the recomputed HMAC
- **THEN** `awaitExec` SHALL throw a `HardCancelError` and the workflow SHALL be cancelled by DBOS without retry

#### Scenario: Deadline bound by step.timeout

- **GIVEN** an `awaitExec` invocation whose `deadline` is the step's absolute timeout
- **WHEN** elapsed time exceeds `deadline` before any done marker arrives
- **THEN** `awaitExec` SHALL throw a timeout error rather than block indefinitely

### Requirement: Callback delivery is dumb, pod-agnostic, and forward-only

Sandbox-server callbacks SHALL reach the workflow exclusively by `DBOS.send` onto
the per-exec topic `exec-event:${execId}` — there is no in-memory exec bus and no
dual delivery path. The host callback handler (an embedder concern; the harness
ships no HTTP route layer) SHALL parse the `workflowId` from the `execId` by
stripping the last two colon-delimited segments (`workflowIdFromExec`), then
`DBOS.send` the `{ payload, payloadRaw, signature, timestamp }` envelope. The
handler SHALL NOT verify the HMAC, SHALL NOT read the `callbackSecret`, and SHALL
NOT touch the database — verification happens in the recv loop. `payloadRaw` SHALL
carry the exact bytes sandbox-server signed, because re-serializing the parsed
payload would diverge from Go's HTML-escaping JSON encoder.

#### Scenario: workflowId recovered from a colon-bearing execId

- **GIVEN** `execId = "analysis-1:run-1-0:step-a:fn-0"` whose workflowId portion itself contains a colon
- **WHEN** `workflowIdFromExec(execId)` runs
- **THEN** it SHALL return `"analysis-1:run-1-0"` (the last two segments stripped)

#### Scenario: Handler forwards via DBOS.send without verification

- **WHEN** a callback for `execId` is forwarded
- **THEN** delivery SHALL be `DBOS.send(workflowId, { payload, payloadRaw, signature, timestamp }, "exec-event:${execId}")`
- **AND** the handler SHALL NOT execute any HMAC check, secret read, or SQL query

### Requirement: isAlive reports per-sandbox-machine liveness per backend

`isAlive(ref)` SHALL report the machine as dead only when the underlying sandbox
machine is observably dead, and SHALL additionally report whether the death was
a memory-limit kill when the backend exposes it. For K8s, "dead" means the pod
phase is `Failed`/`Succeeded` or the pod no longer exists (404); an OOM kill is
recognized from a container terminated state with reason `OOMKilled`. For
Docker, "dead" means the container is not `running` or no longer exists; an OOM
kill is recognized from `State.OOMKilled` on the same inspect response already
used for liveness. Transient API errors SHALL throw rather than be reported as
dead, so callers may retry. The check SHALL be liveness, not readiness: a
starting sandbox is alive.

#### Scenario: K8s missing pod is dead

- **GIVEN** a `ref` whose pod no longer exists in the cluster
- **WHEN** `isAlive(ref)` is called
- **THEN** the K8s API returns 404 and the machine SHALL be reported dead, with no OOM cause

#### Scenario: Docker stopped container is dead

- **GIVEN** a Docker sandbox whose container has exited
- **WHEN** `isAlive(ref)` is called
- **THEN** the machine SHALL be reported dead

#### Scenario: Docker OOM-killed container reports the cause

- **GIVEN** a Docker sandbox whose container was killed for exceeding its memory limit (`State.OOMKilled: true`)
- **WHEN** `isAlive(ref)` is called
- **THEN** the machine SHALL be reported dead with the OOM-kill cause

#### Scenario: Transient API error throws

- **GIVEN** the K8s API returns 5xx for `GET pod`
- **WHEN** `isAlive(ref)` is called
- **THEN** it SHALL throw the API error and SHALL NOT silently report the machine dead

### Requirement: teardown and teardownById are idempotent

`teardown(ref)` SHALL run as a DBOS step that deletes the K8s Job (or stops and
removes the Docker container) and clears the active-sandbox registry row. It SHALL
be idempotent: "already gone" is a successful teardown and SHALL NOT throw.
`teardownById(sandboxId)` SHALL delete a machine by id alone — the reaper path,
which holds a `sandboxId` but no full `SandboxRef` — and SHALL NOT touch the
registry (the reaper reconciles the row itself). It too SHALL be idempotent.

#### Scenario: Teardown removes the machine and clears the row

- **GIVEN** a K8s sandbox recorded in the active-sandbox registry
- **WHEN** `teardown(ref)` is called
- **THEN** the Job SHALL be deleted and the step row's `sandbox_ref`/`exec_id` SHALL be cleared

#### Scenario: Teardown of a missing sandbox is a no-op success

- **GIVEN** a sandbox whose backing machine has already been deleted
- **WHEN** `teardown(ref)` is called
- **THEN** the call SHALL return success without throwing

#### Scenario: teardownById deletes by id without registry touch

- **GIVEN** the reaper holding only a `sandboxId`
- **WHEN** `teardownById(sandboxId)` is called
- **THEN** the backend machine SHALL be deleted
- **AND** the call SHALL NOT clear any registry row itself

### Requirement: Active-sandbox registry is queryable by running status

The active-sandbox registry SHALL be the `cortex_step_executions` rows with a
non-null `sandbox_ref` and `status='running'`. `queryActiveSandboxes` SHALL
enumerate exactly those rows (`WHERE status = 'running' AND sandbox_ref IS NOT
NULL`) for the liveness watchdog to shard. `sandbox_ref`/`exec_id` SHALL be
written inside the `sandbox.create` step and cleared inside `teardown`; the
`exec_id` SHALL be re-tagged before each `awaitExec` so the watchdog can target
the in-flight exec.

#### Scenario: Watchdog enumerates only running sandboxes

- **GIVEN** registry rows with statuses `running`, `completed`, and `failed`
- **WHEN** `queryActiveSandboxes` runs
- **THEN** only rows with `status='running'` AND `sandbox_ref IS NOT NULL` SHALL be returned

### Requirement: Liveness watchdog is a sharded scheduled fan-out

The harness SHALL register a `@DBOS.scheduled` parent workflow that fires
approximately once a minute. The parent SHALL checkpoint the active-sandbox read
in a DBOS step, shard the rows by `hash(sandboxId) % SHARD_COUNT` (8), and
`DBOS.startWorkflow` one child check workflow per non-empty shard. No single
invocation SHALL poll all sandboxes — the parent SHALL NOT call `isAlive`
directly. Each child SHALL iterate its shard and call `isAlive` on each row.

#### Scenario: Parent fans out instead of polling

- **GIVEN** active sandboxes spread across S non-empty shards
- **WHEN** the scheduled parent fires
- **THEN** it SHALL call `startWorkflow` once per non-empty shard
- **AND** SHALL NOT call `isAlive` directly

#### Scenario: Child checks only its shard

- **GIVEN** a child check workflow for shard k
- **WHEN** it runs
- **THEN** it SHALL only call `isAlive` for rows whose shard hash equals k

### Requirement: Synthetic-complete on a dead sandbox unblocks recv, guarded against races

When a child watchdog observes a dead machine, it SHALL gate on the owning
workflow's DBOS status before acting. Only if `getWorkflowStatus` returns a
status in `{PENDING, ENQUEUED}` SHALL it `DBOS.send` a `synthetic-failure`
done-marker (`signature: null`, `kind: "synthetic-failure"`) onto
`exec-event:${execId}`. The synthetic failure's reason SHALL be
`"sandbox-oom-killed"` when the liveness check reported an OOM-kill cause, and
`"sandbox-dead"` otherwise, so a memory-limit kill is distinguishable at the
step-failure surface. Delivery SHALL be `DBOS.send` only — there is no
in-memory bus fallback. A dead sandbox whose `getWorkflowStatus` returns `null`
(no workflow) or any non-in-flight status SHALL be **skipped**, not sent to. The
in-flight guard prevents a race with a real `complete` that arrived microseconds
earlier.

#### Scenario: Dead sandbox with in-flight workflow gets a synthetic complete via DBOS.send

- **GIVEN** an active-sandbox row whose machine is dead and whose workflow status is `PENDING`
- **WHEN** the child watchdog processes the row
- **THEN** `DBOS.send` SHALL deliver a `synthetic-failure` done-marker on `exec-event:${execId}` with reason `"sandbox-dead"`

#### Scenario: OOM-killed sandbox carries the OOM reason

- **GIVEN** an active-sandbox row whose machine is dead with an OOM-kill cause and whose workflow status is `PENDING`
- **WHEN** the child watchdog processes the row
- **THEN** the delivered `synthetic-failure` SHALL carry reason `"sandbox-oom-killed"`

#### Scenario: Dead sandbox with null status is skipped

- **GIVEN** an active-sandbox row whose machine is dead and whose `getWorkflowStatus` returns `null`
- **WHEN** the child watchdog processes the row
- **THEN** no send SHALL be issued

#### Scenario: Dead sandbox with terminal workflow is skipped

- **GIVEN** an active-sandbox row whose workflow status is `SUCCESS`
- **WHEN** the child watchdog processes the row
- **THEN** no send SHALL be issued

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
or missing SHALL be reaped via `teardownById`, and the stuck step row SHALL be
reconciled to the workflow's terminal status. A label-less/legacy machine SHALL
be reaped only past a creation-time grace (~10 minutes) so a partially-created
in-flight machine is never caught.

#### Scenario: Terminal-owner machine is reaped and its row reconciled

- **GIVEN** a managed machine whose owning workflow status is `CANCELLED`
- **WHEN** the reaper sweep runs
- **THEN** `teardownById` SHALL delete the machine
- **AND** the stuck `status='running'` step row SHALL be reconciled to `canceled`

#### Scenario: In-flight-owner machine is left alone

- **GIVEN** a managed machine whose owning workflow status is `RUNNING`
- **WHEN** the reaper sweep runs
- **THEN** the machine SHALL NOT be torn down

#### Scenario: Label-less machine reaped only past the grace

- **GIVEN** a managed machine with no owner-workflow label
- **WHEN** the reaper sweep runs before the creation-time grace elapses
- **THEN** the machine SHALL be left alone

### Requirement: Notification-cleanup sweep clears unconsumed DBOS sends

The harness SHALL register a `@DBOS.scheduled` sweep (~5-minute cadence, distinct
from the liveness watchdog) that deletes `dbos.notifications` rows whose target
workflow is terminal (`SUCCESS`/`ERROR`/`CANCELLED`) and `consumed = false`. This
compensates for `DBOS.send` to an already-completed workflow accumulating forever
— guaranteed at the protocol level because a real `complete` may beat the
watchdog's synthetic-failure send, leaving the loser stuck. The delete SHALL be
bounded per run and the row count SHALL be logged.

#### Scenario: Stale notifications cleared for terminal workflows

- **GIVEN** a `dbos.notifications` row with `consumed=false` whose workflow status is `SUCCESS`
- **WHEN** the sweep runs
- **THEN** the row SHALL be deleted

#### Scenario: Live-workflow notifications preserved

- **GIVEN** a `dbos.notifications` row with `consumed=false` whose workflow status is `PENDING`
- **WHEN** the sweep runs
- **THEN** the row SHALL NOT be deleted

#### Scenario: Sweep cadence is separate from the liveness watchdog

- **WHEN** the two scheduled workflows are registered
- **THEN** they SHALL have distinct cron expressions, the sweep firing roughly every 5 minutes and the watchdog roughly every minute
