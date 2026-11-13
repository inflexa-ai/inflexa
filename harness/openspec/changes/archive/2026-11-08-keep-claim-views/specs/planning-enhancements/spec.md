# Spec Delta

## MODIFIED Requirements

### Requirement: The tool returns a typed outcome and never throws

The tool SHALL translate the recorded outcome into a `PlanningAgentOutput` whose
`event` is one of `"plan_complete"`, `"clarification_needed"`, or `"error"`, and
SHALL return it as a data result (`ok(...)`) in every case — it SHALL NOT throw.

The tool SHALL also **record** that outcome through an injected `Logger`, exactly once per
invocation, carrying the outcome kind, the elapsed wall-clock of the invocation, and the
`analysisId`. Returning the outcome is not recording it: `generate_plan` is a conversation-layer
tool that runs outside a workflow, so it writes no ledger row and owns no durable stream, and the returned
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
- **THEN** the output is `{ event: "plan_complete", planId, plan, claims? }`
- **AND** `claims` gives the id, the title, and the strength of each claim view that the stored plan keeps
- **AND** `claims` is absent when the plan keeps no view

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
