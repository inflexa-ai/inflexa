# plan-intake Specification (delta)

## REMOVED Requirements

### Requirement: Plan intake is a temporary dev surface with a clearing contract

**Reason**: The contract's premise — that file intake exists only because the planner
didn't — turned out wrong (#32; `docs/harness_integration_followup/12-planner-flow.md`
§4). Plan files are a first-class artifact in this domain: protocol replay, a
human-inspectable interchange format, and the model-free way to exercise the run
engine. Deleting or demoting the surface at planner adoption would destroy those.

**Migration**: Replaced by "Plan intake is the protocol replay surface" below, which
inverts the roles (planner = author, file intake = replay) instead of clearing the
capability. The `TODO(extend)` headers in the intake module and the trigger flow are
rewritten in the same change.

## ADDED Requirements

### Requirement: Plan intake is the protocol replay surface

Plan intake — loading an analysis plan from a user-supplied JSON file — SHALL be the
protocol **replay** surface: the conversation-agent planner is the primary plan
author, and hand-authoring a plan file is a supported dev workflow, not the product
path. The intake module and the cli-side replicated trigger flow it feeds SHALL each
carry a comment block stating this standing contract and its remaining evolution:
the replicated trigger's internals are absorbed by the daemon's trigger endpoint
(#33 M2, so chat-executed and file-replayed plans exercise one flow — no harness
extraction is needed for that), and a deliberate `plan export` command (the inverse
of intake, with canonical serialization and source-plan lineage) is a named follow-up
change. Validation and persistence gates are unchanged: intake validates exactly as
the harness's own trigger does and persists through the harness state layer under the
deterministic content-derived id.

#### Scenario: The standing contract is marked in code

- **WHEN** the plan-intake module and the run trigger flow are inspected
- **THEN** each carries a comment block naming intake as the replay surface, the planner as the primary author, #33 M2 as what absorbs the trigger replica, and `plan export` as the named follow-up

#### Scenario: Replay of an unchanged protocol is idempotent

- **WHEN** the same plan file is replayed for the same analysis while a run for it is active
- **THEN** the derived id matches and the invocation attaches to the existing run rather than double-launching
