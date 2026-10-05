# harness-runtime Specification

## Purpose
The embedding seam between the cli and `@inflexa-ai/harness`: a lazy, process-singleton composition root, booted by the local server (and by the dev `run --plan`), that provisions/boots the runtime (Postgres readiness, cortex schema, pre-launch ephemeral sweep, workflow registration and conversation-agent build through the harness composition root `assembleCoreRuntime`, DBOS launch), realizes every local seam (data-profile, run-engine, and conversation deps) locally, and tears down gracefully on exit. It owns the single global session-tree base. The runtime binds no listener for the sandboxes, because the harness polls each sandbox and the sandbox initiates nothing. Lives in `src/modules/harness/`.

## Requirements

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

### Requirement: Sandbox engine connection follows the pinned container runtime

The harness boot SHALL resolve the pinned container runtime's sandbox-engine
socket (via the container-runtime resolution) before constructing the sandbox
client, and SHALL pass it to `createSandboxClient` as `engineSocketPath`. When
the pinned runtime is podman, boot SHALL additionally declare
`engineBindOwnership: "host-preserved"` — podman machine's virtiofs preserves
host ownership honestly, which the harness compensates for on the pre-created
step tree; a docker pin SHALL NOT pass it, keeping today's modes under Docker
Desktop's permissive sharing layer. A docker pin SHALL pass no
socket path, preserving dockerode's default resolution byte-for-byte. Image
pre-pull (`ensureSandboxImage`) and container create then target the same
engine by construction. A failed socket resolution SHALL fail boot with a
dedicated, user-actionable error variant before any side effect — never a
dockerode connection error surfacing mid-run.

#### Scenario: Podman pin wires the compat socket and bind-ownership fact

- **WHEN** the runtime boots with `podman` pinned and a resolvable compat socket
- **THEN** `createSandboxClient` receives that socket as `engineSocketPath` and `engineBindOwnership: "host-preserved"`
- **AND** sandbox containers are created on the same engine that pre-pulled the image

#### Scenario: Docker pin is byte-identical to today

- **WHEN** the runtime boots with `docker` pinned
- **THEN** `createSandboxClient` receives no `engineSocketPath` and no `engineBindOwnership`

#### Scenario: Unresolvable podman socket blocks boot with actionable guidance

- **WHEN** the runtime boots with `podman` pinned and the socket cannot be resolved
- **THEN** boot fails with the resolution's runtime-specific message (start the machine / enable the socket service) and DBOS is not launched

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

### Requirement: Local realizations for every conversation dependency

The composition SHALL realize the conversation agent's dependency surface from
deliberate local wiring, reusing shared pool, embedding, workspace filesystem,
session-tree, bio-key, authorizer, and launcher realizations. It SHALL supply:

- the conversation provider/model resolved under the `conversation` role for the
  chat agent and its conversation sub-agents;
- the utility provider/model resolved under the `utility` role for the
  harness-owned ad hoc router;
- a config-overridable skills path with the existing release/development
  defaults and pre-flight gate;
- empty local Chrome config;
- the `run_inflexa` host tool through the host-tool seam.

The utility role SHALL use the same configured connection and credential
realization as the other roles. The CLI SHALL NOT supply routing prompts,
candidate agent ids, or selection decisions.

#### Scenario: Conversation and utility deps resolve to their roles

- **WHEN** the runtime composes a conversation model distinct from utility
- **THEN** chat/sub-agent traffic uses conversation and ad hoc routing uses utility over the same configured connection

#### Scenario: Report preview degrades visibly, report building does not

- **WHEN** the agent attempts local report preview
- **THEN** preview reports unavailability and report iteration/submission still works

#### Scenario: The conversation agent carries the inflexa CLI host tool

- **WHEN** runtime composes the conversation agent
- **THEN** `run_inflexa` is present through `hostTools`

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

### Requirement: The composition root realizes the tool-approval gateway

