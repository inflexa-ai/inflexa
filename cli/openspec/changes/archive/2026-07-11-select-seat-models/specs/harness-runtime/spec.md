## MODIFIED Requirements

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
deliberate local wiring, reusing the existing realizations where the seams are shared
(pool, embedding provider, workspace filesystem, session-tree base, bio keys, run
authorizer, run launcher) — the chat provider and model id are the CONVERSATION
agent's (see `agent-model-selection`): the provider instance bound to the conversation agent's resolved model over the shared connection, serving the chat agent and its
sub-agents. Specific to the conversation
surface:

- `templatesDir` SHALL resolve like `skillsDir` does: a config-overridable path
  defaulting to the repository root's `templates/` directory, gated at pre-flight.
- `chrome` SHALL be the empty config (no browser URL): with report preview
  unavailable, nothing in the local path reaches Chrome.
- `createPreviewPublisher` SHALL yield the harness's unavailable preview publisher,
  which fails visibly at the point of use (report preview reports its unavailability;
  report submission remains the only gate) — consistent with the rule that no
  dependency is realized as a fake that fabricates success.

#### Scenario: Conversation deps resolve to their designated backends

- **WHEN** the runtime composes the conversation agent
- **THEN** chat traffic targets the resolved model connection under the conversation agent's model (the local proxy in `cliproxy` mode, the configured endpoint in `direct` mode), threads and working memory live in the local Postgres, and templates resolve from the configured (or default root) templates directory

#### Scenario: Report preview degrades visibly, report building does not

- **WHEN** the agent attempts a report preview snapshot in a local chat
- **THEN** the preview tool reports preview unavailability (no Chrome is contacted) and report iteration/submission still works
