## ADDED Requirements

### Requirement: On-demand composition of the embedded harness runtime

The system SHALL provide a composition module that boots the embedded harness runtime
on first use and reuses it for the remainder of the process (module singleton). Boot
SHALL sequence: ensure Postgres readiness (via the infra module), start the
exec-callback listener, register the data-profile workflow with its fully-realized
deps, then launch DBOS. Passive flows (bare `inflexa` launch, TUI startup) SHALL NOT
boot the runtime. A second boot request SHALL return the existing runtime without
re-registering or re-launching.

#### Scenario: First trigger boots the runtime

- **WHEN** a data-profile launch is requested and the runtime has not been booted
- **THEN** Postgres readiness is ensured, the callback listener starts, the workflow is registered, and DBOS launches — in that order

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second launch is requested in the same process
- **THEN** no re-registration or re-launch occurs and the existing runtime serves the trigger

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** the runtime boot cannot reach a ready Postgres
- **THEN** boot fails with the infra module's actionable error (e.g. pointing at setup) and DBOS is not launched

### Requirement: Local realizations for every data-profile dependency

The composition SHALL realize `DataProfileDeps` from deliberate local wiring: the
`pg.Pool` built from the infra module's resolved `PostgresConnection`; the harness's
local run authorizer and no-op billing resolver; the chat provider pointed at the local
proxy's Anthropic-shaped Messages endpoint; the embedding configuration taken from a
cli config key naming a user-supplied OpenAI-compatible embeddings endpoint (the local
proxy serves none); a workspace filesystem and sandbox client (Docker backend) sharing
the runtime's single session-tree base; bio-tool keys from cli config with absent keys
passed as empty; and the shared skills directory. No dependency SHALL be realized as a
fake that fabricates success — a locally unrealizable capability must fail visibly at
the point of use.

#### Scenario: Deps resolve to their designated backends

- **WHEN** the runtime composes the data-profile deps bundle
- **THEN** chat traffic targets the local proxy, embedding traffic targets the configured embeddings endpoint, and everything else requires only the local Postgres and the Docker daemon

#### Scenario: Unconfigured bio keys degrade per-tool, not at boot

- **WHEN** no bio/chem API keys are configured
- **THEN** the runtime boots and profiles run; only the affected tools surface auth errors when invoked

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
barrel SHALL be extended (additive exports only) with the embedder runtime surface this
change consumes: DBOS lifecycle (`launchDbos`, `shutdownDbos`, `DbosConfig`),
data-profile registration and trigger (with their dep/param/result types),
`StagedInput`, the sandbox client factory and its config types, the workspace
filesystem factory, and the exec-callback envelope helpers (`workflowIdFromExec`,
envelope/done-marker types).

#### Scenario: No deep imports in cli code

- **WHEN** the cli's harness-facing modules are inspected
- **THEN** every harness import resolves from the package barrel, none from deep subpaths
