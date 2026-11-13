# Spec Delta

## ADDED Requirements

### Requirement: The plan keeps the view of each cited claim

When the planner saves a plan, the host MUST keep the view of each claim that a step of the plan cites in `grounding.claims`. The host MUST take a view only from the last `knowledge_recommend` answer of the invocation. A step MUST take a view only when its snapshot digest equals the digest of that answer. The stored plan MUST carry the views in the optional `claims` field, one view for each claim id, in the order of the steps. A view MUST carry the claim id, the snapshot digest, the statement, the strength, and the evidence. A view MUST also carry the rule, the title, the severity, and the license when the answer holds them. The planner MUST NOT write the `claims` field. A plan with no cited claim MUST NOT carry the field. A stored plan without the field MUST load as before.

#### Scenario: Two steps cite one claim

- **GIVEN** a recommend answer that holds the view of `R-0001@e7d0`
- **WHEN** the planner submits two steps that cite `R-0001@e7d0`, and one step that cites no claim
- **THEN** the stored plan carries one view of `R-0001@e7d0` with the snapshot digest of the answer, its title, its statement, its evidence, and its license
- **AND** the stored plan carries no view of a claim that no step cites

#### Scenario: No step cites a claim

- **GIVEN** a recommend answer
- **WHEN** the planner submits a plan whose steps cite no claim
- **THEN** the stored plan carries no `claims` field
