# analysis-run-launch Specification

## Purpose

The deliberate `inflexa run` action. It launches a full `executeAnalysis` run from a validated plan file, then blocks to a terminal run status with live progress. It also gives a read-only status view.

This is the model-free replay path. It replicates the harness's own `executePlan` trigger flow, because a file-driven launch has no chat turn that supplies a live tool context. The conversation-agent path is `inflexa chat`. The daemon trigger endpoint at #33 M2 absorbs the internals of the replica.

Lives in `src/modules/harness/dev/run.ts`. The shared wait and status-pool readers are in `src/modules/harness/dev/status.ts`.

## Requirements

### Requirement: Launching an analysis run is a deliberate action

The system MUST give a dedicated command that launches a full `executeAnalysis` run for a resolved analysis from a validated plan.

The command runs with no local server. It resolves the analysis from the local database, and it boots a runtime in its own process. Only one runtime runs on a machine at one time. Thus the command MUST refuse while the local server, or a different process, holds the runtime or the lock of the analysis. The refusal names the process, and it comes before any staging, persistence, or launch.

The command MUST do these steps in this order:

1. Resolve the analysis reference.
2. Do the pre-flight prerequisite gates. These are the same actionable gates as the profile launch: the sandbox image, the embedding endpoint, the skills directory, the proxy key, the model, and Postgres. The analysis workspace root must also resolve to a writable location.
3. Validate the plan file. These are the pure parse, schema, and `validatePlan` gates, and they persist nothing.
4. Claim the lock of the analysis, then boot the embedded runtime.
5. Stage the analysis's inputs into the analysis workspace (`{workspaceRoot}/data`, with mirror reconciliation). The run engine never downloads.
6. Seed the harness analysis ledger row.
7. Persist the validated plan under its deterministic id.
8. Trigger the run.

The plan validation MUST come before the boot, per the plan-intake spec. Thus a malformed or invalid plan is refused before any side effect: no boot, no staging, and no ledger row. Only the deterministic-id persistence needs the booted pool.

A passive flow MUST NOT trigger a run. A bare `inflexa` launch and the TUI startup are passive flows. A run starts only from this command, or from the `execute_analysis` tool inside a chat turn in the local server.

An analysis with no resolvable inputs MUST stop before the boot, and give an actionable message. An unresolvable or non-writable workspace root MUST stop the command the same way. There is no fallback location.

#### Scenario: Full launch sequence on a prepared analysis

- **WHEN** the command runs for an analysis with resolvable inputs, a valid plan file, and satisfied prerequisites
- **THEN** inputs are staged under the analysis workspace and the plan is persisted
- **AND** an `executeAnalysis` workflow is launched, whose run row exists in the harness ledger

#### Scenario: Failed prerequisite is reported before side effects

- **WHEN** a prerequisite fails pre-flight, for example an absent sandbox image or an unreachable embeddings endpoint
- **THEN** the command exits with that prerequisite's actionable message, and it produced no staging, no plan persistence, and no run row

#### Scenario: Invalid plan is rejected before boot

- **WHEN** the plan file is unreadable, is not valid JSON, fails the plan schema, or fails `validatePlan` (a cycle, an unknown agent, absent resources, or zero steps)
- **THEN** the command exits with the plan's actionable error before the runtime boots
- **AND** the runtime never starts, nothing is staged, and no ledger row or plan row is written

#### Scenario: Non-writable workspace blocks the launch before side effects

- **WHEN** the analysis's workspace root cannot resolve or is not writable
- **THEN** the command exits with the workspace's actionable message before the boot, the staging, or any ledger write

#### Scenario: Missing completed data profile warns but does not block

- **WHEN** the analysis has no completed data profile in the harness ledger
- **THEN** the command gives a warning, because agents orient on the profile summary, and it continues with the launch

#### Scenario: A running local server refuses the launch

- **GIVEN** the local server runs and holds the runtime
- **WHEN** the command runs
- **THEN** it exits with a message that names the process that holds the analysis or the runtime
- **AND** it staged nothing, persisted no plan, and launched no workflow

### Requirement: Trigger semantics match the harness's own plan-execution flow

The launch MUST obey the same sequence that the harness's `executePlan` tool does. It MUST use the harness's exported state functions and its run launcher.

The sequence has these steps:

