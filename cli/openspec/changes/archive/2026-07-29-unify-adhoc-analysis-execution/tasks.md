## 1. Utility Model Configuration

- [x] 1.1 Add optional `models.agents.utility` to the config schema, `AgentName`, and `AGENT_NAMES`, preserving the existing override → `harness.model` → connection-default resolution chain.
- [x] 1.2 Extend direct-mode prerequisite errors and cliproxy default election tests to resolve all three roles and report every unresolved role together.
- [x] 1.3 Generalize provider construction to intern one inner per distinct resolved model while creating independent swappable handles for conversation, sandbox, and utility.
- [x] 1.4 Add config/read/write/provider-reuse tests for three distinct models, two coincident models, all coincident models, absent overrides, and one-role persistence.

## 2. Live Switching and Visibility

- [x] 2.1 Generalize the agent-switch controller's state/maps/iteration to utility while keeping sandbox provenance-emitter swapping sandbox-only.
- [x] 2.2 Add `Switch utility model` to the Provider palette with the existing listing, manual-entry, auth, accessibility-validation, persistence, and apply-or-schedule flow.
- [x] 2.3 Extend boot/status state, hooks, sidebar, and command labels to show utility's active and pending model.
- [x] 2.4 Add switching tests proving utility applies at idle, defers behind chat/routing/run work, never repoints other role handles, and remains visible while pending.
- [x] 2.5 Replace two-role test fixtures and exhaustive records across TUI/runtime tests with the three-role shape.

## 3. Harness Composition

- [x] 3.1 Carry the resolved utility backend through the CLI runtime composition and inject its stable provider handle plus model id into the coordinated harness conversation/runtime dependencies.
- [x] 3.2 Update runtime boot errors, status snapshots, comments, and tests to attribute utility routing independently while preserving sandbox ownership of synthesis/profile/step-internal consumers.
- [x] 3.3 Update harness package/barrel integration types and compile-time fixtures for the new `CoreRuntimeDeps` contract without introducing deep imports.

## 4. Remove Ephemeral Wiring

- [x] 4.1 Remove `harness.resourceLimits.ephemeral` from CLI policy resolution and stop projecting it into `ResourcePolicy`, with tests that stale config has no runtime effect.
- [x] 4.2 Remove the ephemeral dependency builder, `CoreWorkflowDeps.ephemeral` construction, and runtime/test fixtures for an ephemeral callable.
- [x] 4.3 Update in-flight tracker comments and runtime composition documentation to describe durable ad hoc analysis instead of a turn-scoped ephemeral workflow.
- [x] 4.4 Retain and relabel the executor-scoped pre-launch ephemeral sweep as a legacy upgrade migration, testing its ordering before DBOS launch without workflow registration.

## 5. Verification

- [x] 5.1 Run focused config, runtime, agent-switch, boot hook, command palette, and sidebar tests.
- [ ] 5.2 Run CLI typecheck, lint/format checks, and the subsystem test command required by `cli/CLAUDE.md`.
- [x] 5.3 Boot against the coordinated local harness package and verify three resolved roles, utility routing injection, no ephemeral workflow dependency, and unchanged planned-run launch behavior.