The embedded-runtime boot SHALL construct the harness ask gateway from the app
pool at the composition root, expose it on the runtime handle so surfaces can
answer and enumerate asks, and run the gateway's expiry sweep in the boot
chores that execute after the harness has initialized its state tables — so
pending asks orphaned by a prior process are expired before any new turn runs.

#### Scenario: The runtime handle carries the gateway

- **GIVEN** a booted harness runtime in the local server
- **WHEN** the ask routes of the local server list or answer an ask
- **THEN** the gateway is reachable from the runtime handle without constructing a second realization

#### Scenario: Orphaned asks are swept at boot

- **GIVEN** a prior process that died with a pending ask in the ledger
- **WHEN** the runtime boots
- **THEN** the sweep marks it expired before the first turn can run

### Requirement: Ephemeral configuration and workflow wiring are absent

The resolved CLI `ResourcePolicy` SHALL contain only per-step ceilings and the
machine budget. The CLI SHALL NOT project `harness.resourceLimits.ephemeral`,
build ephemeral workflow dependencies, or supply an ephemeral callable to the
harness composition. A stale on-disk ephemeral setting MAY be tolerated during
the upgrade window but SHALL have no runtime effect.

#### Scenario: Runtime composes ordinary resource policy

- **WHEN** the CLI resolves its harness configuration
- **THEN** the supplied policy has `perStep` and `budget` and no `ephemeral` field

#### Scenario: Workflow cohort has no ephemeral dependency

- **WHEN** the CLI constructs `CoreWorkflowDeps`
- **THEN** it supplies no ephemeral dependency bundle and registers no ephemeral workflow

### Requirement: Legacy ephemeral sweep remains a pre-launch migration

During the supported upgrade window, the CLI SHALL call the harness's
executor-scoped legacy ephemeral sweep after workflow registration and before
DBOS launch. The call exists only to cancel pending rows left by an older binary
and SHALL NOT imply an ephemeral tool, agent, resource policy, dependency
bundle, or workflow registration.

#### Scenario: Old pending row exists during upgrade

- **GIVEN** the local executor owns a pending legacy `ephemeral:*` DBOS row
- **WHEN** the new CLI reaches its pre-launch hook
- **THEN** it cancels the row before recovery and then launches without an ephemeral workflow registration

### Requirement: The CLI realizes the report page-asset lookup

The composition root MUST bind the asset lookup that `assembleCoreRuntime` accepts, in a release build alone. The lookup MUST map a manifest specifier onto the materialized file under the assets directory. The manifest that the harness exports MUST be the one source of that mapping, thus the composition restates no file name.

The lookup MUST throw for a specifier that the manifest does not carry. The preview tool wraps each call in a guard, and it turns a throw into its own typed outcome. Thus the throw is the protocol of the seam, and it is not a break of the rule that a failure rides the `Result` channel. The realization MUST carry the reason on the site.

A development build MUST bind nothing. A checkout holds the installation of the harness, thus the default lookup of the preview tool resolves each specifier there.

#### Scenario: A release build binds the materialized files

- **WHEN** a compiled binary composes the harness runtime after the content materializes
- **THEN** the composition binds a lookup that gives the path of each manifest entry under the assets directory

#### Scenario: The preview tool finds each asset in a compiled binary

- **WHEN** a report session renders a page in a compiled binary
- **THEN** the chart runtime and each font land beside the page, and the tool reports the page path

#### Scenario: An unknown specifier reaches the caller as a typed outcome

- **WHEN** the lookup receives a specifier that the manifest does not carry
- **THEN** it throws, and the preview tool gives back its write-failure outcome that names the cause

#### Scenario: A development build leaves the lookup unbound

- **WHEN** a development build composes the harness runtime
- **THEN** it passes no lookup, and the harness resolves each specifier against its own installation

### Requirement: The CLI realizes the eyes of a report session

The composition root MUST bind the eyes seam that `assembleCoreRuntime` accepts. The harness refuses every report-session spawn under a composition with no eyes, thus this binding is what makes the report path exist on this host.

