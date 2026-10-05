## ADDED Requirements

### Requirement: The composition boots the embedded harness runtime once

The system MUST give a composition module that boots the embedded harness
runtime and uses it again for the remainder of the process. Two processes MUST
boot it:

- the local server, at its start, after it binds its port
- the dev `inflexa run --plan`, before its launch.

Another process MUST NOT boot the runtime. The TUI and each instance command reach
the runtime of the local server through its HTTP API.

The boot MUST carry no analysis. One runtime serves each analysis of the
machine. Thus each seam whose value depends on the analysis MUST resolve it from
the session of each call, never from a value fixed at boot.

The boot MUST do these steps in this order:

1. Make sure that Postgres is ready.
2. Take the machine-wide runtime lock.
3. Register the durable workflows with fully realized deps: sandbox-step before
   execute-analysis, and the data-profile and sandbox-hygiene scheduled
   workflows.
4. Run the pre-launch migration and hooks.
5. Launch DBOS.

The boot MUST register no ephemeral execution workflow. The boot MUST bind no
listener for sandbox callbacks, because the harness polls each sandbox and the
sandbox initiates nothing. A boot that finds the runtime lock held by a
different live process MUST fail with an error that names the holder pid, and
it MUST launch nothing. A second boot request in the same process MUST return
the singleton with no second registration and no second launch.

#### Scenario: First trigger boots the runtime

- **WHEN** the start of the local server first requests the runtime
- **THEN** Postgres is ready, the non-ephemeral workflow cohort is registered, the legacy pre-launch migration and hooks run, and DBOS launches, in that order
- **AND** no listener for sandbox callbacks is bound

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second boot is requested in the same process
- **THEN** no second registration and no second launch occur

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** the runtime boot cannot reach a ready Postgres
- **THEN** the boot fails with an actionable message, and DBOS is not launched

#### Scenario: One registration cohort

- **WHEN** recovery resumes a supported in-flight workflow
- **THEN** its registered name exists in the one pre-launch cohort

#### Scenario: A second runtime on the machine is refused

- **GIVEN** the local server holds the runtime
- **WHEN** `inflexa run --plan` boots a runtime
- **THEN** the boot fails with an error that names the pid of the local server, and DBOS is not launched

### Requirement: The sandbox reaper and the notification sweep register at boot

The runtime boot MUST register the sandbox reaper and the notification sweep of
the harness before the DBOS launch. The two scheduled workflows MUST use the same
pool and sandbox client as the workflow deps. The reaper removes the containers
that a killed host left behind. The boot MUST register no liveness watchdog. Each
exec of the harness probes the liveness of its own sandbox, thus a dead sandbox
fails its step before the step deadline.

#### Scenario: Killed host's containers are reaped

- **WHEN** the cli process is killed mid-run and a later boot brings the runtime up
- **THEN** the reaper removes the sandbox containers that the dead process left behind, and they do not accumulate

#### Scenario: No watchdog registers

- **WHEN** the runtime boots
- **THEN** it registers the reaper and the notification sweep, and it registers no watchdog

## MODIFIED Requirements

### Requirement: Local realizations for every data-profile dependency

The composition SHALL realize `DataProfileDeps` from deliberate local wiring: the
`pg.Pool` built from the infra module's resolved `PostgresConnection`; the harness's
local run authorizer and no-op billing resolver; the chat provider constructed from
the RESOLVED model connection (see `model-connection`: the local proxy's
Anthropic-shaped Messages endpoint in `cliproxy` mode, the configured endpoint and
protocol in `direct` mode) through the harness's exported provider factory; the
embedding provider resolved from the
top-level `embedding` config key via `resolveEmbedder` (mode-based: in-process local
model or a DIRECT OpenAI-compatible endpoint — never through the chat connection,
which serves no embeddings route), verified with one real probe embedding through
that very provider instance BEFORE any provisioning or registration — embeddings are
consumed late in the profile workflow, so a broken embedder must fail while failure
is still free, and the probe vector's width must match the provider's advertised
`dimensions`, which sizes the per-analysis search index; a workspace filesystem and
sandbox client (Docker backend) sharing
the runtime's single session-tree base; bio-tool keys from cli config with absent keys
passed as empty; and the shared skills directory. No dependency SHALL be realized as a
fake that fabricates success — a locally unrealizable capability must fail visibly at
the point of use.

#### Scenario: Deps resolve to their designated backends

