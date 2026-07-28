## MODIFIED Requirements

### Requirement: The embedding imports through the harness barrel

Cli code SHALL import harness symbols only from the `@inflexa-ai/harness` barrel. The
barrel SHALL expose the embedder runtime surface the cli consumes: DBOS lifecycle
(`launchDbos`, `shutdownDbos`, `DbosConfig`), data-profile registration and trigger
(with their dep/param/result types), `StagedInput`, the sandbox client factory and
its config types, the workspace filesystem factory, the exec-callback envelope
helpers (`workflowIdFromExec`, envelope/done-marker types), the run-engine surface:
sandbox-step, execute-analysis, and run-adhoc registration (with dep/input/result
and agent-build context types), the sandbox agent catalog factory, plan schema and
validation (`AnalysisPlanSchema`, `validatePlan`), plan persistence (`upsertPlan`,
`loadPlan`), run state (insert/query/update run rows, step-execution queries, the
dedup-collision error), the run launcher, and the scheduled-workflow registration
functions; the provider error surface (`ProviderError`, `toProviderError`); and the
conversation surface: the composition root and its dep types
(`assembleCoreRuntime`, the `CoreRuntimeDeps` family), the chat-turn preparation and
persistence functions with their types (`prepareChatTurn`, the thread store/history
factories, `StoredMessage`), the history display readers
(`contentToCortexMessages`, `createCardResolver`), the streaming-chat provider
wrapper (`createStreamingChat`) and `AgentChat`, the pass-through run step
(`passthroughStep`), the unavailable preview publisher, and the `contracts/`
chat-event and chat-part types. The CLI SHALL NOT import or implement the retired
ephemeral pre-launch sweep.

#### Scenario: No deep imports in cli code

- **WHEN** the cli's harness-facing modules are inspected
- **THEN** every harness import resolves from the package barrel, none from deep subpaths

#### Scenario: No ephemeral recovery exception remains

- **WHEN** the CLI prepares to launch DBOS
- **THEN** it does not import, call, or locally recreate `sweepEphemeralWorkflows`, and pending adhoc runs remain eligible for normal recovery

### Requirement: Local realizations for every analysis-run dependency

The composition SHALL realize the sandbox-step, execute-analysis, and run-adhoc dep
bundles from deliberate local wiring, reusing the data-profile realizations where
the seams are shared (pool, sandbox client, workspace filesystem, session-tree
base, bio keys, local run authorizer) — the chat provider and model id are the
SANDBOX agent's (see `agent-model-selection`): the provider instance bound to the
sandbox agent's resolved model over the shared connection, also serving run
synthesis and post-step metadata/summary. Specific to the run engine:

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
- The run-adhoc bundle SHALL supply the local pool and run authorizer while the
  harness composition root supplies the registered sandbox-step callable and the
  shared `ResourcePolicy.adhoc` value.
- No dependency SHALL be realized as a fake that fabricates success.

#### Scenario: Run deps resolve to their designated backends

- **WHEN** the runtime composes the sandbox-step, execute-analysis, and run-adhoc dep bundles
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

#### Scenario: Adhoc policy is supplied with the harness vocabulary

- **WHEN** CLI configuration contains `harness.resourceLimits.adhoc`
- **THEN** the resolved resource policy supplies that value as `ResourcePolicy.adhoc` to the shared harness composition root
