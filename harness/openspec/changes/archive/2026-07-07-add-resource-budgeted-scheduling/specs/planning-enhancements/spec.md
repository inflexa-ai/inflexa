# planning-enhancements — delta

## ADDED Requirements

### Requirement: The planner prompt carries the host resource limits

The planner system prompt's Resource Estimation guidance SHALL, when a resource
policy is supplied, be built with the concrete per-step ceilings
(`perStep.maxCpu`, `perStep.maxMemoryGb`) and the machine budget substituted
into the prompt (same injection mechanism as `{{AGENT_CATALOG}}`). The guidance
SHALL instruct the planner that no step may declare resources above the
per-step ceiling, and that concurrent steps share the machine budget so heavy
steps are better serialized via `depends_on` than fanned out. When no policy is
supplied, the existing default guidance (4 CPU / 8 GB) SHALL be used unchanged.

#### Scenario: Planner prompt carries the concrete ceilings

- **GIVEN** a policy with `perStep: { maxCpu: 4, maxMemoryGb: 8 }` and `budget: { cpu: 8, memoryGb: 16 }`
- **WHEN** the planner system prompt is assembled
- **THEN** the Resource Estimation section states the 4 CPU / 8 GB per-step ceiling and the 8 CPU / 16 GB machine budget

#### Scenario: No policy preserves the default guidance

- **GIVEN** no resource policy at the composition root
- **WHEN** the planner system prompt is assembled
- **THEN** the Resource Estimation section carries the existing default guidance

### Requirement: validate_plan enforces the per-step resource ceiling

`validate_plan` (and `submit_plan`'s re-validation) SHALL, when a resource
policy is supplied, report an issue for every step whose declared `resources`
exceed `perStep.maxCpu` or `perStep.maxMemoryGb`. The issue SHALL name the step,
its declared values, and the ceiling, so the planner can resize or restructure.
The check is deterministic validation feedback, not a terminal outcome — the
run-time clamp at sandbox creation is unchanged and remains the backstop for
plans that predate this validation.

#### Scenario: An over-ceiling step is reported with actionable feedback

- **GIVEN** a per-step ceiling of `{ maxCpu: 4, maxMemoryGb: 8 }` and a candidate plan step declaring `{ cpu: 4, memoryGb: 16 }`
- **WHEN** the planner calls `validate_plan`
- **THEN** the result is invalid with an issue naming the step, the declared 16 GB, and the 8 GB ceiling

#### Scenario: submit_plan rejects an over-ceiling plan

- **GIVEN** a plan containing an over-ceiling step
- **WHEN** the planner calls `submit_plan`
- **THEN** re-validation fails, no plan is persisted, and no terminal outcome is recorded

#### Scenario: A plan within the ceiling passes

- **GIVEN** every step declares resources at or under the per-step ceiling
- **WHEN** the planner calls `validate_plan`
- **THEN** no resource-ceiling issue is reported

### Requirement: Resource-infeasible analyses exit via report_blocker

The planner prompt SHALL instruct the planner that an analysis that genuinely
cannot be performed within the stated resource limits — no restructuring or
downsizing yields a viable plan — MUST exit via the existing `report_blocker`
terminal tool with the resource shortfall as the reason. No new terminal tool or
outcome variant SHALL be introduced; the existing `error` outcome carries the
infeasibility to the conversation agent.

#### Scenario: An analysis that cannot fit is honestly refused

- **GIVEN** an analysis whose smallest viable step requires more memory than the per-step ceiling allows
- **WHEN** the planner concludes no viable plan exists within the limits
- **THEN** it calls `report_blocker` with a reason naming the resource shortfall, and the tool returns the `error` outcome to the conversation agent