- **WHEN** the runtime composes the data-profile deps bundle
- **THEN** chat traffic targets the resolved model connection (the local proxy in `cliproxy` mode, the configured endpoint in `direct` mode), embeddings go through the resolved provider (in-process model, or directly to the configured endpoint), and everything else requires only the local Postgres and the Docker daemon

#### Scenario: Unconfigured bio keys degrade per-tool, not at boot

- **WHEN** no bio/chem API keys are configured
- **THEN** the runtime boots and profiles run; only the affected tools surface auth errors when invoked

#### Scenario: Broken embedder blocks boot before side effects

- **WHEN** the resolved embedder cannot be built from config, fails or times out on the probe embedding, or emits vectors of a width other than it advertises
- **THEN** boot fails naming the remedy, before Postgres provisioning, registration, or launch

### Requirement: Graceful runtime shutdown

On cli process exit after the runtime has booted, the system SHALL shut DBOS down
(marking in-flight workflows recoverable). Shutdown failures SHALL NOT prevent the remainder of
the exit sequence.

#### Scenario: Exit with an in-flight profile

- **WHEN** the cli exits while a profile workflow is running
- **THEN** DBOS shutdown marks it recoverable and a later runtime boot resumes it

### Requirement: The embedding imports through the harness barrel

Cli code SHALL import harness symbols only from the `@inflexa-ai/harness` barrel. The
barrel SHALL be extended (additive exports only) with the embedder runtime surface the
cli consumes: DBOS lifecycle (`launchDbos`, `shutdownDbos`, `DbosConfig`),
data-profile registration and trigger (with their dep/param/result types),
`StagedInput`, the sandbox client factory and its config types, the workspace
filesystem factory, the run-engine surface: sandbox-step and
execute-analysis registration (with dep/input/result and agent-build context types),
the sandbox agent catalog factory, plan schema and validation (`AnalysisPlanSchema`,
`validatePlan`), plan persistence (`upsertPlan`, `loadPlan`), run
state (insert/query/update run rows, step-execution queries, the dedup-collision
error), the run launcher, and the scheduled-workflow registration functions; the
provider error surface (`ProviderError`, `toProviderError`); and the conversation
surface: the composition root and its dep types (`assembleCoreRuntime`, the
`CoreRuntimeDeps` family), the thread-agent resolution surface (`ThreadAgentResolver`,
`UnregisteredThreadType`, the `ThreadType` vocabulary), the chat-turn preparation and
persistence functions with their types (`prepareChatTurn`, the thread store/history
factories, `StoredMessage`), the history display readers (`contentToCortexMessages`,
`createCardResolver`), the streaming-chat provider wrapper (`createStreamingChat`) and
`AgentChat`, the pass-through run step (`passthroughStep`), the ephemeral pre-launch
sweep (`sweepEphemeralWorkflows`), the unavailable preview publisher, the
`contracts/` chat-event and chat-part types, and the tool-call-detail authoring
aids (`DETAIL_MAX_LENGTH`, `normalizeDetail`).

A cli `describeCall` hook that pre-empts truncation SHALL gate on `DETAIL_MAX_LENGTH`
from the barrel. A copy of the number in cli code drifts when the harness retunes
its own cap. The hook then states a bound the emit site does not enforce.

#### Scenario: No deep imports in cli code

- **WHEN** the cli's harness-facing modules are inspected
- **THEN** every harness import resolves from the package barrel, none from deep subpaths

#### Scenario: The turn engine reaches the resolver through the barrel

- **WHEN** the turn engine types its resolver argument and its refusal outcome
- **THEN** `ThreadAgentResolver` and `UnregisteredThreadType` resolve from the package barrel

## REMOVED Requirements

### Requirement: Composition of the embedded harness runtime

**Reason**: The CLI has no callback mode now, thus the callback listener step and its scenario no longer apply.

**Migration**: Refer to "The composition boots the embedded harness runtime once".

### Requirement: Exec-callback ingress bridges sandbox HTTP callbacks to DBOS topics

**Reason**: The harness removed the callback transport. Each exec polls its sandbox inside one DBOS step, and the sandbox sends nothing to the host.

**Migration**: None. The cli removed `ingress.ts`, and the sandbox client config has no `transport` and no `cortexBaseUrl`.

### Requirement: Sandbox-hygiene scheduled workflows registered at boot

**Reason**: The harness removed the liveness watchdog.

**Migration**: Refer to "The sandbox reaper and the notification sweep register at boot".
