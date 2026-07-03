## MODIFIED Requirements

### Requirement: On-demand composition of the embedded harness runtime

The system SHALL provide a composition module that boots the embedded harness runtime
on first use and reuses it for the remainder of the process (module singleton). Boot
SHALL sequence: ensure Postgres readiness (via the infra module), start the
exec-callback listener, register the durable workflows with their fully-realized deps
— the child sandbox-step workflow BEFORE the execute-analysis parent (the parent's
deps close over the registered child callable), plus the data-profile workflow and
the sandbox-hygiene scheduled workflows — then launch DBOS, so every registration
lands in one pre-launch cohort. Passive flows (bare `inflexa` launch, TUI startup)
SHALL NOT boot the runtime. A second boot request SHALL return the existing runtime
without re-registering or re-launching.

#### Scenario: First trigger boots the runtime

- **WHEN** a data-profile or analysis-run launch is requested and the runtime has not been booted
- **THEN** Postgres readiness is ensured, the callback listener starts, all workflows are registered (sandbox-step before execute-analysis), and DBOS launches — in that order

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second launch is requested in the same process
- **THEN** no re-registration or re-launch occurs and the existing runtime serves the trigger

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** the runtime boot cannot reach a ready Postgres
- **THEN** boot fails with the infra module's actionable error (e.g. pointing at setup) and DBOS is not launched

#### Scenario: One registration cohort

- **WHEN** the runtime boots and DBOS recovery resumes an in-flight workflow of any registered kind (profile, run parent, run child)
- **THEN** the workflow is found by its registered name — no workflow the cli can trigger is registered after launch

### Requirement: The embedding imports through the harness barrel

Cli code SHALL import harness symbols only from the `@inflexa-ai/harness` barrel. The
barrel SHALL be extended (additive exports only) with the embedder runtime surface the
cli consumes: DBOS lifecycle (`launchDbos`, `shutdownDbos`, `DbosConfig`),
data-profile registration and trigger (with their dep/param/result types),
`StagedInput`, the sandbox client factory and its config types, the workspace
filesystem factory, the exec-callback envelope helpers (`workflowIdFromExec`,
envelope/done-marker types), and the run-engine surface: sandbox-step and
execute-analysis registration (with dep/input/result and agent-build context types),
the sandbox agent catalog factory, plan schema and validation (`AnalysisPlanSchema`,
`validatePlan`, `renderStepPrompt`), plan persistence (`upsertPlan`, `loadPlan`), run
state (insert/query/update run rows, step-execution queries, the dedup-collision
error), the run launcher, and the scheduled-workflow registration functions.

#### Scenario: No deep imports in cli code

- **WHEN** the cli's harness-facing modules are inspected
- **THEN** every harness import resolves from the package barrel, none from deep subpaths

## ADDED Requirements

### Requirement: Local realizations for every analysis-run dependency

The composition SHALL realize the sandbox-step and execute-analysis dep bundles from
deliberate local wiring, reusing the data-profile realizations where the seams are
shared (pool, chat provider, sandbox client, workspace filesystem, session-tree base,
model id, bio keys, local run authorizer). Specific to the run engine:

- The embedding dependency SHALL be a real `EmbeddingProvider` instance constructed
  from the same cli embedding config the profile path uses.
- The run-level billing bracket SHALL be the harness's no-op `RunCharge`.
- The agent builder SHALL resolve each step's agent id against the harness sandbox
  agent catalog, threading the per-step build context (sandbox ref, write prefix,
  lineage collector, blocker holder, function-id/deadline accessors) into the
  catalog's agent deps; an agent id absent from the catalog SHALL fail the step with
  the known-id list.
- The step write prefix SHALL resolve to the harness's `runs/{runId}/{stepId}` path
  convention under the analysis's session tree.
- The artifact registry SHALL be a no-op stub that registers nothing, fails nothing
  (`failedCount: 0`), and treats sync as a local no-op — honest under the seam's
  contract (external registration is absent locally today, and implementations must
  not touch the local ledger). The stub SHALL carry a `TODO(extend)` comment naming
  the provenance bridge (change D of the harness-integration change graph) as its
  replacement. No dependency SHALL be realized as a fake that fabricates success.

#### Scenario: Run deps resolve to their designated backends

- **WHEN** the runtime composes the sandbox-step and execute-analysis dep bundles
- **THEN** chat traffic targets the local proxy, embedding traffic targets the configured embeddings endpoint, and everything else requires only the local Postgres and the Docker daemon

#### Scenario: Step agents come from the harness catalog

- **WHEN** a run step declares agent id `bulk-transcriptomics-agent` (a catalog id)
- **THEN** the built agent is the catalog's definition for that id, wired with the step's sandbox, write prefix, and lineage collector

#### Scenario: Unknown agent id fails visibly

- **WHEN** a step's agent id is not in the catalog (defense-in-depth — plan validation gates this upstream)
- **THEN** the step fails with an error naming the unknown id and the known ids, rather than running a fallback agent

#### Scenario: Stub registry never fails a step

- **WHEN** a step's post-step pipeline registers its artifacts through the stub
- **THEN** the result reports zero failures and no external ids, the local `cortex_artifacts` ledger write (owned by the harness around the seam) proceeds normally, and the step completes

### Requirement: Sandbox-hygiene scheduled workflows registered at boot

The runtime boot SHALL register the harness's sandbox reaper, sandbox watchdog, and
notification sweep scheduled workflows before DBOS launch, wired to the same pool and
sandbox client as the workflow deps. These convert host-kill fallout into bounded
outcomes: orphaned containers are reaped, and a dead sandbox surfaces as a prompt
step failure instead of a hang until the step deadline.

#### Scenario: Killed host's containers are reaped

- **WHEN** the cli process is killed mid-run and a later boot brings the runtime up
- **THEN** sandbox containers the dead process left behind are torn down by the reaper rather than accumulating

#### Scenario: Dead sandbox unblocks its awaiting step

- **WHEN** a step's sandbox dies without posting a completion callback
- **THEN** the watchdog records a synthetic failure completion and the step's recv unblocks before the step deadline
