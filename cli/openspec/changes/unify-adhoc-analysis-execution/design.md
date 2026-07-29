## Context

The CLI currently resolves two model roles over one configured connection:
`conversation` and `sandbox`. Each role has an optional
`models.agents.<role>` override, a required resolved value at boot, its own
stable swappable provider handle, palette switching, and visible active/pending
state. Coincident model ids share an inner provider instance.

The coordinated harness change adds a harness-owned ad hoc router and requires
the embedder to supply its provider and resolved model. The router is neither a
conversation sub-agent nor a sandbox step: it is a distinct low-cost `utility`
role. At the same time, the harness removes the ephemeral workflow and
`ResourcePolicy.ephemeral`; the CLI must stop constructing both while retaining
the temporary legacy DBOS-row sweep required during upgrade.

## Goals / Non-Goals

**Goals:**

- Resolve and supply a required utility model through the same connection and
  fallback rules as conversation and sandbox.
- Give utility the same independent live-switch and visibility behavior as the
  existing roles.
- Reuse provider inners when any subset of the three resolved ids coincide.
- Remove obsolete ephemeral resource/workflow composition.
- Preserve safe upgrade handling for pending legacy ephemeral rows.

**Non-Goals:**

- Owning ad hoc routing policy or agent selection in the CLI.
- Adding a second model connection, provider, endpoint, or credential source.
- Adding utility-specific resource, timeout, or execution settings.
- Changing which internal analysis consumers follow sandbox.
- Removing the legacy ephemeral sweep in the same release that removes the
  workflow.

## Decisions

### 1. `utility` is a first-class `AgentName`

`modelsConfigSchema.agents` gains optional `utility`, and `AGENT_NAMES` becomes
`["conversation", "sandbox", "utility"]`. Optional means the config key itself
is not mandatory; the resolved value is. Resolution remains:

`models.agents.<role> → harness.model → connection default`.

Thus direct mode reports every unresolved role in one `model_required` error,
while cliproxy mode can elect one default for all absent overrides. This is
exactly the existing meaning of "required like conversation and sandbox."

The utility role serves only the harness ad hoc router. Conversation sub-agents
remain on conversation, and synthesis/profile/step interpretation remain on
sandbox.

Alternative considered: make utility follow sandbox implicitly. This would
prevent intentionally choosing a cheaper routing model and would contradict the
requested tier boundary.

### 2. Provider inners are interned by resolved model id

Boot resolves all three ids, builds one inner `ChatProvider` per distinct id,
then creates one stable swappable handle per role. An inner map replaces the
current two-way equality branch, avoiding order-dependent cases when two or all
three roles coincide.

Each handle remains independent even when its current inner is shared, so
switching utility cannot repoint conversation or sandbox. The agent-switch
controller generalizes its maps and loops over `AGENT_NAMES`; sandbox provenance
emitter reconstruction remains conditional on switching sandbox only.

Alternative considered: one handle per distinct model. This would couple roles
after boot—a switch of one role would unexpectedly switch every role that
started on the same model.

### 3. Utility switching uses the existing global idle boundary

The palette adds `Switch utility model`, using the same listing, manual-entry,
credential resolution, accessibility validation, persistence, and
apply-or-schedule path. The current global in-flight tracker remains the safety
gate. Because routing occurs inside a tracked chat turn, a utility switch cannot
land during its bounded call; an analysis/profile/chat already in flight also
defers it under the existing conservative policy.

Status state becomes a three-role record and the sidebar/palette labels render
utility's active and pending ids. No new busy-state kind is necessary.

Alternative considered: maintain per-role busy counters. That would allow more
switch concurrency but changes the established guarantee that no agent work
observes a mid-flight configuration transition.

### 4. CLI composition supplies utility but does not interpret it

`RunEngineComposition`/conversation assembly gains a utility backend or direct
utility provider/model fields as required by the new harness types. The CLI
passes the stable utility handle and resolved id to `assembleCoreRuntime`; the
harness decides when and how the router uses them. The CLI never supplies an
agent id or routing prompt.

This follows the repository boundary rule: the harness owns capabilities and
behavior, the embedder supplies values at its composition root.

### 5. Ephemeral execution is removed; its row sweep is migration-only

The CLI deletes:

- `harness.resourceLimits.ephemeral` parsing and `ResourcePolicy` projection;
- the ephemeral dependency builder and `CoreWorkflowDeps.ephemeral` wiring;
- comments/tests that treat ephemeral as a live model consumer or workflow.

The pre-launch `sweepEphemeralWorkflows` call remains before DBOS launch for the
supported upgrade window. It is labeled as a legacy migration, not registered
workflow behavior. A later change removes it after deployments can no longer
carry pending rows from the old binary.

Rollback requires draining/cancelling workflows created by the coordinated new
harness version and restoring the previous CLI/harness pair plus its expected
configuration.

## Risks / Trade-offs

- **Three-role state exposes hard-coded two-role assumptions.** → Make
  `AGENT_NAMES` the iteration source and add exhaustive type/tests across config,
  switching, status, commands, and rendering.
- **A shared inner provider could accidentally couple handles.** → Intern only
  the inner, always create a distinct swappable handle per role, and test
  one-role switches when all roles start equal.
- **Utility switching during routing could change attribution mid-call.** → Keep
  the existing global idle gate; the router runs inside tracked chat work.
- **Removing ephemeral registration can strand old DBOS rows.** → Retain and
  order the executor-scoped pre-launch migration sweep before recovery.
- **Old config may still contain `resourceLimits.ephemeral`.** → Stop projecting
  it into the harness policy; tolerate the stale key during the upgrade window
  and document that it has no effect.

## Migration Plan

1. Extend config/model resolution and generalized provider interning to utility.
2. Extend swappable state, switching, palette commands, status, and sidebar.
3. Pass the utility backend through composition to the coordinated harness API.
4. Remove ephemeral resource/dependency construction and its tests/references.
5. Keep the legacy row sweep until a later compatibility cleanup.

Roll back only after draining/cancelling workflows started by the new
CLI/harness pair, then deploy the previous pair together.

## Open Questions

None.
