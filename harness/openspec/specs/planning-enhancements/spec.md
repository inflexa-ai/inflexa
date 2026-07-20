# planning-enhancements Specification

## Purpose

Analysis plans are produced by the `generate_plan` tool
(`src/tools/research/generate-plan.ts`), which the conversation agent calls with
structured context. The tool does not make a single structured `ChatProvider.chat`
call — it drives an internal `planner` sub-agent (`AgentDefinition`, id
`"planner"`) through `runToTerminal` (the terminal-salvage wrapper around
`runAgent`). The planner communicates results EXCLUSIVELY through tool calls; its
text reply is discarded, and the outcome is read from a closure cell that the
terminal tools write.

The planner's inner tools divide by whether they end the loop. The terminal set
is `submit_plan` (re-validate and persist), `request_clarification`, and
`report_blocker` (the planner's honest "no viable plan" exit); everything else is
non-terminal and may be called freely — `validate_plan` (a Zod + semantic
dry-run) and `list_available_refs` (reference-store discovery, so a step is only
committed to reference data the environment actually holds). That split, not the
size of either set, is the invariant: a plan reaches the caller through exactly
one terminal call, and non-terminal tools record no outcome. The whole
invocation is bounded by a single 600s wall-clock guard merged with the caller's
abort signal; the planner loop is iteration-capped at 13. There is no per-attempt
timeout, no internal retry counter, and no `adaptive` thinking or `budget_tokens`
anywhere in the planning path.

## Requirements

### Requirement: Plan generation runs as an internal planner sub-agent loop

The conversation agent SHALL generate plans by calling the `generate_plan` tool,
which SHALL drive an internal `planner` `AgentDefinition` via `runToTerminal`
(wrapping `runAgent`) under a child session derived with
`forSubAgent(ctx.session, "planner")`. The planner SHALL communicate its result
only through terminal tool calls; its text reply SHALL be discarded.

#### Scenario: Conversation agent invokes generate_plan

- **WHEN** the conversation agent needs an analysis plan
- **THEN** it calls `generate_plan` with `{ dataContext, researchQuestion, priorRuns?, userConstraints?, parentPlanId? }`
- **AND** the tool runs the planner sub-agent via `runToTerminal` under a `forSubAgent` child session

#### Scenario: Planner outcome read from a closure cell

- **WHEN** the planner finishes its loop
- **THEN** the tool reads the recorded outcome from the shared closure cell, not from the planner's text reply

### Requirement: The planner separates non-terminal tools from a terminal outcome set

The planner SHALL be given the terminal tools `submit_plan`,
`request_clarification`, and `report_blocker`, and SHALL additionally be given
non-terminal tools including `validate_plan` (a Zod + semantic dry-run returning
`{ valid, issues }`) and `list_available_refs` (reference-store discovery).
`submit_plan` SHALL re-validate and persist the plan. Exactly one terminal
outcome SHALL be recorded per invocation; any later terminal call SHALL be
rejected. Non-terminal tools SHALL record no outcome and SHALL be callable any
number of times, so adding one does not change the planner's exit contract.

#### Scenario: Non-terminal tools record no outcome

- **WHEN** the planner calls `validate_plan` with a candidate plan
- **THEN** it returns `{ valid, issues }` and records no outcome
- **AND** the planner may call it any number of times

#### Scenario: The planner can see what reference data is staged

- **WHEN** the planner calls `list_available_refs`
- **THEN** it receives the current reference inventory and records no outcome
- **AND** the planner may ground a step's reference needs in that result, or take a terminal `request_clarification` exit when data the analysis cannot proceed without is absent

#### Scenario: submit_plan re-validates and persists

- **WHEN** the planner calls `submit_plan` with a plan that passes validation
- **THEN** the plan is persisted and the outcome is recorded as a submitted plan with its `planId`

#### Scenario: A second terminal call is rejected

- **WHEN** a terminal outcome has already been recorded and `submit_plan` is called again
- **THEN** the call is rejected and the recorded outcome is left unchanged

### Requirement: A single wall-clock guard bounds the whole invocation

The tool SHALL bound the entire invocation with a single 600s
(`PLAN_TIMEOUT_MS = 600_000`) wall-clock guard, merged with the caller's abort
signal via `AbortSignal.any`. There SHALL be no per-attempt timeout and no
internal retry counter.

#### Scenario: Invocation times out

- **WHEN** plan generation exceeds the 600s wall-clock guard
- **THEN** the planner is aborted and the tool returns an `error` event indicating a timeout

#### Scenario: Caller abort cancels the planner

- **WHEN** the caller's abort signal fires
- **THEN** the planner is cancelled and the tool returns an `error` event indicating cancellation

### Requirement: The planner loop is iteration-capped with one salvage continuation

The planner loop SHALL be capped at `PLANNER_MAX_ITERATIONS = 13`. If the planner
ends without a terminal outcome, `runToTerminal` SHALL grant exactly one salvage
continuation whose only tools are the terminal tools, opened by a corrective
nudge.

#### Scenario: Salvage continuation on a missing terminal outcome

- **WHEN** the planner reaches its iteration cap without recording a terminal outcome
- **THEN** `runToTerminal` runs one salvage continuation offering only `submit_plan`, `request_clarification`, and `report_blocker`

#### Scenario: Still no outcome after salvage

- **WHEN** the salvage continuation also ends without a terminal outcome
- **THEN** the tool returns an `error` event stating the planner produced no terminal outcome

### Requirement: The tool returns a typed outcome and never throws

The tool SHALL translate the recorded outcome into a `PlanningAgentOutput` whose
`event` is one of `"plan_complete"`, `"clarification_needed"`, or `"error"`, and
SHALL return it as a data result (`ok(...)`) in every case — it SHALL NOT throw.

#### Scenario: Successful plan

- **WHEN** the planner submits a valid plan
- **THEN** the output is `{ event: "plan_complete", planId, plan }`

#### Scenario: Clarification needed

- **WHEN** the planner calls `request_clarification`
- **THEN** the output is `{ event: "clarification_needed", question, questionContext? }`

#### Scenario: Blocker or failure

- **WHEN** the planner calls `report_blocker`, or persistence fails, or the invocation times out or is cancelled
- **THEN** the output is an `{ event: "error", error }` data result and no exception is thrown

### Requirement: The agent catalog is injected into the planner prompt

The planner system prompt SHALL be built by `plannerPrompt(formatAgentCatalog())`,
substituting the rendered `PLANNABLE_AGENT_CATALOG` for the prompt's
`{{AGENT_CATALOG}}` placeholder, so the planner can only route to plannable
agents.

#### Scenario: Planner prompt carries the rendered catalog

- **WHEN** the planner system prompt is assembled
- **THEN** its `{{AGENT_CATALOG}}` placeholder is replaced with the markdown rendered from `PLANNABLE_AGENT_CATALOG`

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
