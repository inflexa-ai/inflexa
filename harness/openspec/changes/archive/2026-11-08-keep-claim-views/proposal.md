# Proposal

## Why

A run that uses the knowledge plane shows no rule, no method, and no citation to the user. The planner keeps only the claim ids of the `knowledge_recommend` answer, and it drops the text of each claim. No call of the knowledge client gives the text of a claim id again. Thus no surface after the plan can show a rule by its title, or a citation of its evidence.

## What Changes

- When the planner saves a plan, the host keeps the view of each claim that a step cites. A view holds the claim id, the snapshot digest, the rule, the title, the statement, the strength, the severity, the evidence, and the license.
- The stored plan carries the views in a new optional `claims` field. The planner does not write the field.
- A step takes a view only from an answer with the same snapshot digest. A digest names one fixed release, thus the view of a claim id never changes for its digest.
- The `plan_complete` outcome of `generate_plan` gives the title and the strength of each kept view. Thus the conversation agent can name a rule by its title.
- The knowledge client types the rule, the title, the severity, the license, and the evidence URL of a claim, as optional fields.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the plan keeps the view of each claim that a step cites.
- `planning-enhancements`: the `plan_complete` outcome gives the title of each cited claim.

## Impact

- `src/schemas/workflow-state.ts`, `src/schemas/plan-schemas.ts`, `src/tools/research/generate-plan.ts`, and `src/tools/knowledge/client.ts` change.
- A stored plan without `claims` loads as before.
- The later surfaces (the briefing, the step summary, the report, the synthesis, and the plan card) read the views from the stored plan. They are not part of this change.
