# analysis-run-launch Delta

## MODIFIED Requirements

### Requirement: Launching an analysis run is a deliberate action

The system SHALL provide a dedicated command that launches a full `executeAnalysis`
run for a resolved analysis from a validated plan. The command SHALL sequence:
resolve the analysis reference → pre-flight prerequisite checks (the same actionable
gates as the profile launch: sandbox image, embedding endpoint, skills dir, proxy
key, model, Postgres — plus the analysis workspace root resolving to a writable
location) → validate the plan file (the pure parse/schema/`validatePlan`
gates, which persist nothing) → boot the embedded runtime → stage the analysis's
inputs into the analysis workspace (`{workspaceRoot}/data`, mirror reconciliation;
the run engine never downloads)
→ seed the harness analysis ledger row → persist the validated plan under its
deterministic id → trigger. Plan validation SHALL precede the boot so a malformed or
invalid plan is rejected before any side effect (no boot, no staging, no ledger row),
per the plan-intake spec; only the deterministic-id persistence needs the booted
pool. No passive flow (bare `inflexa` launch, TUI startup) SHALL stage, boot, or
trigger. An analysis with no resolvable inputs SHALL short-circuit before boot with
an actionable message, and an unresolvable or non-writable workspace root SHALL
short-circuit the same way — there is no fallback location.

#### Scenario: Full launch sequence on a prepared analysis

- **WHEN** the command runs for an analysis with resolvable inputs, a valid plan file, and satisfied prerequisites
- **THEN** inputs are staged under the analysis workspace, the plan is persisted, and an `executeAnalysis` workflow is launched whose run row exists in the harness ledger

#### Scenario: Failed prerequisite is reported before side effects

- **WHEN** a prerequisite (e.g. sandbox image missing, embeddings endpoint unreachable) fails pre-flight
- **THEN** the command exits with that prerequisite's actionable message and neither staging, plan persistence, nor a run row was produced

#### Scenario: Invalid plan is rejected before boot

- **WHEN** the plan file is unreadable, not valid JSON, fails the plan schema, or fails `validatePlan` (cycle, unknown agent, missing resources, zero steps)
- **THEN** the command exits with the plan's actionable error before the runtime is booted — the runtime is never started, nothing is staged, and no ledger or plan row is written

#### Scenario: Non-writable workspace blocks the launch before side effects

- **WHEN** the analysis's workspace root cannot be resolved or is not writable
- **THEN** the command exits with the workspace's actionable message before boot, staging, or any ledger write

#### Scenario: Missing completed data profile warns but does not block

- **WHEN** the analysis has no completed data profile in the harness ledger
- **THEN** the command surfaces a warning (agents orient on the profile summary) and proceeds with the launch
