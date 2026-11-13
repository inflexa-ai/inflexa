## MODIFIED Requirements

### Requirement: generate_plan shows the card of the plan that it makes

When the planner of `generate_plan` ends with an accepted plan, the tool MUST emit one `data-plan` part for that plan, with the provenance of the caller. It MUST build the card from the result of the planner, with no read of the plan store, thus a replay gives the same card under the same id. Any other outcome MUST emit no plan card.

The result of the planner MUST also give the full views of the claims of an accepted plan. The card MUST carry these views, thus the live card equals the card of the stored plan. The tool MUST remove the views from the result before the model gets it, because `claims` of `plan_complete` gives their titles. A result that an older version checkpointed has no views, and its card then has no `claims`.

#### Scenario: A completed plan shows its card

- **WHEN** `generate_plan` ends with `plan_complete` for the plan `pln-1a2b3c4d`
- **THEN** the call emits one `data-plan` part whose `planId` is `pln-1a2b3c4d`
- **AND** the part carries the provenance of the conversation agent

#### Scenario: A blocker shows no card

- **WHEN** the planner reports a blocker
- **THEN** `generate_plan` emits no `data-plan` part

#### Scenario: The live card carries the claim views

- **GIVEN** a planner that submits a plan whose step cites `R-0001@e7d0`
- **WHEN** `generate_plan` ends with `plan_complete`
- **THEN** the `data-plan` part holds the view of `R-0001@e7d0`, equal to the view of the card of the stored plan
- **AND** the result that the model gets has no `claimViews` key
