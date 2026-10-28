## MODIFIED Requirements

### Requirement: Container creation is idempotent on a recovery re-run

`createSandbox` MUST be idempotent on the keyed `sandboxId` that the lease workflow gives (see the
harness-sandbox-exec spec). When `createContainer` fails for any reason, the backend MUST inspect
the container under the keyed name. It MUST NOT match a conflict status of one engine. Docker
answers a name collision with HTTP 409, and the compat API of podman answers 500.

If a container stands under the name, the owner guard applies. The backend MUST adopt or replace
that container only when its `cortex/owner-workflow-id` label equals `spec.ownerWorkflowId`, the
id of the lease workflow:

- The backend adopts a running owned container as it is.
- The backend removes a stopped owned container, and it makes the container again.
- The backend refuses a container of a different lease workflow with a `name_conflict` error.

If no container stands under the name, the failure was not a name collision. Then the backend MUST
return the original error of `createContainer`, and never the failure of its inspect. The
harness-sandbox-exec spec owns the decision and its reason.

#### Scenario: Running container adopted on recovery re-run

- **GIVEN** a failed `createContainer` call, and a container under the name that runs with the same `cortex/owner-workflow-id`
- **WHEN** `createSandbox` reconciles it
- **THEN** the backend adopts the container as it is, and it verifies the health again

#### Scenario: Foreign owner is refused

- **GIVEN** a failed `createContainer` call, and a container under the name with a different `cortex/owner-workflow-id`
- **WHEN** `createSandbox` reconciles it
- **THEN** it returns a `name_conflict` error, and it does not adopt or remove the container

#### Scenario: Adoption works on an engine that answers name conflicts with 500

- **GIVEN** an engine that refuses a duplicate name with HTTP 500, and a running container of this lease workflow under the keyed name
- **WHEN** `createSandbox` runs again after a recovery
- **THEN** the backend adopts the container, as it does after a Docker 409

#### Scenario: A non-conflict create failure is returned unchanged

- **GIVEN** a `createContainer` call that fails while no container stands under the keyed name
- **WHEN** `createSandbox` inspects the name and finds nothing
- **THEN** it returns the original `container_create_failed` error, not the 404 of the inspect

## ADDED Requirements

### Requirement: Managed containers are listed for the reconciler

Each container that the Docker backend makes MUST carry the host labels, the harness labels, and the label `cortex/owner-workflow-id={ownerWorkflowId}` (see the sandbox-labels spec). `listManagedSandboxes` MUST list the containers with `app.kubernetes.io/managed-by=cortex`. It MUST give the `sandboxId`, the `ownerWorkflowId`, and the creation time of each. Thus the reconciler maps a machine to its lease workflow.

#### Scenario: Managed containers are enumerable for the reconciler

- **GIVEN** two running sandbox containers labeled `app.kubernetes.io/managed-by=cortex`
- **WHEN** `listManagedSandboxes()` is called
- **THEN** it returns both, each carrying its `sandboxId` and `ownerWorkflowId` label values

#### Scenario: A container carries the host labels and the analysis id

- **GIVEN** a label hook that gives `{ "example.com/tenant": "acme" }` and a session for the analysis `an-1`
- **WHEN** the Docker backend makes the container
- **THEN** the container carries `example.com/tenant=acme` and `cortex/analysis-id=an-1`
- **AND** `listManagedSandboxes()` returns the container, because it carries `app.kubernetes.io/managed-by=cortex`

#### Scenario: The reconciler removes a machine whose lease workflow ended

- **GIVEN** a managed sandbox whose `cortex/owner-workflow-id` names a terminal lease workflow
- **WHEN** the reconciler runs
- **THEN** it calls `teardownById(sandboxId)`, and it changes no row of `cortex_step_executions`

### Requirement: The owner workflow id round-trips with no change

`ownerWorkflowId` is a DBOS lookup key. Thus each backend MUST record and return it with no change. A backend MUST report `null` when it holds no id with no change, because a lookup of a changed id proves nothing about the owner. Docker stores the id as a label value. A backend that cannot hold the id in a label MUST record it in a different metadata field, as K8s does with a Job annotation.

#### Scenario: An owner id no label namespace could hold still round-trips

- **GIVEN** a sandbox with an `ownerWorkflowId` that is longer than the K8s label limit, and that holds characters that a label refuses
- **WHEN** `listManagedSandboxes()` is called
- **THEN** the reported `ownerWorkflowId` is equal to the given `ownerWorkflowId`, byte for byte

#### Scenario: A machine recording no owner reports none

- **GIVEN** a managed machine carrying no owner workflow id
- **WHEN** `listManagedSandboxes()` is called
- **THEN** the reported `ownerWorkflowId` is `null`

## REMOVED Requirements

### Requirement: Sandbox containers labeled for managed-sweep cleanup

**Reason**: The reconciler of the sandbox module replaces the reaper, and the owner of a machine is its lease workflow. The requirements "Managed containers are listed for the reconciler" and "The owner workflow id round-trips with no change" replace it.

**Migration**: None for the Docker backend. The label key `cortex/owner-workflow-id` stays, and its value is the id of the lease workflow.
