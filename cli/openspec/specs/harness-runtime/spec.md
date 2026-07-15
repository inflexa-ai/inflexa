# harness-runtime Specification

## Purpose
The embedding seam between the cli and `@inflexa-ai/harness`: a lazy, process-singleton composition root that provisions/boots the runtime (Postgres readiness, cortex schema, pre-launch ephemeral sweep, workflow registration and conversation-agent build through the harness composition root `assembleCoreRuntime`, DBOS launch), realizes every local seam (data-profile, run-engine, and conversation deps) locally, and tears down gracefully on exit. Owns the single global session-tree base and the sandbox transport choice: the CLI defaults to **poll** (the sandbox is polled for results; no callback listener exists), with the loopback HTTP ingress that bridges sandbox-server callbacks onto DBOS topics reserved for the opt-in callback mode. Lives in `src/modules/harness/`.
## Requirements
### Requirement: On-demand composition of the embedded harness runtime

The system SHALL provide a composition module that boots the embedded harness runtime
on first use and reuses it for the remainder of the process (module singleton). Boot
SHALL sequence: ensure Postgres readiness (via the infra module); **in callback
transport mode only**, start the exec-callback listener; initialize the cortex
schema; sweep this executor's pending ephemeral workflows (a direct pre-launch cancel
— launching first would let recovery re-dispatch sandboxes for chat turns that no
longer exist); then register the durable workflows and build the conversation agent
through the harness composition root (`assembleCoreRuntime`) — which owns the
child-before-parent workflow ordering and registers the sandbox-step,
execute-analysis, target-assessment, data-profile, and ephemeral workflows in one
pass — plus the sandbox-hygiene scheduled workflows, then launch DBOS, so every
registration lands in one pre-launch cohort. The CLI runs in **poll** transport mode
by default, in which the sandbox is polled for results and no callback listener is
bound. The target-assessment workflow is registered deliberately untriggerable: no
cli surface launches it, which is harmless (never launched → never recovered) and
recorded so it is not mistaken for dead wiring. The booted runtime handle SHALL
expose the assembled conversation agent. Passive flows (bare `inflexa` launch, TUI
startup) SHALL NOT boot the runtime. A second boot request SHALL return the existing
runtime without
re-registering or re-launching.

#### Scenario: First trigger boots the runtime (poll mode, the default)

- **WHEN** a data-profile, analysis-run, or chat launch is requested and the runtime has not been booted
- **THEN** Postgres readiness is ensured, the ephemeral sweep runs, all workflows register through the composition root (sandbox-step before execute-analysis), and DBOS launches — in that order — and NO callback listener is bound

#### Scenario: Callback mode additionally binds the listener

- **WHEN** the runtime boots in callback transport mode
- **THEN** the exec-callback listener starts after Postgres readiness and before the schema init

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second launch is requested in the same process
- **THEN** no re-registration or re-launch occurs and the existing runtime serves the trigger

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** the runtime boot cannot reach a ready Postgres
- **THEN** boot fails with the infra module's actionable error (e.g. pointing at setup) and DBOS is not launched

#### Scenario: One registration cohort

- **WHEN** the runtime boots and DBOS recovery resumes an in-flight workflow of any registered kind (profile, run parent, run child, ephemeral)
- **THEN** the workflow is found by its registered name — no workflow the cli can trigger is registered after launch

#### Scenario: Stale ephemeral work is swept, not re-dispatched

- **WHEN** a prior process died leaving a pending ephemeral workflow row and a new boot occurs
- **THEN** the sweep cancels the row before DBOS launch and recovery does not start a sandbox for it

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
- **THEN** boot fails naming the remedy, before Postgres provisioning, listener start, registration, or launch

### Requirement: Exec-callback ingress bridges sandbox HTTP callbacks to DBOS topics

