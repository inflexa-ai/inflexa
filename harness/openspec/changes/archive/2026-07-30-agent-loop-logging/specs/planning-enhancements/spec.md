## ADDED Requirements

### Requirement: Validation rejections are recorded

A rejecting `submit_plan` SHALL record each rejection at `debug` through the tool's `Logger`,
carrying the issue count and the issues themselves.

A rejection is the direct evidence of why plan generation is struggling, and it is otherwise
unrecoverable: the issue list is handed to the model and then discarded. Since the planner's tool
surface is the terminal set alone, a rejected submit is the only validation feedback it ever
receives, and each one costs a real iteration out of a bounded budget. A planner that exhausts
that budget is otherwise indistinguishable from one that never tried.

The issues are already structured (`path`, `code`, `message`) and already model-facing, so
recording them exposes nothing the conversation transcript does not hold.

#### Scenario: A rejecting submit records its issues

- **GIVEN** a planner that calls `submit_plan` with a plan that fails re-validation
- **WHEN** the tool returns `{accepted: false, issues}`
- **THEN** a record is written at `debug` carrying the issue count and the issues

#### Scenario: An accepted plan records no rejection

- **GIVEN** a planner whose first `submit_plan` call validates and persists
- **WHEN** the tool returns `{accepted: true, planId}`
- **THEN** no rejection record is written

## MODIFIED Requirements

### Requirement: The tool returns a typed outcome and never throws

The tool SHALL translate the recorded outcome into a `PlanningAgentOutput` whose
`event` is one of `"plan_complete"`, `"clarification_needed"`, or `"error"`, and
SHALL return it as a data result (`ok(...)`) in every case — it SHALL NOT throw.

The tool SHALL also **record** that outcome through an injected `Logger`, exactly once per
invocation, carrying the outcome kind, the elapsed wall-clock of the invocation, and the
`analysisId`. Returning the outcome is not recording it: `generate_plan` is a conversation-layer
tool on `passthroughStep`, so it writes no ledger row and owns no durable stream, and the returned
string is otherwise the entire evidence that the tool ran at all.

The record's level SHALL follow the outcome rather than the return type, which is uniformly
`ok(...)`: a submitted plan and a clarification request are both the tool working as designed and
SHALL be recorded at `info`; a reported blocker SHALL be recorded at `warn`; and an invocation that
produced no plan through failure — the wall-clock guard elapsing, the invocation being cancelled, a
thrown loop error, a persistence failure, or a run that ended with no terminal outcome recorded —
SHALL be recorded at `error`, distinguishing which of those occurred.

The elapsed wall-clock is recorded because it is what separates a planner that gave up early from
one still working when the guard cut it, and the fixed guard makes the number interpretable
without any other context.

#### Scenario: Successful plan

- **WHEN** the planner submits a valid plan
- **THEN** the output is `{ event: "plan_complete", planId, plan }`

#### Scenario: Clarification needed

- **WHEN** the planner calls `request_clarification`
- **THEN** the output is `{ event: "clarification_needed", question, questionContext? }`

#### Scenario: Blocker or failure

- **WHEN** the planner calls `report_blocker`, or persistence fails, or the invocation times out or is cancelled
- **THEN** the output is an `{ event: "error", error }` data result and no exception is thrown

#### Scenario: A successful invocation is recorded once

- **WHEN** the planner submits a valid plan
- **THEN** exactly one outcome record is written at `info`, carrying the outcome kind, the elapsed wall-clock, and the `analysisId`

#### Scenario: Each failure shape is distinguishable in the record

- **GIVEN** an invocation that ends without a terminal outcome, and one whose wall-clock guard elapses
- **WHEN** each is recorded
- **THEN** both are written at `error` and the records distinguish the two causes from each other

#### Scenario: A blocker is recorded as degraded, not failed

- **WHEN** the planner calls `report_blocker`
- **THEN** the outcome record is written at `warn`
