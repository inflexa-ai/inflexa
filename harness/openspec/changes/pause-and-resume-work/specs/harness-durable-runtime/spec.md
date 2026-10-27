## MODIFIED Requirements

### Requirement: DBOS launches with a stable executor identity and recovers under it

The host SHALL call `launchDbos` after configuring and registering workflows.
`launchDbos` SHALL apply the schedule of each scheduled workflow after the launch,
because DBOS stores a schedule only after its launch.
Configuration SHALL set `executorID` from the host's stable process identity,
and an optional `applicationVersion`. `launchDbos` SHALL set `enablePatching`. Thus,
when the host gives no `applicationVersion`, DBOS keeps one version across upgrades,
and a paused workflow recovers after an upgrade. A change of the operations of a
workflow body SHALL use `DBOS.patch`, thus a recorded execution replays the old path. When the same process slot
relaunches under the same `executorID`, DBOS SHALL be able to reclaim the pending
workflows its predecessor left behind. Core SHALL NOT ship an HTTP recovery route
or a standing recovery component; operator controls for retired executor ids are
a host concern.

#### Scenario: Executor identity is provided by the host

- **GIVEN** a host has chosen executor id `"core-worker-0"`
- **WHEN** `launchDbos` runs
- **THEN** DBOS is configured with `executorID = "core-worker-0"`

#### Scenario: A restart under the same identity can recover in-flight workflows

- **GIVEN** a host process that crashed with pending workflows under `executorID = "core-worker-0"`
- **WHEN** a new process launches under the same `executorID`
- **THEN** DBOS can reclaim those pending workflows without any core-owned recovery route

#### Scenario: A paused workflow recovers after an upgrade

- **GIVEN** a workflow that waits in `paused`, and a host that gives no `applicationVersion`
- **WHEN** a later build of the host, with a changed system prompt and a later DBOS, launches under the same `executorID`
- **THEN** DBOS recovers the workflow, and it waits in `paused` again

### Requirement: The harness throws only at a DBOS boundary or at the tool dispatch

The harness MUST throw an exception only at these places:

- A step or a workflow that must fail.
- A step that DBOS must retry, because DBOS retries a step only on a throw.
- A tool `execute` body. The tool adapter of the loop changes the throw into an error tool result.
- A model call that fails after its retries. The retry envelope of the provider throws the classified `ProviderError`, and the loop throws it out of the run.

`unwrapOrThrow` MUST be the one bridge from a `Result` to a throw. A failure that must fail a step MUST cross the
DBOS boundary as a throw, as the workspace-root-resolution spec also states. Then DBOS records the step as failed.

The harness MUST catch an exception only at a DBOS boundary, an API boundary, a client boundary, or the tool
adapter of the loop. A DBOS boundary is a workflow body that gets the throw of a failed step or a failed child workflow.
Then the body runs its failure path. An API boundary is an entry point
where a caller outside the harness gets the outcome of a call. A client boundary is a thin wrapper around a call to
code outside the harness, for example the `pg` driver or a third-party SDK. The wrapper changes the throw into an
`err`.

An exception from DBOS, for example `DBOSWorkflowCancelledError`, MUST reach DBOS with no change. The harness MUST NOT
change such an exception into an `err`. A call to a host hook has no `try` and no `catch` around it (see the
host-hooks spec). Thus `executeAnalysis` MUST NOT put a `try` or a `catch` around a hook call.

#### Scenario: A cancel from DBOS reaches DBOS with no change

- **GIVEN** a workflow that an operator cancels while a step body runs
- **WHEN** the next DBOS call of the body throws `DBOSWorkflowCancelledError`
- **THEN** the exception reaches DBOS with no change, and no harness code changes it into an `err`

#### Scenario: A failure that must fail a step crosses as a throw

- **GIVEN** a step body whose workspace root does not resolve
- **WHEN** the step runs
- **THEN** the failure crosses the DBOS boundary as a throw through `unwrapOrThrow`, and DBOS records the step as failed

#### Scenario: A client boundary changes a throw into an err

- **GIVEN** a query that the `pg` driver refuses with an exception
- **WHEN** the wrapper of the query catches the exception
- **THEN** the caller of the wrapper gets an `err`, and it gets no exception