In **callback** transport mode the runtime SHALL host a loopback-only HTTP listener
accepting `POST /sandbox/{execId}/{kind}` for `kind` ∈ {`event`, `complete`}. Each
accepted request SHALL be enveloped as `{payload, payloadRaw, signature, timestamp}`
from the body and the `X-Sandbox-Signature`/`X-Sandbox-Timestamp` headers (absent
headers as null), with `complete` payloads wrapped in the done-marker shape, and
delivered to the workflow derived from the execId via the harness's exec-event
delivery helper (never a cli-side `DBOS.send` — the SDK is module-singleton state and
a second copy is un-launched). The listener SHALL NOT verify HMAC signatures
(verification is the workflow body's job) and SHALL NOT hold callback secrets. An
execId from which no workflow id can be derived SHALL yield a 4xx (the sandbox-server
gives up); a failed send SHALL yield a 5xx (the sandbox-server retries). The sandbox
client's `cortexBaseUrl` SHALL be a URL under which sandbox containers reach this
listener. In **poll** transport mode (the CLI default) the runtime SHALL bind NO such
listener and SHALL advertise an empty `cortexBaseUrl` — the sandbox initiates nothing
and is polled for results instead.

#### Scenario: Poll mode binds no listener

- **WHEN** the runtime boots in poll transport mode
- **THEN** no `/sandbox/{execId}/{kind}` listener is bound and the sandbox client's `cortexBaseUrl` is empty

#### Scenario: Event callback reaches the awaiting workflow (callback mode)

- **WHEN** the sandbox-server POSTs an exec event to `/sandbox/{execId}/event`
- **THEN** the enveloped message is sent to topic `exec-event:{execId}` of the workflow derived from the execId and the listener replies 2xx

#### Scenario: Completion callback is wrapped as a done-marker (callback mode)

- **WHEN** the sandbox-server POSTs to `/sandbox/{execId}/complete`
- **THEN** the delivered envelope's payload is the done-marker form carrying the exec result

#### Scenario: Malformed execId is a permanent rejection (callback mode)

- **WHEN** a POST arrives whose execId yields no derivable workflow id
- **THEN** the listener replies 4xx and delivers nothing

### Requirement: Graceful runtime shutdown

On cli process exit after the runtime has booted, the system SHALL shut DBOS down
(marking in-flight workflows recoverable) and close the callback listener (a no-op in
poll mode, which binds none). Shutdown failures SHALL NOT prevent the remainder of
the exit sequence.

#### Scenario: Exit with an in-flight profile

- **WHEN** the cli exits while a profile workflow is running
- **THEN** DBOS shutdown marks it recoverable and a later runtime boot resumes it

### Requirement: Existing local reference store is mounted read-only into sandboxes

The CLI harness composition SHALL supply `refStorePath` to the harness sandbox client exactly when `env.refsDir` already exists. It SHALL NOT create the directory during runtime boot or passive launch. An existing directory, including an empty one, SHALL be mounted read-only by the harness at `/mnt/refs`; an absent directory SHALL leave the mount unconfigured so Docker cannot auto-create a root-owned bind source.

#### Scenario: Deliberately created store is wired

- **GIVEN** setup, reference download, or the user has created `env.refsDir`
- **WHEN** the embedded harness runtime creates a Docker sandbox
- **THEN** the sandbox client receives that host path as `refStorePath` and the sandbox sees it read-only at `/mnt/refs`

#### Scenario: Missing store is not auto-created

- **GIVEN** `env.refsDir` does not exist
- **WHEN** the runtime boots and creates a sandbox
- **THEN** `refStorePath` is omitted and neither the CLI nor Docker creates the host directory as a side effect of composition

#### Scenario: Empty store remains distinguishable from no mount

- **GIVEN** `env.refsDir` deliberately exists but contains no reference data
- **WHEN** a sandbox is created
- **THEN** it receives the empty read-only mount so harness discovery can report mounted-but-empty rather than unmounted

### Requirement: The embedding imports through the harness barrel

Cli code SHALL import harness symbols only from the `@inflexa-ai/harness` barrel. The
barrel SHALL be extended (additive exports only) with the embedder runtime surface the
cli consumes: DBOS lifecycle (`launchDbos`, `shutdownDbos`, `DbosConfig`),
data-profile registration and trigger (with their dep/param/result types),
`StagedInput`, the sandbox client factory and its config types, the workspace
filesystem factory, the exec-callback envelope helpers (`workflowIdFromExec`,
envelope/done-marker types), the run-engine surface: sandbox-step and
execute-analysis registration (with dep/input/result and agent-build context types),
the sandbox agent catalog factory, plan schema and validation (`AnalysisPlanSchema`,
`validatePlan`), plan persistence (`upsertPlan`, `loadPlan`), run
state (insert/query/update run rows, step-execution queries, the dedup-collision
error), the run launcher, and the scheduled-workflow registration functions; the
provider error surface (`ProviderError`, `toProviderError`); and the conversation
surface: the composition root and its dep types (`assembleCoreRuntime`, the
`CoreRuntimeDeps` family), the chat-turn preparation and persistence functions with
their types (`prepareChatTurn`, the thread store/history factories, `StoredMessage`),
the history display readers (`contentToCortexMessages`, `createCardResolver`), the
streaming-chat provider wrapper (`createStreamingChat`) and `AgentChat`, the
pass-through run step (`passthroughStep`), the ephemeral pre-launch sweep
(`sweepEphemeralWorkflows`), the unavailable preview publisher, and the `contracts/`
chat-event and chat-part types.

#### Scenario: No deep imports in cli code

- **WHEN** the cli's harness-facing modules are inspected
- **THEN** every harness import resolves from the package barrel, none from deep subpaths

### Requirement: Local realizations for every analysis-run dependency

The composition SHALL realize the sandbox-step and execute-analysis dep bundles from
deliberate local wiring, reusing the data-profile realizations where the seams are
shared (pool, sandbox client, workspace filesystem, session-tree base, bio keys,
local run authorizer) — the chat provider and model id are the SANDBOX agent's (see
`agent-model-selection`): the provider instance bound to the sandbox agent's resolved
model over the shared connection, also serving run synthesis and post-step
metadata/summary. Specific to the run engine:

- The embedding dependency SHALL be a real `EmbeddingProvider` instance constructed
  from the same cli embedding config the profile path uses.
