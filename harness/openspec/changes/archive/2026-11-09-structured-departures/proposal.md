# Proposal

## Why

In the run of analysis GSE136961, the planner wrote each departure from a rule into the free text of `grounding.reason`. The reason of T1S1 said "PCA on all ~390 retained targets". But the settings and the template binding kept the value of the rule, `n_top_genes_pca` = 500. The template capped the value at the 364 rows, thus the result was correct by chance. The grounding of T1S2 kept the GC and length settings of R-0147, and the plan did not do that diagnostic.

The host binds the settings, and it cannot read a departure from the free text. Thus the binding, the decision record, and the methods of the step showed the value of the rule.

## What Changes

- The grounding of a plan step gets an optional `departures` list. Each entry has the claim id of the rule, the setting, the value of the plan, and the reason. An entry with no setting leaves out a part of the rule that no setting carries. An entry with a setting and no value does not apply the setting.
- `validatePlan` refuses a departure in these conditions:
  - the step does not cite its rule
  - the step does not hold its setting
  - it has a value and no setting
  - a second departure names the same setting.
- `submit_plan` gives a departure the claim id of the step when it names a rule id of exactly one claim of the step.
- The binding of the template contract applies each departure before the intersection. A setting with a departure value binds that value, with the source `departure from <claim id>`. A setting that a departure does not apply does not bind.
- A template gives each slot a value. Thus a slot that a departure does not apply is excluded, and `knowledge_template` refuses a render until the model sends its value with an override.
- The decision record keeps the departures as `departures`.
- The methods of the step, the `data-step-methods` part, and the Grounding section of the briefing list the departures. The handoff of a dependency lists them too.
- The description of `knowledge_recommend` tells the planner to give a departure in `grounding.departures`.
- The grounding of a step of the `data-plan` part keeps the departures, thus the plan card can show them before the approval.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the grounding carries the departures, and the binding and the decision record use them.
- `step-interpretation-summary`: the methods of a step list the departures.
- `plan-reads`: the `data-plan` part keeps the departures of each step.

## Impact

- `src/schemas/workflow-state.ts`, `src/schemas/validate-plan.ts`, and `src/tools/research/generate-plan.ts` change.
- `src/workflows/execute-analysis.ts` and `src/tools/knowledge/template.ts` change.
- `src/execution/step-methods.ts`, `src/prompts/briefing.ts`, and the `StepMethods` contract change. `StepMethods` gets the optional `departures` and `departuresOmitted` fields.
- The `PlanStepGrounding` contract and the `data-plan` part schema get the optional `departures` field.
- The description of `knowledge_recommend` changes, thus `knowledgeToolDefinitionHash` changes.
- A stored plan with no departures does not change.
