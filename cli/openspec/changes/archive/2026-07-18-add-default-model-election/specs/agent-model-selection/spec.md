# agent-model-selection Specification (delta)

## MODIFIED Requirements

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

#### Scenario: An inaccessible pick is rejected in-dialog, not persisted

- **WHEN** the user commits a model whose `count_tokens` check answers `not_found_error`
- **THEN** the dialog stays open showing an error naming the model and the account-accessibility
  cause, and `models.agents` is not written

#### Scenario: A flaky validation does not block a switch

- **WHEN** the user commits a model and the `count_tokens` check times out
- **THEN** the selection persists (inconclusive-accept) exactly as an unvalidated commit would