- The run-level billing bracket SHALL be the harness's no-op `RunCharge`.
- The agent builder SHALL resolve each step's agent id against the harness sandbox
  agent catalog, threading the per-step build context (sandbox ref, write prefix,
  lineage collector, blocker holder, function-id/deadline accessors) into the
  catalog's agent deps; an agent id absent from the catalog SHALL fail the step with
  the known-id list.
- The step write prefix SHALL resolve to the harness's `runs/{runId}/{stepId}` path
  convention under the analysis's workspace tree.
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
- **THEN** chat traffic targets the resolved model connection under the sandbox agent's model (the local proxy in `cliproxy` mode, the configured endpoint in `direct` mode), embedding traffic targets the configured embeddings endpoint, and everything else requires only the local Postgres and the Docker daemon

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

### Requirement: Local realizations for every conversation dependency

The composition SHALL realize the conversation agent's dependency surface from
deliberate local wiring, reusing the existing realizations where the seams are shared
(pool, embedding provider, workspace filesystem, session-tree base, bio keys, run
authorizer, run launcher) — the chat provider and model id are the CONVERSATION
agent's (see `agent-model-selection`): the provider instance bound to the conversation agent's resolved model over the shared connection, serving the chat agent and its
sub-agents. Specific to the conversation
surface:

- `skillsDir` and `templatesDir` SHALL each be a config-overridable path that, absent an
  override, resolves to the extracted content directory
  (`join(env.contentDir, <contentHash>, "skills")` / `.../templates`, materialized by
  `content-assets`) in a **release build**, and to the repository-root `skills/` /
  `templates/` trees in a **development run**; both remain gated at pre-flight, which now
  passes because `content-assets` materializes the tree before the gate.
- `chrome` SHALL be the empty config (no browser URL): with report preview
  unavailable, nothing in the local path reaches Chrome.
- `createPreviewPublisher` SHALL yield the harness's unavailable preview publisher,
  which fails visibly at the point of use (report preview reports its unavailability;
  report submission remains the only gate) — consistent with the rule that no
  dependency is realized as a fake that fabricates success.

#### Scenario: Conversation deps resolve to their designated backends

- **WHEN** the runtime composes the conversation agent
- **THEN** chat traffic targets the resolved model connection under the conversation agent's model (the local proxy in `cliproxy` mode, the configured endpoint in `direct` mode), threads and working memory live in the local Postgres, and templates resolve from the configured directory or, absent an override, the extracted content directory in a release build (the repo-root `templates/` tree in a development run)

#### Scenario: Report preview degrades visibly, report building does not

- **WHEN** the agent attempts a report preview snapshot in a local chat
- **THEN** the preview tool reports preview unavailability (no Chrome is contacted) and report iteration/submission still works

### Requirement: The CLI realizes the workspace-root resolver

The system SHALL wire the harness's `resolveWorkspaceRoot` seam with a realization that maps an analysis id to `join(anchorPath, ".inflexa", "analyses", slug)` by reading the analysis row (slug, anchorId) and resolving the anchor's live path from the database — durable state, so a DBOS-recovered workflow on a fresh process resolves correctly. Every dep bundle that previously carried `sessionsBasePath` (sandbox client, workspace filesystem, composition, data-profile, and conversation deps in `src/modules/harness/runtime.ts`) SHALL receive this realization; no global base path remains in the wiring. Resolution failure for a live workflow SHALL surface per the harness seam contract (a throw across DBOS step boundaries → the step fails durably).

The realization is injective among live rows by the `UNIQUE (anchor_id, slug)` constraint. That constraint alone does NOT make it injective across a deletion, because deleting a row frees its slug: injectivity across deletion is upheld by the delete flow retiring the workspace tree out of `analyses/` before the slug can be re-issued (see analysis-service).

The realization SHALL be memoized through `workspaceRootForAnalysisId` (see path-resolution), whose memo is process-local and starts empty. This preserves the seam's recovery contract while keeping an agent's file reads off the database.

#### Scenario: One tree across all consumers

- **WHEN** an analysis is staged, profiled, and run
- **THEN** the staged files, the sandbox bind-mount source, the post-step artifact writes, and workspace filesystem reads all resolve under `<anchorPath>/.inflexa/analyses/<slug>/…`

#### Scenario: Recovery resolves from the database

- **GIVEN** a run interrupted by a crash, and the anchor folder moved (marker intact, path reconciled) before restart
- **WHEN** DBOS recovery resumes the workflow in a fresh CLI process
- **THEN** the resolver derives the workspace root from the current anchor path and the run continues against the moved tree

#### Scenario: Deleted analysis fails resolution loudly

- **WHEN** the resolver is invoked for an analysis id whose row no longer exists
- **THEN** it fails with an error that crosses the DBOS boundary as a throw, and the requesting step is recorded as failed

#### Scenario: A recreated analysis does not inherit a predecessor's root contents

- **GIVEN** an analysis was deleted and a new one created with the same name under the same anchor
- **WHEN** the resolver resolves the new analysis's root
- **THEN** the root is the same path, and it holds none of the deleted analysis's artifacts

