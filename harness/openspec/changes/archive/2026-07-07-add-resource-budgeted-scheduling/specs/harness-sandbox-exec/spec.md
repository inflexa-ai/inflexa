# harness-sandbox-exec — delta

## MODIFIED Requirements

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
