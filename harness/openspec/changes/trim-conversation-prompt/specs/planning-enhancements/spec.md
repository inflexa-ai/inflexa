# Spec Delta

## ADDED Requirements

### Requirement: generate_plan shows the card of the plan that it makes

When the planner of `generate_plan` ends with an accepted plan, the tool MUST emit one `data-plan` part for that plan, with the provenance of the caller. It MUST build the card from the result of the planner, with no read of the plan store, thus a replay gives the same card under the same id. Any other outcome MUST emit no plan card.

#### Scenario: A completed plan shows its card

- **WHEN** `generate_plan` ends with `plan_complete` for the plan `pln-1a2b3c4d`
- **THEN** the call emits one `data-plan` part whose `planId` is `pln-1a2b3c4d`
- **AND** the part carries the provenance of the conversation agent

#### Scenario: A blocker shows no card

- **WHEN** the planner reports a blocker
- **THEN** `generate_plan` emits no `data-plan` part

### Requirement: show_plan shows an earlier plan again

The conversation prompt and the description of `show_plan` MUST NOT tell the agent to show a new plan with `show_plan`, because `generate_plan` shows it. `show_plan` shows a stored plan again.

#### Scenario: The prompt has no show step after a new plan

- **WHEN** the conversation prompt and the `show_plan` description are read
- **THEN** neither tells the agent to call `show_plan` for the plan that `generate_plan` just made
