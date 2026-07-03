## ADDED Requirements

### Requirement: Plan intake is a temporary dev surface with a clearing contract

The plan-intake module and the cli-side replicated trigger flow it feeds SHALL each
carry a `TODO(extend)` comment block stating the clearing contract and naming what
replaces them. Plan intake — loading an analysis plan from a user-supplied JSON file
— exists ONLY to exercise the run engine before plan authoring lands with the
conversation-agent/planner adoption (the harness's `generatePlan` tool is the
product path); the marker blocks exist so
the surface is discoverable and removable when the planner arrives. This requirement
itself records the same contract at spec level: when plan authoring is adopted, this
capability is expected to be REMOVED (file intake retired or demoted to an explicit
debug tool), not silently grown into a product feature.

#### Scenario: The temporary surface is marked in code

- **WHEN** the plan-intake module and the run trigger flow are inspected
- **THEN** each carries a `TODO(extend)` block naming conversation-agent/planner adoption as the replacement and this capability as the spec-level record to clear

### Requirement: Plan files are validated exactly as the harness's own trigger validates plans

The system SHALL parse the plan file as JSON, validate it against the harness's
`AnalysisPlanSchema`, and then apply the harness's `validatePlan` structural checks
(dependency DAG topological validity, output-prefix uniqueness, agent ids known to
the sandbox catalog, resources present on every step, reserved step-id names
rejected). A plan failing any gate SHALL be rejected before any side effect — no
plan row, no run row, no staging — with the validation errors presented verbatim.

#### Scenario: Valid plan passes intake

- **WHEN** the file parses, schema-validates, and passes structural validation
- **THEN** intake proceeds to identity derivation and persistence

#### Scenario: Structurally invalid plan is rejected with the harness's errors

- **WHEN** the plan has a dependency cycle, an unknown agent id, or a step without resources
- **THEN** the command exits with the `validatePlan` error list and nothing was persisted or launched

#### Scenario: Malformed file is rejected early

- **WHEN** the file is unreadable or not valid JSON for the plan schema
- **THEN** the command exits with a parse/schema error naming the file, and nothing was persisted or launched

### Requirement: Plan identity is deterministic over analysis and content

The plan id SHALL be derived, not minted: `pln-` followed by the first 8 lowercase
hex characters of a SHA-256 over the analysis id and the plan file bytes, satisfying
the harness's `pln-<8hex>` contract. The same file for the same analysis SHALL yield
the same id on every invocation; a changed file or a different analysis SHALL yield
a different id. Determinism is load-bearing: run dedup is keyed on
`(analysisId, planId)`, so a stable id makes re-running the command idempotent
against an in-flight run instead of double-launching.

#### Scenario: Re-running the same plan file dedups

- **WHEN** the command runs twice with an unchanged plan file while the first run is still active
- **THEN** both invocations resolve to the same plan id and the second attaches to the existing run rather than launching a new one

#### Scenario: Edited plan is a new plan

- **WHEN** the plan file's bytes change between invocations
- **THEN** the derived id differs and the second invocation launches a new run

### Requirement: Plans persist through the harness state layer

The validated plan SHALL be persisted into the harness's plan store via an additive
harness state function that accepts the caller-derived id and inserts-if-absent
(re-running with the same id is a no-op, never an error or a duplicate). The cli
SHALL NOT issue raw SQL against harness-owned tables.

#### Scenario: First intake persists the plan

- **WHEN** a valid plan with a previously unseen id is taken in
- **THEN** a plan row exists in the harness plan store under the derived id, scoped to the analysis

#### Scenario: Repeat intake is a no-op

- **WHEN** the same plan id is taken in again
- **THEN** the store still holds exactly one row for the id and intake reports success
