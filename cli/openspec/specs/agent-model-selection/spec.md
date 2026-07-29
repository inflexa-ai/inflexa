# agent-model-selection Specification

## Purpose
Per-agent model selection over the one shared model connection: the `models.agents` config map
for the two user-facing agents (conversation, sandbox), per-agent resolution and provider
construction, the Provider-category palette commands with dynamic model listing, and the
live/scheduled application semantics gated on agent-work idleness. Created by archiving change
select-seat-models.
## Requirements
### Requirement: Per-agent model configuration over the shared connection

The `models` config block SHALL carry an `agents` map with three model roles —
`conversation` (the chat agent and its conversation sub-agents), `sandbox` (the
catalog step agents, data profiling, and analysis-internal consumers), and
`utility` (the ad hoc specialist/resource router) — each an optional model id
served by the ONE configured connection (`model-connection`). Agent entries
SHALL NOT name their own provider or endpoint. Run synthesis, post-step
metadata/summary, and target assessment SHALL continue to follow `sandbox`.

Each role's model resolves in order:
`models.agents.<role>` → `harness.model` (legacy all-roles fallback) → the
connection's mode default (in cliproxy mode the elected default per
`default-model-election` under the provider-family guard; in direct mode a role
without a resolvable model fails boot actionably). The composition SHALL
construct one chat-provider inner instance per DISTINCT resolved model over the
shared connection and one independent stable swappable handle per role. Every
consumer of a role's model identity SHALL receive that role's resolved value.

#### Scenario: Three roles, three models, one connection

- **WHEN** the connection is cliproxy/anthropic and `models.agents` is `{ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-haiku-4-5" }`
- **THEN** chat turns run on `claude-opus-4-8`, step/profile/internal analysis agents run on `claude-sonnet-4-5`, and ad hoc routing runs on `claude-haiku-4-5`
- **AND** all three use the same proxy endpoint and key

#### Scenario: Absent agents map preserves single-model behavior

- **WHEN** `models.agents` is absent and `harness.model` (or the cliproxy elected default) resolves one id
- **THEN** all three roles resolve to that id, one inner provider instance is constructed behind three independent handles, and behavior preserves the existing single-model fallback

#### Scenario: Internal consumers follow the sandbox agent

- **WHEN** all roles resolve to distinct models and a run reaches synthesis and post-step metadata generation
- **THEN** those activities run under the `sandbox` role while ad hoc routing alone runs under `utility`

#### Scenario: Direct mode requires every unresolved role

- **WHEN** direct mode has no connection default, `harness.model` is absent, and only `models.agents.conversation` is configured
- **THEN** boot fails once with `model_required` naming both `sandbox` and `utility`

### Requirement: Palette commands switch an agent's model through a listing picker

The command palette SHALL offer `Switch chat model`, `Switch sandbox model`, and
`Switch utility model` commands under the dedicated `Provider` palette category,
enabled only when the harness runtime is booted. Each SHALL open a picker listing
the shared connection's models dynamically — the proxy's `/models` in cliproxy
mode; in direct mode, `{baseURL}/models` for BOTH protocols, derived from the
SAME configured `baseURL` the chat path uses, never a re-derived variant —
marking the selected role's current model.

When listing fails, the picker SHALL degrade to free-text model entry, pre-filled
with the role's current model, rather than blocking the switch. The picker SHALL
also offer a manual-entry row when listing succeeds. That row SHALL remain
offered whatever the user typed into the filter. Backing out of the manual field
SHALL return to the listing.

In direct mode, listing and validation SHALL authenticate exactly as chat does:
configured `auth` resolves its credential source and applies only its named
scheme; only absent `auth` uses static env-key resolution. Credential-source
failure SHALL degrade through the existing listing/validation paths rather than
crash.

For Anthropic protocol, a committed listed or free-text selection SHALL be
accessibility-validated with the bounded unbilled `count_tokens` check. A
definite `not_found_error` SHALL keep the dialog open and persist nothing; a 200
or inconclusive timeout/network/other-status outcome SHALL commit. OpenAI-
compatible connections SHALL commit without that validation request. Commit
SHALL write `models.agents.<role>` immediately, independent of when the runtime
can apply it.

#### Scenario: Picker lists live models and marks the current one

