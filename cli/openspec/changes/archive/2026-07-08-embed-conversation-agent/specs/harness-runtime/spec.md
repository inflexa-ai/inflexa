# harness-runtime Specification (delta)

## MODIFIED Requirements

### Requirement: On-demand composition of the embedded harness runtime

The system SHALL provide a composition module that boots the embedded harness runtime
on first use and reuses it for the remainder of the process (module singleton). Boot
SHALL sequence: ensure Postgres readiness (via the infra module), start the
exec-callback listener, initialize the cortex schema, sweep this executor's pending
ephemeral workflows (a direct pre-launch cancel — launching first would let recovery
re-dispatch sandboxes for chat turns that no longer exist), then register the durable
workflows and build the conversation agent through the harness composition root
(`assembleCoreRuntime`) — which owns the child-before-parent workflow ordering and
registers the sandbox-step, execute-analysis, target-assessment, data-profile, and
ephemeral workflows in one pass — plus the sandbox-hygiene scheduled workflows, then
launch DBOS, so every registration lands in one pre-launch cohort. The
target-assessment workflow is registered deliberately untriggerable: no cli surface
launches it, which is harmless (never launched → never recovered) and recorded here so
it is not mistaken for dead wiring. The booted runtime handle SHALL expose the
assembled conversation agent. Passive flows (bare `inflexa` launch, TUI startup) SHALL
NOT boot the runtime. A second boot request SHALL return the existing runtime without
re-registering or re-launching.

#### Scenario: First trigger boots the runtime

- **WHEN** a data-profile, analysis-run, or chat launch is requested and the runtime has not been booted
- **THEN** Postgres readiness is ensured, the callback listener starts, the ephemeral sweep runs, all workflows register through the composition root (sandbox-step before execute-analysis), and DBOS launches — in that order

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second launch is requested in the same process
- **THEN** no re-registration or re-launch occurs and the existing runtime serves the trigger

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** the runtime boot cannot reach a ready Postgres
- **THEN** boot fails with the infra module's actionable error (e.g. pointing at setup) and DBOS is not launched

#### Scenario: One registration cohort

- **WHEN** the runtime boots and DBOS recovery resumes an in-flight workflow of any registered kind (profile, run parent, run child, ephemeral)
- **THEN** the workflow is found by its registered name — no workflow the cli can trigger is registered after launch

#### Scenario: Stale ephemeral work is swept, not re-dispatched

- **WHEN** a prior process died leaving a pending ephemeral workflow row and a new boot occurs
- **THEN** the sweep cancels the row before DBOS launch and recovery does not start a sandbox for it

### Requirement: The embedding imports through the harness barrel

Cli code SHALL import harness symbols only from the `@inflexa-ai/harness` barrel. The
barrel SHALL be extended (additive exports only) with the embedder runtime surface the
cli consumes: DBOS lifecycle (`launchDbos`, `shutdownDbos`, `DbosConfig`),
data-profile registration and trigger (with their dep/param/result types),
`StagedInput`, the sandbox client factory and its config types, the workspace
filesystem factory, the exec-callback envelope helpers (`workflowIdFromExec`,
envelope/done-marker types), the run-engine surface: sandbox-step and
execute-analysis registration (with dep/input/result and agent-build context types),
the sandbox agent catalog factory, plan schema and validation (`AnalysisPlanSchema`,
`validatePlan`, `renderStepPrompt`), plan persistence (`upsertPlan`, `loadPlan`), run
state (insert/query/update run rows, step-execution queries, the dedup-collision
error), the run launcher, and the scheduled-workflow registration functions — and the
conversation surface: the composition root and its dep types
(`assembleCoreRuntime`, the `CoreRuntimeDeps` family), the chat-turn preparation and
persistence functions with their types (`prepareChatTurn`, the thread store/history
factories, `StoredMessage`), the history display readers
(`contentToCortexMessages`, `createCardResolver`), the pass-through run step, the
ephemeral pre-launch sweep (`sweepEphemeralWorkflows`), the unavailable preview
publisher, and the `contracts/` chat-event and chat-part types.

#### Scenario: No deep imports in cli code

- **WHEN** the cli's harness-facing modules are inspected
- **THEN** every harness import resolves from the package barrel, none from deep subpaths

## ADDED Requirements

### Requirement: Local realizations for every conversation dependency

The composition SHALL realize the conversation agent's dependency surface from
deliberate local wiring, reusing the existing realizations where the seams are shared
(pool, chat provider, embedding provider, workspace filesystem, session-tree base,
model id, bio keys, run authorizer, run launcher). Specific to the conversation
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
- **THEN** chat traffic targets the local proxy, threads and working memory live in the local Postgres, and templates resolve from the configured (or default root) templates directory

#### Scenario: Report preview degrades visibly, report building does not

- **WHEN** the agent attempts a report preview snapshot in a local chat
- **THEN** the preview tool reports preview unavailability (no Chrome is contacted) and report iteration/submission still works
