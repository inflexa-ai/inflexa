# agent-model-selection Specification

## Purpose
Per-agent model selection over the one shared model connection: the `models.agents` config map
for the two user-facing agents (conversation, sandbox), per-agent resolution and provider
construction, the Provider-category palette commands with dynamic model listing, and the
live/scheduled application semantics gated on agent-work idleness. Created by archiving change
select-seat-models.
## Requirements
### Requirement: Per-agent model configuration over the shared connection

The `models` config block SHALL carry an `agents` map with the two user-facing agents —
`conversation` (the chat agent and its sub-agents) and `sandbox` (the catalog step agents, data
profiling, and the ephemeral runner) — each an optional model id served by the ONE configured
connection (`model-connection`); agent entries SHALL NOT name their own provider or endpoint.
Internal model consumers (run synthesis, post-step metadata/summary, target assessment) SHALL
follow the `sandbox` agent. Each agent's model resolves in order: `models.agents.<agent>` →
`harness.model` (legacy both-agents fallback) → the connection's mode default (in cliproxy mode
the elected default per `default-model-election` — deterministic recency rank plus
accessibility-validated walk — under the provider-family guard; in direct mode an agent without
a resolvable model fails boot actionably). The composition SHALL construct one chat-provider
instance per DISTINCT resolved agent model over the shared connection, and every consumer of an
agent's model identity (agent definitions, provenance emitters) SHALL receive that agent's
resolved value.

#### Scenario: Two agents, two models, one connection

- **WHEN** the connection is cliproxy/anthropic and `models.agents` is `{ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" }`
- **THEN** chat turns run on `claude-opus-4-8`, step/profile agents run on `claude-sonnet-4-5`,
  both against the same proxy endpoint and key, and provenance records
  `anthropic/claude-sonnet-4-5` on step and command activities

#### Scenario: Absent agents map preserves single-model behavior

- **WHEN** `models.agents` is absent and `harness.model` (or the cliproxy elected default)
  resolves one id
- **THEN** both agents resolve to that id, one provider instance is constructed, and behavior is
  identical to the pre-change composition

#### Scenario: Internal consumers follow the sandbox agent

- **WHEN** the agents resolve to distinct models and a run reaches synthesis and post-step
  metadata generation
- **THEN** those activities run under the `sandbox` agent's model and provider

### Requirement: Palette commands switch an agent's model through a listing picker

The command palette SHALL offer `Switch chat model` and `Switch sandbox model` commands under a
dedicated `Provider` palette category, enabled only when the harness runtime is booted (the
existing boot-gated command pattern). Each SHALL
open a picker listing the connection's models dynamically — the proxy's `/models` in cliproxy
mode; in direct mode, `{baseURL}/models` for BOTH protocols, derived from the SAME configured
`baseURL` the chat path uses (the `/v1`-terminated protocol root — see `model-connection`), never
a re-derived variant of it —
marking each agent's current model. When listing fails (endpoint down, unsupported), the picker
SHALL degrade to free-text model entry rather than blocking the switch.

In direct mode the listing and validation requests SHALL authenticate the way the chat path does:
when the connection carries an `auth` block, the credential is resolved through the configured
credential source and sent under its configured scheme (`bearer` sends `Authorization: Bearer` and
no `x-api-key`; `x-api-key` the reverse) — never the static environment key, and never a scheme
the configuration does not name. Only when no `auth` block exists does the static env-key
resolution supply the credential with today's per-protocol headers. A credential-source resolution
failure is an EXPECTED listing/validation outcome and follows the existing degradation paths
(listing → free-text entry; validation → inconclusive-accept), never a crash.

A committed selection — listed or free-text — SHALL be accessibility-validated before persisting
when the connection protocol is `anthropic` (the unbilled `count_tokens` check, bounded, with
the dialog in its busy state while checking): a definite `not_found_error` SHALL keep the dialog
open with an inline error naming the model and that this account cannot serve it, persisting
nothing; a 200 or an inconclusive outcome (timeout, other status, network failure) SHALL commit.
On an `openai-compatible` connection no validation request exists and the selection commits as
before. A committed selection SHALL persist to `models.agents.<agent>` in `config.json`
immediately, independent of when the runtime applies it.

#### Scenario: Picker lists live models and marks the current one

- **WHEN** the user runs `Switch sandbox model` on a booted cliproxy runtime
- **THEN** the picker shows the proxy's current `/models` ids with the sandbox agent's active
  model marked, and choosing one writes `models.agents.sandbox`

#### Scenario: Listing failure degrades to free text

- **WHEN** the direct endpoint's model listing request fails
- **THEN** the picker offers free-text entry, the entered id persists exactly as typed after the
  same commit-time validation, and no switch capability is lost