- **WHEN** the user runs `Switch utility model` on a booted cliproxy runtime
- **THEN** the picker shows the proxy's current model ids with utility's active model marked, and choosing one writes `models.agents.utility`

#### Scenario: An unlisted id is reachable from a successful listing

- **WHEN** the picker lists models and the user filters by an id the connection does not enumerate
- **THEN** the manual-entry row remains offered, selecting it opens an empty free-text field, and escape returns to the listing

#### Scenario: Listing failure degrades to free text

- **WHEN** the direct endpoint's model listing request fails
- **THEN** the picker offers free-text entry, the entered id persists exactly as typed after the same commit-time validation, and no switch capability is lost

#### Scenario: The anthropic listing derives from the chat baseURL

- **WHEN** the connection is direct-anthropic with the `/v1`-terminated `baseURL` chat requires
- **THEN** the listing request targets `{baseURL}/models` and succeeds under the exact configuration where chat works

#### Scenario: The picker authenticates with the configured credential source

- **WHEN** the connection is direct-anthropic with a `bearer` command `auth` block and the user opens a role's picker
- **THEN** listing carries `Authorization: Bearer <minted token>` and no `x-api-key`, and commit-time validation authenticates identically

#### Scenario: An inaccessible pick is rejected in-dialog, not persisted

- **WHEN** the user commits a model whose `count_tokens` check answers `not_found_error`
- **THEN** the dialog stays open with an account-accessibility error and `models.agents` is not written

#### Scenario: A flaky validation does not block a switch

- **WHEN** the user commits a model and `count_tokens` times out
- **THEN** the selection persists through the existing inconclusive-accept rule

### Requirement: A switch applies live only when no agent work is in flight

The runtime SHALL track in-flight agent work — analysis runs, data profiling,
and chat turns (including the bounded utility routing performed inside an ad hoc
launch). A persisted role-model selection SHALL apply to the live runtime
immediately when no agent work is in flight; otherwise it SHALL be pending and
apply when the last in-flight work settles. Application SHALL reconstruct that
role's provider inner and, only for `sandbox`, its provenance emitters with the
new `{provider}/{model}` name.

Every swappable provider and emitter SHALL reach consumers as a stable delegating
handle injected once at composition. Applying a switch SHALL replace only the
CLI-owned target behind the selected handle, never mutate an object a consumer
holds. In-flight work SHALL complete and record provenance under the model that
started it; no request SHALL observe a mid-flight role change, and a streamed
chat response SHALL never be interrupted by a switch. An indeterminate busy
state SHALL defer.

#### Scenario: Idle switch applies immediately

- **WHEN** the user switches utility with no run, profile, or chat turn in flight
- **THEN** the next ad hoc route uses the new utility model and conversation/sandbox handles are unchanged

#### Scenario: Busy switch is scheduled, then lands at settlement

- **WHEN** the user switches sandbox while an analysis run is executing
- **THEN** running work completes on the old model, the selection is persisted/pending, and the new provider applies after all work settles

#### Scenario: Utility cannot switch during its routing call

- **WHEN** the user selects a new utility model while an ad hoc-launch chat turn is still routing
- **THEN** the switch remains pending until that turn settles and the in-flight route stays on its starting model

#### Scenario: A chat turn defers the swap to the turn boundary

- **WHEN** the user switches chat while a chat response is streaming
- **THEN** the stream completes uninterrupted on the old model and the swap lands before the next turn

#### Scenario: A consumer that snapshots its deps still observes the swap

- **WHEN** a harness consumer captured the utility provider handle at registration and utility is switched while idle
- **THEN** its next call reaches the new inner provider through that same captured handle

### Requirement: The TUI surfaces the connection and the active and pending agent models

The TUI SHALL render from runtime boot/status state the shared connection
identity and the active model for conversation, sandbox, and utility. It SHALL
surface any pending role selection until it applies. Boot/status state SHALL
carry three-role resolved models, pending selections, and connection identity.

#### Scenario: Status shows the connection and all role models

- **WHEN** the runtime is ready with three distinct resolved model ids
- **THEN** the TUI shows provider, mode, and the active conversation, sandbox, and utility models without requiring the user to inspect config

#### Scenario: Pending switch is visible, not silent

- **WHEN** a utility switch is scheduled behind in-flight work
- **THEN** the TUI shows utility's pending selection and clears it once applied

