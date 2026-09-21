## MODIFIED Requirements

### Requirement: Container lifecycle via the Docker API

`createDockerSandboxOps.createSandbox` MUST make a Docker container from `spec.image ?? config.image`
with bind mounts, CPU/memory limits, env vars, and dynamic port mapping (`0:8765`). It SHALL start the container,
retrieve the mapped host port, and poll the sandbox-server `/health` endpoint
until it responds 200 (default 30s budget). `teardown(ref)` and
`teardownById(sandboxId)` SHALL stop and remove the container, treating a 404
(already gone) as idempotent success.

The client MUST give the op the session, the spec, and the identity of the call
`createSandbox(session, spec, identity)`. The op MUST use the ids of the session:
`session.scope.analysisId`, `session.runFrame.runId`, and `session.runFrame.stepId`. The client
gets the host labels from its label hook, and it gives them to the op (see the sandbox-labels
spec). The spec carries no label.

#### Scenario: Container starts and becomes healthy

- **WHEN** `createSandbox(session, spec, identity)` is called
- **THEN** a Docker container named `identity.sandboxId` is created and started
- **AND** the mapped host port is retrieved via the Docker API
- **AND** the sandbox-server `/health` endpoint is polled until it responds 200
- **AND** the returned `SandboxRef` carries `host: "127.0.0.1"` and the mapped port

#### Scenario: The step mount takes its ids from the session

- **GIVEN** a `SpawnSession` for the analysis `an-1`, the run `run-1`, and the step `step-a`
- **WHEN** `createSandbox(session, spec, identity)` is called
- **THEN** the container mounts the step directory read-write at `/an-1/runs/run-1/step-a`

#### Scenario: Container yields no mapped port

- **WHEN** `createSandbox` finds no host port mapped for `8765/tcp` after start
- **THEN** it stops and removes the container and returns a `container_create_failed` error

#### Scenario: Health check timeout

- **WHEN** sandbox-server does not respond 200 to `/health` within the timeout
- **THEN** `createSandbox` returns a `container_create_failed` error including the last failure detail

### Requirement: Image source is config default overridden per step

The Docker backend MUST use `spec.image` when the workflow gives a per-step image override.
Otherwise, it MUST use the `config.image` default. There is
no `SANDBOX_IMAGE` env read in this layer.

#### Scenario: Per-step image override wins

- **GIVEN** `config.image` is `sandbox-base:latest` and `spec.image` is `sandbox-base:pinned`
- **WHEN** the container is created
- **THEN** the container image is `sandbox-base:pinned`

### Requirement: Sandbox containers labeled for managed-sweep cleanup

Each container that the Docker backend makes MUST carry the labels that the sandbox-labels spec
gives for Docker: the host labels, the harness labels, and the label
`cortex/owner-workflow-id={childWorkflowId}`. The reaper uses three of them:
`app.kubernetes.io/managed-by=cortex`, `cortex/sandbox-id`, and `cortex/owner-workflow-id`. `listManagedSandboxes`
SHALL enumerate containers filtered by `app.kubernetes.io/managed-by=cortex`,
returning each one's `sandboxId`, `ownerWorkflowId`, and creation time, so the
scheduled reaper (`registerSandboxReaper`) can map a machine back to its owning
workflow and tear down orphans.

`ownerWorkflowId` is a DBOS lookup key, so every backend SHALL record and return
it verbatim, and SHALL report `null` rather than a rewritten value when it holds
no verbatim id: a lookup that fails against a lossy id proves nothing about the
owning workflow, so a lossy id is worse than none. Docker label values are
unconstrained, so this backend stores the id as given. If a backend cannot hold the id in a
label with no change, it MUST record the id in a different metadata field. The sandbox-labels
spec gives this case for K8s, where the id is a Job annotation.

#### Scenario: Managed containers are enumerable for the reaper

- **GIVEN** two running sandbox containers labeled `app.kubernetes.io/managed-by=cortex`
- **WHEN** `listManagedSandboxes()` is called
- **THEN** it returns both, each carrying its `sandboxId` and `ownerWorkflowId` label values

#### Scenario: A container carries the host labels and the analysis id

- **GIVEN** a label hook that gives `{ "example.com/tenant": "acme" }` and a session for the analysis `an-1`
- **WHEN** the Docker backend makes the container
- **THEN** the container carries `example.com/tenant=acme` and `cortex/analysis-id=an-1`
- **AND** `listManagedSandboxes()` returns the container, because it carries `app.kubernetes.io/managed-by=cortex`

#### Scenario: An owner id no label namespace could hold still round-trips

- **GIVEN** a sandbox created with a `childWorkflowId` that exceeds the K8s label
  value cap and carries characters illegal in one
- **WHEN** `listManagedSandboxes()` is called
- **THEN** the reported `ownerWorkflowId` SHALL equal the `childWorkflowId` byte for byte

#### Scenario: A machine recording no owner reports none

- **GIVEN** a managed machine carrying no owner workflow id
- **WHEN** `listManagedSandboxes()` is called
- **THEN** the reported `ownerWorkflowId` SHALL be `null`

#### Scenario: Reaper tears down an orphaned machine

- **GIVEN** a managed sandbox whose `cortex/owner-workflow-id` workflow is terminal or missing
- **WHEN** the reaper sweep runs
- **THEN** it calls `teardownById(sandboxId)` and reconciles the step row to a terminal status

### Requirement: Container creation is idempotent on a recovery re-run

`createSandbox` SHALL be idempotent on the checkpointed `sandboxId`. When
`createContainer` fails for any reason, the backend SHALL inspect the container
under the checkpointed name rather than matching an engine-specific conflict
status: Docker answers a name collision with HTTP 409, podman's compat API
answers 500, and the reconciliation MUST NOT depend on either. If a container
stands under the name, the owner-guard applies. The backend MUST adopt or replace that container
only when its `cortex/owner-workflow-id` label equals `spec.childWorkflowId`. A
running owned container is adopted as-is; a stopped owned container is removed
and recreated; a container owned by a different step is refused with a
`name_conflict` error. If no container stands under the name, the failure was
not a name collision and the backend SHALL return the **original create
error** — the inspect's own failure is never surfaced. The decision and its
rationale are owned by the harness-sandbox-exec spec.

#### Scenario: Running container adopted on recovery re-run

- **GIVEN** a failed create whose existing container is running and labeled with the same `cortex/owner-workflow-id`
- **WHEN** `createSandbox` reconciles it
- **THEN** the existing container is adopted without recreation and its health is re-verified

#### Scenario: Foreign owner is refused

- **GIVEN** a failed create whose existing container is labeled with a different `cortex/owner-workflow-id`
- **WHEN** `createSandbox` reconciles it
- **THEN** it returns a `name_conflict` error and neither adopts nor removes the container

#### Scenario: Adoption works on an engine that answers name conflicts with 500

- **GIVEN** an engine that rejects a duplicate-name create with HTTP 500 and a running container owned by this workflow standing under the checkpointed name
- **WHEN** `createSandbox` retries after a recovery
- **THEN** the standing container is adopted exactly as it would be after a Docker 409

#### Scenario: A non-conflict create failure is returned unchanged

- **GIVEN** a create that fails while no container stands under the checkpointed name
- **WHEN** `createSandbox` inspects the name and finds nothing
- **THEN** it returns the original `container_create_failed` error, not the inspect's 404
