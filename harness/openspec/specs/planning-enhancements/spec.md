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

The planner has four inner tools: `validate_plan` (a non-terminal Zod + semantic
dry-run) and three terminal tools — `submit_plan` (re-validate and persist),
`request_clarification`, and `report_blocker` (the planner's honest "no viable
plan" exit). Exactly one terminal outcome is recorded per invocation. The whole
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

### Requirement: The planner exposes one non-terminal validator and three terminal tools

The planner SHALL be given `validate_plan` (a non-terminal Zod + semantic dry-run
returning `{ valid, issues }`) plus the terminal tools `submit_plan`,
`request_clarification`, and `report_blocker`. `submit_plan` SHALL re-validate
and persist the plan. Exactly one terminal outcome SHALL be recorded per
invocation; any later terminal call SHALL be rejected.

#### Scenario: validate_plan is non-terminal

- **WHEN** the planner calls `validate_plan` with a candidate plan
- **THEN** it returns `{ valid, issues }` and records no outcome
- **AND** the planner may call it any number of times

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