#### Scenario: The anthropic listing derives from the chat baseURL

- **WHEN** the connection is direct-anthropic with the `/v1`-terminated `baseURL` chat requires
- **THEN** the listing request targets `{baseURL}/models` and succeeds — the picker auto-lists on
  the exact configuration under which chat works

#### Scenario: The picker authenticates with the configured credential source

- **WHEN** the connection is direct-anthropic with a `bearer` command `auth` block and the user
  opens the picker
- **THEN** the listing request carries `Authorization: Bearer <minted token>` and no `x-api-key`
  header, and a commit-time `count_tokens` validation for the selection authenticates identically

#### Scenario: An inaccessible pick is rejected in-dialog, not persisted

- **WHEN** the user commits a model whose `count_tokens` check answers `not_found_error`
- **THEN** the dialog stays open showing an error naming the model and the account-accessibility
  cause, and `models.agents` is not written

#### Scenario: A flaky validation does not block a switch

- **WHEN** the user commits a model and the `count_tokens` check times out
- **THEN** the selection persists (inconclusive-accept) exactly as an unvalidated commit would

### Requirement: A switch applies live only when no agent work is in flight

The runtime SHALL track in-flight agent work — analysis runs, data profiling, chat turns, and
ephemeral workflows. A persisted agent-model selection SHALL apply to the live runtime
immediately when no agent work is in flight; otherwise it SHALL be recorded as pending and
applied at the moment the last in-flight work settles. Application SHALL reconstruct the affected
agent's provider instance and — for the sandbox agent — its provenance emitters (reconstructed
WITH the new `{provider}/{model}` name, preserving their construction-time-stamping contract).

Every swappable object SHALL reach its consumers as a stable delegating handle injected once at
composition: the consumer (harness deps bundles, agent assembly, registered workflows) holds ONE
identity for the runtime's life, and a swap replaces only the cli-owned inner target behind it.
The application path SHALL NOT mutate any field of an object a consumer holds — correctness MUST
NOT depend on when or how often the consumer reads its deps fields. This is the contract the chat
provider's swappable handle already satisfies; the provenance emitters (`artifactRegistry`,
`emitProvenance`) SHALL satisfy the same one.

In-flight work SHALL complete on — and
record provenance under — the model that started it; no request observes a mid-flight model
change, and an in-progress streamed response is NEVER interrupted, truncated, or aborted by a
switch (whether requested from the palette or applied at settlement). An indeterminate busy state
SHALL defer, never apply.

#### Scenario: Idle switch applies immediately

- **WHEN** the user switches the chat model with no run, profile, or chat turn in flight
- **THEN** the next chat turn runs on the new model and its provenance/metadata carry the new
  `{provider}/{model}` name

#### Scenario: Busy switch is scheduled, then lands at settlement

- **WHEN** the user switches the sandbox model while an analysis run is executing
- **THEN** the running work continues and records the old model to completion; the selection is
  persisted and marked pending; when the run (and any other in-flight work) settles, the new
  provider is constructed and subsequent steps record the new name

#### Scenario: A chat turn defers the swap to the turn boundary, without disturbing the stream

- **WHEN** the user switches the chat model while a chat turn is streaming a response
- **THEN** the in-flight turn streams to completion on the old model — uninterrupted and
  untruncated — and the swap lands before the next turn begins

#### Scenario: A consumer that snapshots its deps still observes the swap

- **WHEN** a consumer captures the injected `emitProvenance` (or `artifactRegistry`) reference
  once at registration, the sandbox model is then switched at idle, and the consumer emits
  through its captured reference
- **THEN** the emitted event carries the NEW `{provider}/{model}` name — the swap is effective
  regardless of the consumer's read discipline, because the captured reference is the stable
  delegating handle

### Requirement: The TUI surfaces the connection and the active and pending agent models

The TUI SHALL render, from the runtime's boot/status state: the shared connection's identity —
the configured provider slug and mode (`cliproxy` or `direct`) — and the active model of each
user-facing agent, and SHALL surface a pending switch as such (selection made, applies when
agent work settles) until it lands. The boot/status state SHALL carry per-agent resolved models,
pending selections, and the connection identity.

#### Scenario: Status shows the connection and what each agent runs on

- **WHEN** the runtime is ready on a cliproxy/anthropic connection with distinct agent models
- **THEN** the user can see the provider (`anthropic`), the mode, and both active models in the
  TUI status surface without opening config

#### Scenario: Pending switch is visible, not silent

- **WHEN** a switch is scheduled behind a running analysis
- **THEN** the TUI shows the pending selection and clears the pending state once applied

