## ADDED Requirements

### Requirement: run_adhoc launches a plan-less durable run

The conversation agent SHALL be given a `run_adhoc` tool taking a single free-text `prompt` (min 1 char). `run_adhoc` SHALL start the `runAdhoc` durable workflow through `RunLauncher.launch` (fire-and-forget, `workflowId = runId`), return `{ runId }` to the caller without awaiting the run, and emit a `data-run-card` display event so the run appears in the UI. The tool SHALL authorize through `RunAuthorizer` exactly as `execute_plan` does, and SHALL NOT block the chat turn or await the workflow result inline. The retired `run_ephemeral` tool SHALL NOT be registered on the conversation agent.

#### Scenario: run_adhoc returns immediately with a run id

- **GIVEN** a conversation agent calls `run_adhoc({ prompt: "profile the columns of data/inputs/x.csv" })`
- **WHEN** the tool executes
- **THEN** it authorizes via `RunAuthorizer`, calls `RunLauncher.launch` with `workflowId = runId`, emits a `data-run-card`, and returns `{ runId }` without awaiting completion

#### Scenario: run_ephemeral is gone

- **WHEN** the conversation agent's tool registry is inspected
- **THEN** it contains `run_adhoc` and SHALL NOT contain `run_ephemeral`

### Requirement: An adhoc run is a one-step run dispatched through the sandbox-step workflow

`runAdhoc` SHALL insert a run row with `workflow_name = "runAdhoc"` and `plan_id = NULL`, seed exactly one `cortex_step_executions` row (`step_id = "adhoc"`, `wave = 0`, `agent_id = "adhoc-executor"`, `status = "pending"`), and dispatch the existing sandbox-step workflow with a `SandboxStepInput` carrying that step id, agent id, the run's resources, and the composed briefing as `prompt`. `runAdhoc` SHALL NOT synthesize a plan, run `executeAnalysis`, mint a `plan_id`, or run a synthesis phase. All sandbox lifecycle, mounts, the exec protocol, the step timeout, provenance collection, and artifact sync SHALL be those the sandbox-step workflow already provides.

#### Scenario: Adhoc run writes under its own step tree

- **GIVEN** an adhoc run with id `r-1`
- **WHEN** its executor writes a file
- **THEN** the sandbox exposes a read-write mount at `runs/r-1/adhoc/` and the read-only analysis tree at `/{resourceId}`, and produced files are registered in `cortex_artifacts` with `source_run = "r-1"` and `source_step = "adhoc"`

#### Scenario: Adhoc artifacts are readable by later runs

- **GIVEN** an adhoc run has completed and registered an artifact at `runs/r-1/adhoc/output/result.csv`
- **WHEN** any later run (planned or adhoc) starts in the same analysis
- **THEN** that file is visible under the read-only whole-tree mount and can be read by the later run's executor

### Requirement: The adhoc briefing is composed from free text plus workspace and orientation

`runAdhoc` SHALL compose the executor's first user message from three sections: the task section SHALL be the caller's `prompt` verbatim; a workspace section SHALL declare the writable cwd `runs/{runId}/adhoc/` and the read-only analysis root; an orientation section SHALL carry the bounded data-profile projection used by planned steps. The briefing SHALL NOT include an upstream-handoffs section (an adhoc run has no `depends_on`) and SHALL NOT require the caller to supply plan-style fields such as `acceptance_criteria` or `constraints`.

#### Scenario: Briefing carries writable cwd and orientation

- **GIVEN** `run_adhoc({ prompt: "compute summary stats" })` in an analysis with a data profile
- **WHEN** the briefing is composed
- **THEN** the first user message contains the verbatim prompt, a workspace section naming `runs/{runId}/adhoc/` as writable, and the data-profile orientation section — and no upstream-handoffs section

### Requirement: Adhoc results are the step summary; adhoc runs have no synthesis

An adhoc run's deliverable SHALL be its step's persisted files and `summary.md`, produced by the analysis-step standards the adhoc executor carries. `inspect_run` SHALL surface the adhoc step's `summaryPath` for the conversation agent to `read_file`. An adhoc run SHALL have no synthesis phase, no reserved synthesis ledger row, and `inspect_run` SHALL report `synthesisPath = null` for it.

#### Scenario: Inspecting a completed adhoc run

- **GIVEN** a completed adhoc run `r-1`
- **WHEN** `inspect_run({ runId: "r-1" })` is called
- **THEN** the run lists its single `adhoc` step with a `summaryPath` of `runs/r-1/adhoc/output/summary.md`, and the run's `synthesisPath` is `null`

### Requirement: The adhoc executor has write tools and standard resource limits

The `adhoc-executor` sandbox agent SHALL be built with the default sandbox-agent options — the `write_file`/`edit_file` pair present, the analysis-step standards prompt appended — and SHALL NOT be built `readOnly`. Its wall-clock budget SHALL be the standard step timeout (`DEFAULT_STEP_TIMEOUT_SECONDS`, 3600s), and its turn budget SHALL be the agent-meta cap (`SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS`, 50) unless the meta declares a `defaultMaxSteps` override. There SHALL be no per-run wall-clock deadline shared across commands and LLM think-time.

#### Scenario: Adhoc executor can create and execute files

- **GIVEN** an adhoc run whose prompt asks to write and run a script
- **WHEN** the executor runs
- **THEN** it has `write_file`/`edit_file`, writes into `runs/{runId}/adhoc/`, executes via `execute_command`, and each command is bounded by the standard step timeout rather than a shared 120s run deadline
