# analysis-run-launch Delta

## MODIFIED Requirements

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

### Requirement: Read-only run status view

The command MUST offer a status mode. That mode reports the analysis's runs and their steps from the harness ledger.

The status mode is a client of the local server. It reads the newest runs of the analysis through the run list route of the server. It reads the steps of each run through the run route, with a fixed number of reads at one time. Each run row shows the title of its plan. A run whose step read fails still prints, with no steps.

The status mode MUST NOT boot a runtime in its own process, provision anything, or write any state. A status mode that finds no local server starts one, the same as each instance command, and the server boots the runtime at its start. While the runtime of the server is not ready, the read refuses with the unavailable answer of the server.

#### Scenario: Status never boots

- **WHEN** the status mode is invoked
- **THEN** run and step states are reported from the local server (or "none")
- **AND** its own process launched no DBOS, bound no listener, staged nothing, and provisioned nothing
