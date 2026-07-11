# agent-model-selection — delta

## MODIFIED Requirements

### Requirement: Palette commands switch an agent's model through a listing picker

The command palette SHALL offer `Switch chat model` and `Switch sandbox model` commands under a
dedicated `Provider` palette category, enabled only when the harness runtime is booted (the
existing boot-gated command pattern). Each SHALL
open a picker listing the connection's models dynamically — the proxy's `/models` in cliproxy
mode; in direct mode, `{baseURL}/models` for BOTH protocols, derived from the SAME configured
`baseURL` the chat path uses (the `/v1`-terminated protocol root — see `model-connection`), never
a re-derived variant of it —
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

#### Scenario: The anthropic listing derives from the chat baseURL

- **WHEN** the connection is direct-anthropic with the `/v1`-terminated `baseURL` chat requires
- **THEN** the listing request targets `{baseURL}/models` and succeeds — the picker auto-lists on
  the exact configuration under which chat works

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