1. Look for an active run of the same plan, to dedup against it. The partial-unique index is the race backstop, and a dedup collision resolves to the winner's run.
2. Reserve the run row, before the authorization.
3. Authorize through the local run authorizer.
4. Build the workflow input from the plan. This is the per-step plan-step data, plus the agent, resource, and timeout maps, plus the plan summary from the title or the narrative. The harness composes each step's seed at dispatch, so the cli passes the step data and never a rendered prompt.
5. Launch, with the workflow id equal to the run id.

If the authorization or the launch fails, the command MUST mark the reserved row failed. It MUST also revoke the authorization when it issued one. Thus a retry can run again.

#### Scenario: Active run dedups instead of double-launching

- **WHEN** a launch is requested while a run for the same analysis and plan id is active
- **THEN** the command reports the existing run (id and status) and does not authorize or launch a second workflow

#### Scenario: Launch failure releases the dedup slot

- **WHEN** the workflow dispatch fails after the run row was reserved
- **THEN** the row is marked failed and a subsequent invocation can launch fresh

### Requirement: The command blocks to a terminal state with live progress

The command MUST block until the run reaches a terminal status. The terminal statuses are `completed`, `partial`, `failed`, `canceled`, and `suspended_insufficient_funds`. The durable workflow runs inside the DBOS runtime of the cli process. Thus an exit after the trigger would orphan the run until a future boot.

The command MUST show live progress while it blocks. It reads the per-step dispatch and completion from the harness's step-execution and workflow-progress records. A progress read is best-effort, and it MUST NOT abort the wait.

Each terminal status MUST map to a different outcome message. A failed or partial outcome MUST name the steps that failed.

If the user interrupts the wait with Ctrl+C, the command MUST detach with DBOS-recoverable semantics. The run is then marked recoverable and it resumes on a future runtime boot. The detach message MUST say so.

#### Scenario: Successful run reports completion

- **WHEN** every step completes and synthesis finishes
- **THEN** the command reports `completed` with the step list and exits cleanly (the process drains, with no hang)

#### Scenario: Step failure surfaces fail-fast outcome

- **WHEN** a step fails and the harness cancels the in-flight siblings
- **THEN** the command reports the run's terminal status and names each step that failed

#### Scenario: Ctrl+C detaches without killing the run's durability

- **WHEN** the user interrupts the blocking wait
- **THEN** the process exits after the DBOS shutdown marks the workflow recoverable, and the message names how to observe or resume it

### Requirement: Read-only run status view

The command MUST offer a status mode. That mode reports the analysis's runs and their steps from the harness ledger.

The status mode is a client of the local server. It reads the newest runs of the analysis through the run list route of the server. It reads the steps of each run through the run route, with a fixed number of reads at one time. Each run row shows the title of its plan. A run whose step read fails still prints, with no steps.

The status mode MUST NOT boot a runtime in its own process, provision anything, or write any state. A status mode that finds no local server starts one, the same as each instance command, and the server boots the runtime at its start. While the runtime of the server is not ready, the read refuses with the unavailable answer of the server.

#### Scenario: Status never boots

- **WHEN** the status mode is invoked
- **THEN** run and step states are reported from the local server (or "none")
- **AND** its own process launched no DBOS, bound no listener, staged nothing, and provisioned nothing

### Requirement: Kill/resume durability is verified end-to-end

The change MUST prove DBOS crash recovery against the embedded runtime, with a live run. The proof is to kill the cli mid-workflow, to boot again, and then to confirm two things: the workflow resumes to a terminal state, and the status views report it.

The proof MUST cover both durable workflow types: the analysis-run path (`executeAnalysis`) and the data-profile path (`runDataProfile`).

One recovery path reclaims both. There is one runtime and the executor is `local`, and the launch resolves each in-flight workflow by its registered name. Thus the next boot adopts a killed workflow of either type, `recovery_attempts` increments, and the workflow runs to a terminal state under its original id. The status views then report the outcome.

#### Scenario: Killed run resumes on next boot

- **WHEN** the cli is killed while a run workflow is in flight and the cli later boots the runtime again
- **THEN** DBOS recovery resumes the run under the same run id, it reaches a terminal state, and the status view shows the outcome

#### Scenario: Killed data profile resumes on next boot

- **WHEN** the cli is killed while a data-profile workflow is in flight and the cli later boots the runtime again
- **THEN** DBOS recovery resumes the profile under the same workflow id, it reaches a terminal state, and `inflexa profile --status` shows the outcome