The realization MUST start one container for one look. A standing sidecar cannot serve this host, because an anchor puts each workspace root in a different user folder and no fixed mount set covers them.

The mount MUST repeat the workspace root of the scope on both sides. The browser navigates a `file://` URL of the host tree, and the container holds its own filesystem. Thus a container path that differed would resolve nothing. The mount argument MUST come from the runtime descriptor, because the two runtimes diverge on it.

The container MUST publish its devtools port on the loopback interface alone. The browser reads the workspace of the user, and a port on every interface would serve that tree to the network.

The container MUST carry a shared-memory allowance that holds a full-page capture bitmap. The runtime default of 64 MiB refuses the capture of a tall page. The look then fails with a protocol error, although the page itself is sound.

The container MUST carry its own deadline, and that deadline MUST NOT depend on this process. A process can die between the acquire and the release, thus no release of a caller is the guarantee.

The realization MUST bound how many browsers run at one time. The page gate of the harness bounds one endpoint, and each look here names a new endpoint.

The browser image MUST be pinned by digest. A moved tag would change what a look runs against, and the infrastructure images of this host are pinned the same way.

An acquire that fails MUST remove what it started, and it MUST give its slot back. No lease exists to do either.

The realization MUST run on the container runtime that the boot pinned already. Thus one boot names one container engine.

#### Scenario: A spawn passes the eyes gate

- **WHEN** the composition root assembles the harness runtime
- **THEN** it binds an eyes seam, and a report-session spawn does not refuse with `no_browser`

#### Scenario: One look mounts the root of its own analysis

- **WHEN** the seam acquires a lease for a scope
- **THEN** the container mounts the workspace root of that scope at the identical path

#### Scenario: A lost release still ends the browser

- **WHEN** a lease is acquired and no release ever runs
- **THEN** the container ends at its own deadline

#### Scenario: The count bound holds a look until a release

- **WHEN** the bound number of browsers already run and a further look acquires
- **THEN** the acquire waits, and it proceeds after one release

#### Scenario: A failed acquire leaves nothing behind

- **WHEN** the container starts and the endpoint never answers
- **THEN** the acquire removes the container, it gives its slot back, and it throws

#### Scenario: The shared-memory allowance rides the run args

- **WHEN** the seam starts the container of one look
- **THEN** the run args carry the shared-memory size, and the size holds a full-page capture of a tall report page

### Requirement: The composition root binds the package-store seams

The composition root MUST bind the three package-store values of the
harness config. `libStorePath` names the store root. `farmSource` is
`{ kind: "per-analysis" }`, with a resolver that names `farms/<analysisId>`
and heals a missing farm as an empty one. `toolchainSource` is `"image"`,
because the published image owns conda and Node. The root MUST bind
`extendAnalysisFarm` to the composition linker, thus the `link_packages`
tool exists for every sandbox agent. The CLI wrapper of a link refusal MUST
append the remedy text that names `inflexa store add`, because the harness
error carries only the missing names.

The root MUST bind the farm inventory path, `farmLockFile`, as a function of
the analysis id: the `inflexa.lock` of `farms/<analysisId>`. The harness
resolves the path with the analysis id of the session of each read. One
runtime serves each analysis of the machine, thus a static path would give
each analysis the package inventory of one farm.

#### Scenario: The farm resolves per analysis

- **GIVEN** two analyses with two farms
- **WHEN** each starts a sandbox
- **THEN** each sandbox mounts its own farm at `/mnt/libs/farm`

#### Scenario: The package inventory follows the analysis of the session

- **GIVEN** one runtime and two analyses whose farms hold different packages
- **WHEN** a sandbox agent of each analysis lists the available packages
- **THEN** each answer reads the `inflexa.lock` of the farm of its own analysis

#### Scenario: The refusal carries the CLI remedy

- **GIVEN** a link request for a package that the pool does not hold
- **WHEN** the refusal reaches the user surface
- **THEN** the text names `inflexa store add <name>` as the retry

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
