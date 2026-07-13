# planning-enhancements Specification (delta)

## MODIFIED Requirements

### Requirement: Plan generation runs as an internal planner sub-agent loop

The conversation agent SHALL generate plans by calling the `generate_plan` tool,
which SHALL drive an internal `planner` `AgentDefinition` via `runToTerminal`
(wrapping `runAgent`) under a child session derived with
`forSubAgent(ctx.session, "planner")`. The tool SHALL accept
`{ researchQuestion, userConstraints?, parentPlanId? }` — it SHALL NOT accept
`dataContext` or `priorRuns` parameters; that context is composed by the tool
itself as briefing initial messages from harness-owned state (per the
conversation-briefings capability), with the research question and user
constraints forming the loop's user message. The planner SHALL communicate its
result only through terminal tool calls; its text reply SHALL be discarded.

#### Scenario: Conversation agent invokes generate_plan

- **WHEN** the conversation agent needs an analysis plan
- **THEN** it calls `generate_plan` with `{ researchQuestion, userConstraints?, parentPlanId? }`
- **AND** the tool composes the data-profile, prior-runs, and (when iterating) prior-plan briefings from harness state as the planner loop's initial messages
- **AND** the tool runs the planner sub-agent via `runToTerminal` under a `forSubAgent` child session

#### Scenario: Planner outcome read from a closure cell

- **WHEN** the planner finishes its loop
- **THEN** the tool reads the recorded outcome from the shared closure cell, not from the planner's text reply
