# harness-runtime Specification

## Purpose
The embedding seam between the cli and `@inflexa-ai/harness`: a lazy, process-singleton composition root that provisions/boots the runtime (Postgres readiness, exec-callback ingress, cortex schema, workflow registration, DBOS launch), realizes every `DataProfileDeps` seam locally, and tears down gracefully on exit. Owns the single global session-tree base and the loopback HTTP ingress that bridges sandbox-server callbacks onto DBOS topics. Lives in `src/modules/harness/`.
## Requirements
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

### Requirement: Local realizations for every data-profile dependency

The composition SHALL realize `DataProfileDeps` from deliberate local wiring: the
`pg.Pool` built from the infra module's resolved `PostgresConnection`; the harness's
local run authorizer and no-op billing resolver; the chat provider pointed at the local
proxy's Anthropic-shaped Messages endpoint; the embedding provider resolved from the
top-level `embedding` config key via `resolveEmbedder` (mode-based: in-process local
model or a DIRECT OpenAI-compatible endpoint — never through the chat proxy, which
serves no embeddings route), verified with one real probe embedding through that very
provider instance BEFORE any provisioning or registration — embeddings are consumed
late in the profile workflow, so a broken embedder must fail while failure is still
free, and the probe vector's width must match the provider's advertised `dimensions`,
which sizes the per-analysis search index; a workspace filesystem and sandbox client (Docker
backend) sharing
the runtime's single session-tree base; bio-tool keys from cli config with absent keys
passed as empty; and the shared skills directory. No dependency SHALL be realized as a
fake that fabricates success — a locally unrealizable capability must fail visibly at
the point of use.

#### Scenario: Deps resolve to their designated backends

- **WHEN** the runtime composes the data-profile deps bundle
- **THEN** chat traffic targets the local proxy, embeddings go through the resolved provider (in-process model, or directly to the configured endpoint), and everything else requires only the local Postgres and the Docker daemon

#### Scenario: Unconfigured bio keys degrade per-tool, not at boot

- **WHEN** no bio/chem API keys are configured
- **THEN** the runtime boots and profiles run; only the affected tools surface auth errors when invoked

#### Scenario: Broken embedder blocks boot before side effects

- **WHEN** the resolved embedder cannot be built from config, fails or times out on the probe embedding, or emits vectors of a width other than it advertises
- **THEN** boot fails naming the remedy, before Postgres provisioning, listener start, registration, or launch

### Requirement: Single global session-tree base

The system SHALL expose one path helper for the session-tree base
(`{cli data dir}/sessions`), and staging targets, the sandbox client's
`sessionsBasePath`, and the workspace filesystem SHALL all derive from it. Per-analysis
bases are prohibited: workflow deps are closed over once at registration, so the base
cannot vary by analysis.

#### Scenario: One base across all consumers

- **WHEN** an analysis is staged and profiled
- **THEN** the staged files, the sandbox bind mount source, and workspace filesystem reads all resolve under `{base}/{analysisId}/…` for the same `{base}`

### Requirement: Exec-callback ingress bridges sandbox HTTP callbacks to DBOS topics

The runtime SHALL host a loopback-only HTTP listener accepting
`POST /sandbox/{execId}/{kind}` for `kind` ∈ {`event`, `complete`}. Each accepted
request SHALL be enveloped as `{payload, payloadRaw, signature, timestamp}` from the
body and the `X-Sandbox-Signature`/`X-Sandbox-Timestamp` headers (absent headers as
null), with `complete` payloads wrapped in the done-marker shape, and delivered to the
workflow derived from the execId via the harness's exec-event delivery helper (never a
cli-side `DBOS.send` — the SDK is module-singleton state and a second copy is
un-launched).
The listener SHALL NOT verify HMAC signatures (verification is the workflow body's
job) and SHALL NOT hold callback secrets. An execId from which no workflow id can be
derived SHALL yield a 4xx (the sandbox-server gives up); a failed send SHALL yield a
5xx (the sandbox-server retries). The sandbox client's `cortexBaseUrl` SHALL be a URL
under which sandbox containers reach this listener.

#### Scenario: Event callback reaches the awaiting workflow

- **WHEN** the sandbox-server POSTs an exec event to `/sandbox/{execId}/event`
- **THEN** the enveloped message is sent to topic `exec-event:{execId}` of the workflow derived from the execId and the listener replies 2xx

#### Scenario: Completion callback is wrapped as a done-marker

- **WHEN** the sandbox-server POSTs to `/sandbox/{execId}/complete`
- **THEN** the delivered envelope's payload is the done-marker form carrying the exec result

#### Scenario: Malformed execId is a permanent rejection

- **WHEN** a POST arrives whose execId yields no derivable workflow id
- **THEN** the listener replies 4xx and delivers nothing

### Requirement: Graceful runtime shutdown

On cli process exit after the runtime has booted, the system SHALL shut DBOS down
(marking in-flight workflows recoverable) and close the callback listener. Shutdown
failures SHALL NOT prevent the remainder of the exit sequence.

#### Scenario: Exit with an in-flight profile

- **WHEN** the cli exits while a profile workflow is running
- **THEN** DBOS shutdown marks it recoverable and a later runtime boot resumes it

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
- The artifact registry SHALL be the provenance bus adapter (see
  `prov-harness-bridge`): registration emits `prov.file_written` /
  `prov.input_used` bus events feeding the analysis's signed tsprov document, and
  sync stays a local no-op. The adapter never touches harness-owned tables and never
  emits step lifecycle events.
- `ExecuteAnalysisDeps.emitProvenance` SHALL be realized as the bus mapping for all
  three lifecycle arms (`prov.run_started` / `prov.step_completed` /
  `prov.run_completed` with the system actor and pass-through timestamps — see
  `prov-harness-bridge`).
- No dependency SHALL be realized as a fake that fabricates success.

#### Scenario: Run deps resolve to their designated backends

- **WHEN** the runtime composes the sandbox-step and execute-analysis dep bundles
- **THEN** chat traffic targets the local proxy, embedding traffic targets the configured embeddings endpoint, and everything else requires only the local Postgres and the Docker daemon

#### Scenario: Step agents come from the harness catalog

- **WHEN** a run step declares agent id `bulk-transcriptomics-agent` (a catalog id)
- **THEN** the built agent is the catalog's definition for that id, wired with the step's sandbox, write prefix, and lineage collector

#### Scenario: Unknown agent id fails visibly

- **WHEN** a step's agent id is not in the catalog (defense-in-depth — plan validation gates this upstream)
- **THEN** the step fails with an error naming the unknown id and the known ids, rather than running a fallback agent

#### Scenario: Registration feeds the signed document without failing the step

- **WHEN** a step's post-step pipeline registers its artifacts through the bus adapter
- **THEN** the file and used-input provenance events are emitted, the result reports the registered paths with their PROV QNames as external ids and zero failures, the local `cortex_artifacts` ledger write (owned by the harness around the seam) proceeds normally, and the step completes — its step activity arriving separately from the scheduler settlement

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

