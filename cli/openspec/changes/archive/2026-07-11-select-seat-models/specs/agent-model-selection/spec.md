## ADDED Requirements

### Requirement: Per-agent model configuration over the shared connection

The `models` config block SHALL carry an `agents` map with the two user-facing agents —
`conversation` (the chat agent and its sub-agents) and `sandbox` (the catalog step agents, data
profiling, and the ephemeral runner) — each an optional model id served by the ONE configured
connection (`model-connection`); agent entries SHALL NOT name their own provider or endpoint.
Internal model consumers (run synthesis, post-step metadata/summary, target assessment) SHALL
follow the `sandbox` agent. Each agent's model resolves in order: `models.agents.<agent>` →
`harness.model` (legacy both-agents fallback) → the connection's mode default (cliproxy
auto-resolve under the provider-family guard; in direct mode an agent without a resolvable model
fails boot actionably). The composition SHALL construct one chat-provider instance per DISTINCT
resolved agent model over the shared connection, and every consumer of an agent's model identity
(agent definitions, provenance emitters) SHALL receive that agent's resolved value.

#### Scenario: Two agents, two models, one connection

- **WHEN** the connection is cliproxy/anthropic and `models.agents` is `{ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" }`
- **THEN** chat turns run on `claude-opus-4-8`, step/profile agents run on `claude-sonnet-4-5`,
  both against the same proxy endpoint and key, and provenance records
  `anthropic/claude-sonnet-4-5` on step and command activities

#### Scenario: Absent agents map preserves single-model behavior

- **WHEN** `models.agents` is absent and `harness.model` (or the cliproxy default) resolves one id
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
mode, the endpoint's `/models` (OpenAI-compatible) or `/v1/models` (Anthropic) in direct mode —
marking each agent's current model. When listing fails (endpoint down, unsupported), the picker
SHALL degrade to free-text model entry rather than blocking the switch. A selection SHALL persist
to `models.agents.<agent>` in `config.json` immediately, independent of when the runtime applies
it.

#### Scenario: Picker lists live models and marks the current one

- **WHEN** the user runs `Switch sandbox model` on a booted cliproxy runtime
- **THEN** the picker shows the proxy's current `/models` ids with the sandbox agent's active
  model marked, and choosing one writes `models.agents.sandbox`

#### Scenario: Listing failure degrades to free text

- **WHEN** the direct endpoint's model listing request fails
- **THEN** the picker offers free-text entry, the entered id persists exactly as typed, and no
  switch capability is lost

### Requirement: A switch applies live only when no agent work is in flight

The runtime SHALL track in-flight agent work — analysis runs, data profiling, chat turns, and
ephemeral workflows. A persisted agent-model selection SHALL apply to the live runtime
immediately when no agent work is in flight; otherwise it SHALL be recorded as pending and
applied at the moment the last in-flight work settles. Application SHALL reconstruct the affected
agent's provider instance and every composition object that closed over it (agent assembly, deps
bundles, provenance emitters — which are reconstructed WITH the new `{provider}/{model}` name,
preserving their construction-time-stamping contract). In-flight work SHALL complete on — and
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
