## MODIFIED Requirements

### Requirement: Local realizations for every conversation dependency

The composition SHALL realize the conversation agent's dependency surface from
deliberate local wiring, reusing the existing realizations where the seams are shared
(pool, embedding provider, workspace filesystem, session-tree base, bio keys, run
authorizer, run launcher) — the chat provider and model id are the CONVERSATION
agent's (see `agent-model-selection`): the provider instance bound to the conversation agent's resolved model over the shared connection, serving the chat agent and its
sub-agents. Specific to the conversation
surface:

- `skillsDir` and `templatesDir` SHALL each be a config-overridable path that, absent an
  override, resolves to the extracted content directory
  (`join(env.contentDir, <contentHash>, "skills")` / `.../templates`, materialized by
  `content-assets`) in a **release build**, and to the repository-root `skills/` /
  `templates/` trees in a **development run**; both remain gated at pre-flight, which now
  passes because `content-assets` materializes the tree before the gate.
- `chrome` SHALL be the empty config (no browser URL): with report preview
  unavailable, nothing in the local path reaches Chrome.
- `createPreviewPublisher` SHALL yield the harness's unavailable preview publisher,
  which fails visibly at the point of use (report preview reports its unavailability;
  report submission remains the only gate) — consistent with the rule that no
  dependency is realized as a fake that fabricates success.
- `hostTools` SHALL carry the `run_inflexa` tool (see `agent-cli-tool`) through the
  harness host-tool seam, so the conversation agent can drive the `inflexa` CLI as an
  approval-gated subprocess. The harness stays agnostic to the tool; the CLI owns its
  classifier, spawn, and approval-request construction.

#### Scenario: Conversation deps resolve to their designated backends

- **WHEN** the runtime composes the conversation agent
- **THEN** chat traffic targets the resolved model connection under the conversation agent's model (the local proxy in `cliproxy` mode, the configured endpoint in `direct` mode), threads and working memory live in the local Postgres, and templates resolve from the configured directory or, absent an override, the extracted content directory in a release build (the repo-root `templates/` tree in a development run)

#### Scenario: Report preview degrades visibly, report building does not

- **WHEN** the agent attempts a report preview snapshot in a local chat
- **THEN** the preview tool reports preview unavailability (no Chrome is contacted) and report iteration/submission still works

#### Scenario: The conversation agent carries the inflexa CLI host tool

- **WHEN** the runtime composes the conversation agent
- **THEN** the `run_inflexa` host tool is present in the agent's tools via the harness `hostTools` seam
